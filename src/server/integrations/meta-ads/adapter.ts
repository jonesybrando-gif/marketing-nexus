// Meta Ads adapter: official Graph / Marketing API with Facebook Login.
//
// Tokens: Meta has no refresh tokens. A Facebook Login user token is exchanged
// for a long-lived token (about 60 days) and must be re-authorized before it
// expires. Agencies can instead paste a Business Manager system-user token,
// which does not expire; that is Meta's recommended setup for server-to-server use.

import { createHmac } from "node:crypto";
import { assertIsoDate } from "@/lib/pacing/dates";
import { IntegrationError, type IntegrationErrorKind } from "../errors";
import { completeThrough, decimalToMinor, readJson } from "../common";
import { headlinesFromAds, parseAdInsights, type AdCreative, type AdInsightRow } from "./details";
import type { DailyPerformanceResult, OAuthTokens, PlatformAdapter, RemoteAccount, RemoteCampaign, RemoteDailyRow } from "../types";
import { metaAdsConfig, type MetaAdsConfig } from "./config";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const GRAPH = "https://graph.facebook.com";
export const META_SCOPES = ["ads_read", "business_management"];
const MAX_PAGES = 200;

// Action types, in order of preference. Only the first one present is used,
// because Meta reports overlapping action types (e.g. "lead" already includes
// pixel and on-Facebook leads).
/** Ads whose creative text is looked up for the AI assistant, highest spend first. */
const CREATIVE_LOOKUPS = 60;

export const LEAD_ACTION_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];
export const PURCHASE_ACTION_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
/** Phone calls from call ads ("Calls placed" in Ads Manager); the first type present is used. */
export const CALL_ACTION_TYPES = ["click_to_call_native_call_placed", "click_to_call_call_confirm"];

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; is_transient?: boolean };
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Seconds/minutes until access returns, from Meta's usage headers, if present. */
function retryAfterFromHeaders(headers: Headers): number | undefined {
  let ms: number | undefined;
  const buc = headers.get("x-business-use-case-usage");
  if (buc) {
    try {
      const parsed = JSON.parse(buc) as Record<string, { estimated_time_to_regain_access?: number }[]>;
      for (const entries of Object.values(parsed)) {
        for (const e of entries) {
          if (e.estimated_time_to_regain_access) ms = Math.max(ms ?? 0, e.estimated_time_to_regain_access * 60_000);
        }
      }
    } catch {
      /* ignore malformed header */
    }
  }
  const acc = headers.get("x-ad-account-usage");
  if (acc) {
    try {
      const reset = (JSON.parse(acc) as { reset_time_duration?: number }).reset_time_duration;
      if (reset) ms = Math.max(ms ?? 0, reset * 1000);
    } catch {
      /* ignore */
    }
  }
  return ms;
}

interface MetaBudgetFields { daily_budget?: string; lifetime_budget?: string }
interface MetaAdSet extends MetaBudgetFields { campaign_id?: string; effective_status?: string }
const positive = (v?: string) => !!v && Number(v) > 0;

/**
 * A Meta campaign's budget. Campaign budget (CBO): its daily or lifetime budget.
 * Otherwise the sum of its active ad sets' daily budgets; any active ad set on a
 * lifetime budget makes the whole campaign LIFETIME (no fixed daily amount).
 * Meta amounts are already in the currency's minor units. adSets = null means
 * they couldn't be read, so the budget is left unreported.
 */
export function metaCampaignBudget(c: MetaBudgetFields & { id: string }, adSets: MetaAdSet[] | null): Pick<RemoteCampaign, "dailyBudgetMinor" | "budgetKind" | "budgetId"> {
  const budgetId = `meta:${c.id}`;
  if (positive(c.daily_budget)) return { budgetKind: "DAILY", dailyBudgetMinor: Number(c.daily_budget), budgetId };
  if (positive(c.lifetime_budget)) return { budgetKind: "LIFETIME", budgetId };
  if (!adSets) return {};
  const active = adSets.filter((a) => a.campaign_id === c.id && a.effective_status === "ACTIVE");
  if (active.some((a) => positive(a.lifetime_budget))) return { budgetKind: "LIFETIME", budgetId };
  return { budgetKind: "DAILY", dailyBudgetMinor: active.reduce((s, a) => s + (positive(a.daily_budget) ? Number(a.daily_budget) : 0), 0), budgetId };
}

export function classifyMetaError(status: number, body: unknown, headers?: Headers): IntegrationError {
  const err = (body as GraphError | undefined)?.error;
  const code = err?.code;
  const sub = err?.error_subcode;
  const message = err?.message ?? `Meta API returned HTTP ${status}`;
  const label = code !== undefined ? `(#${code}${sub ? `/${sub}` : ""}) ${message}` : message;
  const retryAfter = headers ? retryAfterFromHeaders(headers) : undefined;
  let kind: IntegrationErrorKind;
  if (code === 190 || code === 102) kind = "AUTH_REVOKED";
  else if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || (code !== undefined && code >= 80000 && code <= 80014) || status === 429) kind = "RATE_LIMITED";
  // "(#200) API access blocked" is Meta blocking the app or developer account (e.g. "Account confirmation
  // needed"), not this ad account losing access: marking accounts disconnected would only make them flap.
  else if (code === 200 && /api access blocked/i.test(message)) kind = "APP_BLOCKED";
  else if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) kind = "PERMISSION_DENIED";
  else if (err?.is_transient || code === 1 || code === 2 || status >= 500) kind = "TRANSIENT";
  else kind = "INVALID_REQUEST";
  return new IntegrationError(kind, label, retryAfter, status);
}

const STATUS_MAP: Record<string, RemoteCampaign["status"]> = {
  ACTIVE: "ENABLED",
  PAUSED: "PAUSED",
  CAMPAIGN_PAUSED: "PAUSED",
  ADSET_PAUSED: "PAUSED",
  IN_PROCESS: "ENABLED",
  WITH_ISSUES: "ENABLED",
  DELETED: "REMOVED",
  ARCHIVED: "REMOVED",
};

const ACCOUNT_STATUS: Record<number, string> = {
  2: "Disabled",
  3: "Unsettled",
  7: "Pending risk review",
  8: "Pending settlement",
  9: "In grace period",
  100: "Pending closure",
  101: "Closed",
};

interface ActionValue {
  action_type?: string;
  value?: string;
}

/** First preferred action type present → its value. */
export function pickAction(list: ActionValue[] | undefined, preference: string[]): number {
  if (!list?.length) return 0;
  for (const type of preference) {
    const hit = list.find((a) => a.action_type === type);
    if (hit) return Number(hit.value ?? 0);
  }
  return 0;
}

export interface InsightRow {
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  reach?: string;
  actions?: ActionValue[];
  action_values?: ActionValue[];
}

/**
 * Insights rows (level=campaign, time_increment=1) → leaf daily rows.
 * Conversions = leads + purchases + calls placed, as reported by Meta under the ad account's
 * attribution setting; conversion value = purchase value.
 */
export function parseInsights(rows: InsightRow[]): { rows: RemoteDailyRow[]; campaigns: RemoteCampaign[] } {
  const out = new Map<string, RemoteDailyRow>();
  const campaigns = new Map<string, RemoteCampaign>();
  for (const r of rows) {
    if (!r.campaign_id || !r.date_start) continue;
    assertIsoDate(r.date_start);
    if (r.campaign_name || !campaigns.has(r.campaign_id)) {
      campaigns.set(r.campaign_id, { externalId: r.campaign_id, name: r.campaign_name ?? `Campaign ${r.campaign_id}`, status: "UNKNOWN" });
    }
    const leads = pickAction(r.actions, LEAD_ACTION_TYPES);
    const purchases = pickAction(r.actions, PURCHASE_ACTION_TYPES);
    const purchaseValue = pickAction(r.action_values, PURCHASE_ACTION_TYPES);
    const key = `${r.campaign_id}|${r.date_start}`;
    const row = out.get(key) ?? { campaignExternalId: r.campaign_id, date: r.date_start, costMinor: 0, costIsEstimated: false, impressions: 0, clicks: 0, conversions: 0, conversionValueMinor: 0, leads: 0 };
    row.costMinor += decimalToMinor(r.spend);
    row.impressions += Number(r.impressions ?? 0);
    row.clicks += Number(r.clicks ?? 0);
    // Daily reach is unique people that day; it must never be summed across days.
    row.reach = r.reach === undefined ? row.reach : Number(r.reach);
    row.leads = (row.leads ?? 0) + leads;
    row.conversions += leads + purchases + pickAction(r.actions, CALL_ACTION_TYPES);
    row.conversionValueMinor += Math.round(purchaseValue * 100);
    out.set(key, row);
  }
  return { rows: [...out.values()], campaigns: [...campaigns.values()] };
}

export function createMetaAdsAdapter(opts: { config?: MetaAdsConfig | null; fetch?: FetchLike } = {}): PlatformAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const cfg = () => {
    const c = opts.config === undefined ? metaAdsConfig() : opts.config;
    if (!c) throw new IntegrationError("NOT_CONFIGURED", "Meta app credentials are not configured on the server");
    return c;
  };
  const appsecretProof = (token: string) => createHmac("sha256", cfg().appSecret).update(token).digest("hex");

  async function get<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
    const url = path.startsWith("https://") ? new URL(path) : new URL(`${GRAPH}/${cfg().apiVersion}/${path.replace(/^\//, "")}`);
    if (url.host !== "graph.facebook.com") throw new IntegrationError("INVALID_REQUEST", "Refusing to follow a paging link outside graph.facebook.com");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("appsecret_proof", appsecretProof(token));
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      throw new IntegrationError("TRANSIENT", `Network error calling Meta API: ${(e as Error).message}`);
    }
    const body = await readJson(res);
    if (!res.ok || (body as GraphError)?.error) throw classifyMetaError(res.status, body, res.headers);
    return body as T;
  }

  async function getAll<T>(path: string, token: string, params: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let page = await get<{ data?: T[]; paging?: { next?: string } }>(path, token, params);
    for (let i = 0; i < MAX_PAGES; i++) {
      out.push(...(page.data ?? []));
      if (!page.paging?.next) return out;
      page = await get(page.paging.next, token);
    }
    throw new IntegrationError("INVALID_REQUEST", "Too many result pages from Meta API");
  }

  async function oauthGet(params: Record<string, string>): Promise<{ access_token?: string; expires_in?: number }> {
    const url = new URL(`${GRAPH}/${cfg().apiVersion}/oauth/access_token`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchImpl(url.toString());
    } catch (e) {
      throw new IntegrationError("TRANSIENT", `Network error contacting Meta: ${(e as Error).message}`);
    }
    const body = (await readJson(res)) as { access_token?: string; expires_in?: number } & GraphError;
    if (!res.ok || body?.error || !body?.access_token) {
      const err = classifyMetaError(res.status, body, res.headers);
      // Bad app id/secret come back as OAuthException code 101 / 1
      if (body?.error?.code === 101) throw new IntegrationError("NOT_CONFIGURED", `Meta rejected the app credentials: ${body.error.message}. Check META_APP_ID and META_APP_SECRET.`, undefined, res.status);
      throw err.kind === "AUTH_REVOKED" ? err : new IntegrationError(err.kind === "TRANSIENT" ? "TRANSIENT" : "INVALID_REQUEST", `Meta authorization failed: ${err.message}`, undefined, res.status);
    }
    return body;
  }

  const ACCOUNT_FIELDS = "account_id,name,currency,timezone_name,account_status";
  const toAccount = (a: { account_id?: string; id?: string; name?: string; currency?: string; timezone_name?: string; account_status?: number }): RemoteAccount | null => {
    const id = a.account_id ?? a.id?.replace(/^act_/, "");
    if (!id) return null;
    return {
      externalId: id,
      displayId: `act_${id}`,
      name: a.name ?? `act_${id}`,
      currency: a.currency ?? "USD",
      timezone: a.timezone_name ?? "America/New_York",
      isManager: false,
      statusNote: a.account_status && a.account_status !== 1 ? ACCOUNT_STATUS[a.account_status] ?? `Status ${a.account_status}` : undefined,
    };
  };

  return {
    platform: "META_ADS",
    connectionPlatform: "META_ADS",
    linkablePlatforms: ["META_ADS"],
    spendIsVerified: true,
    restatementWindowDays: 28, // Meta's attribution windows restate recent days
    initialBackfillDays: 400,
    maxRangeDays: 31, // keeps synchronous insights requests small

    isConfigured: () => opts.config !== undefined ? !!opts.config : metaAdsConfig() !== null,

    authorizationUrl(state, redirectUri) {
      const q = new URLSearchParams({ client_id: cfg().appId, redirect_uri: redirectUri, state, response_type: "code" });
      const configId = cfg().loginConfigId;
      if (configId) {
        // Facebook Login for Business: the configuration carries the permissions.
        q.set("config_id", configId);
        q.set("override_default_response_type", "true");
      } else {
        q.set("scope", META_SCOPES.join(","));
      }
      return `https://www.facebook.com/${cfg().apiVersion}/dialog/oauth?${q.toString()}`;
    },

    /** Code → short-lived user token → long-lived user token (~60 days). No refresh token exists. */
    async exchangeCode(code, redirectUri): Promise<OAuthTokens> {
      const short = await oauthGet({ client_id: cfg().appId, client_secret: cfg().appSecret, redirect_uri: redirectUri, code });
      const long = await oauthGet({ grant_type: "fb_exchange_token", client_id: cfg().appId, client_secret: cfg().appSecret, fb_exchange_token: short.access_token! });
      return {
        accessToken: long.access_token!,
        expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : undefined,
        scopes: META_SCOPES.join(","),
      };
    },

    /** Validate a pasted system-user (or other long-lived) token. */
    async connectWithToken(token) {
      const appToken = `${cfg().appId}|${cfg().appSecret}`;
      const debug = await get<{ data?: { is_valid?: boolean; expires_at?: number; scopes?: string[]; app_id?: string } }>("debug_token", appToken, { input_token: token });
      const d = debug.data;
      if (!d?.is_valid) throw new IntegrationError("AUTH_REVOKED", "Meta says this token is not valid.");
      if (d.app_id && d.app_id !== cfg().appId) throw new IntegrationError("INVALID_REQUEST", "This token belongs to a different Meta app than META_APP_ID.");
      if (d.scopes && !d.scopes.includes("ads_read")) throw new IntegrationError("PERMISSION_DENIED", "This token does not have the ads_read permission.");
      const me = await get<{ id?: string; name?: string }>("me", token, { fields: "id,name" });
      return {
        label: `Meta Ads — ${me.name ?? "system user"} (token)`,
        tokens: { accessToken: token, expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : undefined, scopes: d.scopes?.join(",") },
      };
    },

    /** Ad accounts the token can reach directly, plus those owned by or shared with the user's businesses. */
    async listAccounts(token) {
      const found = new Map<string, RemoteAccount>();
      const add = (list: Parameters<typeof toAccount>[0][]) => {
        for (const a of list) {
          const acc = toAccount(a);
          if (acc && !found.has(acc.externalId)) found.set(acc.externalId, acc);
        }
      };
      add(await getAll("me/adaccounts", token, { fields: ACCOUNT_FIELDS, limit: "200" }));
      let businesses: { id: string }[] = [];
      try {
        businesses = await getAll<{ id: string }>("me/businesses", token, { fields: "id,name", limit: "100" });
      } catch (e) {
        if (!(e instanceof IntegrationError) || e.kind !== "PERMISSION_DENIED") throw e;
      }
      for (const b of businesses) {
        for (const edge of ["owned_ad_accounts", "client_ad_accounts"]) {
          try {
            add(await getAll(`${b.id}/${edge}`, token, { fields: ACCOUNT_FIELDS, limit: "200" }));
          } catch (e) {
            if (!(e instanceof IntegrationError) || e.kind !== "PERMISSION_DENIED") throw e;
          }
        }
      }
      return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    async listCampaigns(token, account) {
      const rows = await getAll<MetaBudgetFields & { id: string; name?: string; effective_status?: string }>(`act_${account.externalId}/campaigns`, token, {
        fields: "id,name,effective_status,daily_budget,lifetime_budget",
        limit: "500",
      });
      // Campaigns without a campaign budget are budgeted per ad set (ABO): read those too.
      let adSets: MetaAdSet[] | null = null;
      if (rows.some((c) => !positive(c.daily_budget) && !positive(c.lifetime_budget))) {
        try {
          adSets = await getAll<MetaAdSet>(`act_${account.externalId}/adsets`, token, { fields: "campaign_id,effective_status,daily_budget,lifetime_budget", limit: "500" });
        } catch (e) {
          if (e instanceof IntegrationError && (e.kind === "AUTH_REVOKED" || e.kind === "APP_BLOCKED")) throw e;
          adSets = null; // budgets stay unreported; spend still syncs
        }
      }
      return rows.map((c) => ({
        externalId: c.id,
        name: c.name ?? `Campaign ${c.id}`,
        status: STATUS_MAP[c.effective_status ?? ""] ?? "UNKNOWN",
        ...metaCampaignBudget(c, adSets),
      }));
    },

    async fetchDailyPerformance(token, account, from, to): Promise<DailyPerformanceResult> {
      assertIsoDate(from);
      assertIsoDate(to);
      const rows = await getAll<InsightRow>(`act_${account.externalId}/insights`, token, {
        level: "campaign",
        time_increment: "1",
        time_range: JSON.stringify({ since: from, until: to }),
        fields: "campaign_id,campaign_name,spend,impressions,clicks,reach,actions,action_values",
        limit: "500",
      });
      return parseInsights(rows);
    },

    detailKinds: ["ads", "headlines"],
    async fetchDetail(token, account, kind, from, to) {
      if (kind !== "ads" && kind !== "headlines") return [];
      assertIsoDate(from);
      assertIsoDate(to);
      const rows = (
        await getAll<AdInsightRow>(`act_${account.externalId}/insights`, token, {
          level: "ad",
          time_range: JSON.stringify({ since: from, until: to }),
          fields: "ad_id,ad_name,adset_name,campaign_name,spend,impressions,clicks,actions,action_values",
          limit: "500",
        })
      )
        .sort((a, b) => Number(b.spend ?? 0) - Number(a.spend ?? 0))
        .slice(0, 200);
      // Creative text (headline, primary text) for the top ads by spend, one
      // request per ad (Graph API v26 removed the multi-id "ids" lookup).
      // Best effort: an ad whose creative can't be read just has no text.
      const creatives: Record<string, AdCreative> = {};
      const ids = rows.map((r) => r.ad_id).filter((x): x is string => !!x).slice(0, CREATIVE_LOOKUPS);
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const id = ids[next++];
          try {
            creatives[id] = await get<AdCreative>(id, token, { fields: "creative{title,body,object_story_spec}" });
          } catch (e) {
            if (e instanceof IntegrationError && e.kind === "AUTH_REVOKED") throw e;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(5, ids.length) }, worker));
      const ads = parseAdInsights(rows, creatives);
      return kind === "ads" ? ads : headlinesFromAds(ads);
    },

    dataCompleteThrough: (tz, now) => completeThrough(tz, now, 3),
  };
}

