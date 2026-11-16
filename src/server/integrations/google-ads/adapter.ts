import { addDays, todayInTimeZone } from "@/lib/pacing/dates";
import { IntegrationError } from "../errors";
import type { AccountRef, DetailKind, OAuthTokens, PlatformAdapter, RemoteAccount } from "../types";
import { GoogleAdsClient, type FetchLike } from "./client";
import { googleAdsConfig, type GoogleAdsConfig } from "./config";
import { campaignsQuery, countLocalServicesLeads, filterToScope, CUSTOMER_CLIENT_QUERY, dailyPerformanceQuery, flattenStream, localServicesLeadsQuery, parseCampaigns, parseCustomerClients, parseDailyPerformance, type CampaignRow, type CustomerClientRow, type LocalServicesLeadRow, type PerformanceRow } from "./gaql";
import type { RemoteDailyRow } from "../types";
import { detailQuery, parseDetailRows, type DetailApiRow } from "./details";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

/**
 * Hour (account-local) after which yesterday's numbers are used for pacing.
 * Google Ads statistics for a day keep settling for a few hours after it
 * ends; this is a conservative heuristic, not a documented guarantee, and
 * recent days are re-fetched on every sync anyway.
 */
export const YESTERDAY_COMPLETE_AFTER_HOUR = 3;

function localHour(timeZone: string, now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
}

/**
 * Google Ads adapter. With `localServices: true` it is the Google Local
 * Services Ads adapter: same Google Ads connection and API, but it syncs only
 * LOCAL_SERVICES campaigns plus lead counts from local_services_lead.
 */
export function createGoogleAdsAdapter(opts: { config?: GoogleAdsConfig | null; fetch?: FetchLike; localServices?: boolean } = {}): PlatformAdapter {
  const scope = opts.localServices ? "LOCAL_SERVICES" : "ADS";
  const fetchImpl = opts.fetch ?? fetch;
  const cfg = () => {
    const c = opts.config === undefined ? googleAdsConfig() : opts.config;
    if (!c) throw new IntegrationError("NOT_CONFIGURED", "Google Ads credentials are not configured on the server");
    return c;
  };
  const client = (token: string) => new GoogleAdsClient(cfg(), token, fetchImpl);

  async function tokenRequest(params: Record<string, string>): Promise<OAuthTokens> {
    const exchanging = params.grant_type === "authorization_code";
    let res: Response;
    try {
      res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
    } catch (e) {
      throw new IntegrationError("TRANSIENT", `Network error contacting Google OAuth: ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      if (exchanging && body.error === "invalid_grant") {
        throw new IntegrationError("INVALID_REQUEST", "Google did not accept the sign-in code (it may have expired or been used already). Please connect again.", undefined, res.status);
      }
      if (body.error === "invalid_grant") throw new IntegrationError("AUTH_REVOKED", "Google authorization was revoked or expired. Reconnect the account.", undefined, res.status);
      if (body.error === "invalid_client" || body.error === "unauthorized_client") {
        throw new IntegrationError("NOT_CONFIGURED", `Google rejected the OAuth client (${body.error}). Check GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET.`, undefined, res.status);
      }
      if (res.status >= 500) throw new IntegrationError("TRANSIENT", `Google OAuth error ${res.status}`, undefined, res.status);
      throw new IntegrationError("INVALID_REQUEST", `Google OAuth error: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim(), undefined, res.status);
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : undefined,
      scopes: body.scope,
    };
  }

  return {
    platform: opts.localServices ? "GOOGLE_LSA" : "GOOGLE_ADS",
    connectionPlatform: "GOOGLE_ADS",
    linkablePlatforms: ["GOOGLE_ADS", "GOOGLE_LSA"],
    spendIsVerified: true,
    restatementWindowDays: 14,
    initialBackfillDays: 400,

    isConfigured: () => googleAdsConfig() !== null || !!opts.config,

    authorizationUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: cfg().clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_ADS_SCOPE,
        access_type: "offline", // we need a refresh token for background syncs
        // Always ask which Google login to use (each client may need a different
        // one) and always return a refresh token, even on reconnect.
        prompt: "select_account consent",
        include_granted_scopes: "true",
        state,
      });
      return `${AUTH_URL}?${q.toString()}`;
    },

    exchangeCode: (code, redirectUri) =>
      tokenRequest({ code, client_id: cfg().clientId, client_secret: cfg().clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),

    refresh: (refreshToken) => tokenRequest({ refresh_token: refreshToken, client_id: cfg().clientId, client_secret: cfg().clientSecret, grant_type: "refresh_token" }),

    /**
     * Accessible customers, expanded through every manager's hierarchy. An
     * account reachable both directly and through a manager is listed once,
     * preferring direct access.
     */
    async listAccounts(accessToken) {
      const c = client(accessToken);
      const roots = await c.listAccessibleCustomers();
      const found = new Map<string, RemoteAccount>();
      for (const root of roots) {
        let rows: RemoteAccount[];
        try {
          rows = parseCustomerClients(flattenStream(await c.searchStream<CustomerClientRow>(root, CUSTOMER_CLIENT_QUERY, root)), root);
        } catch (e) {
          // A directly accessible but disabled/cancelled account can refuse queries; skip it.
          if (e instanceof IntegrationError && e.kind === "PERMISSION_DENIED") continue;
          throw e;
        }
        for (const a of rows) {
          const existing = found.get(a.externalId);
          if (!existing || (existing.loginCustomerId && !a.loginCustomerId)) found.set(a.externalId, a);
        }
      }
      return [...found.values()].sort((a, b) => Number(a.isManager) - Number(b.isManager) || a.name.localeCompare(b.name));
    },

    async listCampaigns(accessToken, account: AccountRef) {
      const batches = await client(accessToken).searchStream<CampaignRow>(account.externalId, campaignsQuery(scope), account.loginCustomerId);
      return parseCampaigns(filterToScope(flattenStream(batches), scope));
    },

    async fetchDailyPerformance(accessToken, account, from, to) {
      const c = client(accessToken);
      const batches = await c.searchStream<PerformanceRow>(account.externalId, dailyPerformanceQuery(from, to, scope), account.loginCustomerId);
      const perf = parseDailyPerformance(filterToScope(flattenStream(batches), scope));
      if (!opts.localServices) return perf;

      // Local Services: add lead counts from local_services_lead.
      let leadRows: LocalServicesLeadRow[];
      try {
        leadRows = flattenStream(await c.searchStream<LocalServicesLeadRow>(account.externalId, localServicesLeadsQuery(from, to), account.loginCustomerId));
      } catch (e) {
        // If date filtering on creation_date_time is rejected, fetch unfiltered and filter locally.
        if (!(e instanceof IntegrationError) || e.kind !== "INVALID_REQUEST") throw e;
        leadRows = flattenStream(await c.searchStream<LocalServicesLeadRow>(account.externalId, localServicesLeadsQuery(), account.loginCustomerId));
      }
      const counts = countLocalServicesLeads(leadRows, from, to);
      // Leads without a campaign go to the only LSA campaign when there is exactly one.
      const lsaCampaigns = new Set(perf.campaigns.map((x) => x.externalId));
      const only = lsaCampaigns.size === 1 ? [...lsaCampaigns][0] : null;
      const byKey = new Map(perf.rows.map((r) => [`${r.campaignExternalId}|${r.date}`, r]));
      for (const lc of counts) {
        const campaignExternalId = lc.campaignExternalId ?? only;
        const key = `${campaignExternalId}|${lc.date}`;
        const row: RemoteDailyRow = byKey.get(key) ?? { campaignExternalId, date: lc.date, costMinor: 0, costIsEstimated: false, impressions: 0, clicks: 0, conversions: 0, conversionValueMinor: 0 };
        row.leads = (row.leads ?? 0) + lc.leads;
        row.conversions += lc.chargedLeads; // LSA "conversions" = charged leads (what the advertiser pays for)
        byKey.set(key, row);
        if (campaignExternalId && !lsaCampaigns.has(campaignExternalId)) {
          perf.campaigns.push({ externalId: campaignExternalId, name: `Local Services campaign ${campaignExternalId}`, status: "UNKNOWN" });
          lsaCampaigns.add(campaignExternalId);
        }
      }
      const rows = [...byKey.values()];
      const cost = rows.reduce((s, r) => s + r.costMinor, 0);
      const charged = counts.reduce((s, x) => s + x.chargedLeads, 0);
      // Unverified only when we know leads were charged yet no cost came back.
      const spendVerified = cost > 0 ? true : charged > 0 ? false : undefined;
      return { rows, campaigns: perf.campaigns, spendVerified };
    },

    // Local Services has no ads, keywords or search terms to drill into.
    ...(opts.localServices
      ? {}
      : {
          detailKinds: ["ads", "headlines", "keywords", "search_terms"] as DetailKind[],
          async fetchDetail(accessToken: string, account: AccountRef, kind: DetailKind, from: string, to: string) {
            const c = client(accessToken);
            const run = (q: string) => c.searchStream<DetailApiRow>(account.externalId, q, account.loginCustomerId).then(flattenStream);
            let rows: DetailApiRow[];
            try {
              rows = await run(detailQuery(kind, from, to));
            } catch (e) {
              // Some API versions reject the asset performance label; retry without it.
              if (kind !== "headlines" || !(e instanceof IntegrationError) || e.kind !== "INVALID_REQUEST") throw e;
              rows = await run(detailQuery(kind, from, to, false));
            }
            return parseDetailRows(kind, rows);
          },
        }),

    dataCompleteThrough(accountTimezone, now) {
      const today = todayInTimeZone(accountTimezone, now);
      return addDays(today, localHour(accountTimezone, now) >= YESTERDAY_COMPLETE_AFTER_HOUR ? -1 : -2);
    },
  };
}
