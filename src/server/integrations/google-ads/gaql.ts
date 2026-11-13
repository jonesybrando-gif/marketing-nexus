// Google Ads Query Language (GAQL) builders and REST response parsing.
// Pure functions (no I/O) so they can be unit-tested against recorded shapes.
//
// REST JSON conventions (Google Ads API REST interface):
// - field names are lowerCamelCase (metrics.costMicros)
// - int64 values arrive as strings ("1230000"); doubles as numbers
// - metrics/fields whose value is zero or unset may be omitted entirely

import { assertIsoDate, type IsoDate } from "@/lib/pacing/dates";
import type { RemoteAccount, RemoteCampaign, RemoteDailyRow } from "../types";

/** "123-456-7890" or "customers/1234567890" → "1234567890" */
export function normalizeCustomerId(id: string): string {
  const digits = id.replace(/^customers\//, "").replace(/-/g, "");
  if (!/^\d{10}$/.test(digits)) throw new Error(`Invalid Google Ads customer id: ${id}`);
  return digits;
}

export function formatCustomerId(id: string): string {
  const d = normalizeCustomerId(id);
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Micros (1/1,000,000 of the currency unit) → minor units (cents), rounded half away from zero. */
export function microsToMinor(micros: string | number | undefined): number {
  if (micros === undefined || micros === null || micros === "") return 0;
  const m = BigInt(typeof micros === "number" ? Math.round(micros) : micros);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const minor = (abs + 5000n) / 10000n;
  return Number(neg ? -minor : minor);
}

/** A currency amount as a double (e.g. conversions_value) → minor units. */
export function unitsToMinor(v: number | string | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  return Math.round(Number(v) * 100);
}

const int = (v: string | number | undefined) => (v === undefined || v === null || v === "" ? 0 : Number(v));

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Every account in a manager's hierarchy (including the manager itself at level 0). */
export const CUSTOMER_CLIENT_QUERY = `
SELECT
  customer_client.id,
  customer_client.descriptive_name,
  customer_client.currency_code,
  customer_client.time_zone,
  customer_client.manager,
  customer_client.level,
  customer_client.status,
  customer_client.test_account
FROM customer_client
WHERE customer_client.status = 'ENABLED'`.trim();

/**
 * Local Services campaigns (advertising_channel_type LOCAL_SERVICES) are
 * reported under the separate "Google LSA" platform, so the Google Ads
 * queries exclude them and the LSA queries select only them. Each campaign's
 * cost therefore lands in exactly one platform.
 */
export type CampaignScope = "ADS" | "LOCAL_SERVICES";

const channelFilter = (scope: CampaignScope) =>
  scope === "LOCAL_SERVICES" ? "campaign.advertising_channel_type = 'LOCAL_SERVICES'" : "campaign.advertising_channel_type != 'LOCAL_SERVICES'";

export function campaignsQuery(scope: CampaignScope = "ADS"): string {
  return `
SELECT
  campaign.id,
  campaign.name,
  campaign.status,
  campaign_budget.id,
  campaign_budget.amount_micros,
  campaign_budget.period
FROM campaign
WHERE campaign.status != 'REMOVED'
  AND ${channelFilter(scope)}`.trim();
}

/** @deprecated use campaignsQuery("ADS") */
export const CAMPAIGNS_QUERY = campaignsQuery("ADS");

/**
 * Daily campaign performance. Dates are in the account's own time zone.
 * Removed campaigns are deliberately NOT filtered out: their historical spend
 * still counts toward the month.
 */
export function dailyPerformanceQuery(from: IsoDate, to: IsoDate, scope: CampaignScope = "ADS"): string {
  assertIsoDate(from);
  assertIsoDate(to);
  if (to < from) throw new Error("`to` is before `from`");
  return `
SELECT
  campaign.id,
  campaign.name,
  campaign.status,
  segments.date,
  metrics.cost_micros,
  metrics.impressions,
  metrics.clicks,
  metrics.conversions,
  metrics.conversions_value
FROM campaign
WHERE segments.date BETWEEN '${from}' AND '${to}'
  AND ${channelFilter(scope)}`.trim();
}

/**
 * Local Services leads created in [from, to] (account time zone). Field names
 * per the local_services_lead resource; filtering on creation_date_time is
 * attempted first, with a client-side filter as fallback (see the adapter).
 */
export function localServicesLeadsQuery(from?: IsoDate, to?: IsoDate): string {
  const base = `
SELECT
  local_services_lead.id,
  local_services_lead.campaign,
  local_services_lead.lead_type,
  local_services_lead.lead_status,
  local_services_lead.lead_charged,
  local_services_lead.creation_date_time
FROM local_services_lead`.trim();
  if (!from || !to) return base;
  assertIsoDate(from);
  assertIsoDate(to);
  return `${base}
WHERE local_services_lead.creation_date_time >= '${from} 00:00:00'
  AND local_services_lead.creation_date_time <= '${to} 23:59:59'`;
}

export interface LocalServicesLeadRow {
  localServicesLead?: {
    id?: string;
    campaign?: string; // "customers/123/campaigns/456"
    leadType?: string;
    leadStatus?: string;
    leadCharged?: boolean;
    creationDateTime?: string; // "2026-10-16 14:03:22"
  };
}

export interface LeadCounts {
  campaignExternalId: string | null;
  date: IsoDate;
  leads: number;
  chargedLeads: number;
}

/** Lead rows → counts per campaign per creation date, limited to [from, to]. */
export function countLocalServicesLeads(rows: LocalServicesLeadRow[], from: IsoDate, to: IsoDate): LeadCounts[] {
  const out = new Map<string, LeadCounts>();
  for (const r of rows) {
    const l = r.localServicesLead;
    const date = l?.creationDateTime?.slice(0, 10);
    if (!l || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) continue;
    const campaignExternalId = l.campaign?.match(/campaigns\/(\d+)$/)?.[1] ?? null;
    const key = `${campaignExternalId}|${date}`;
    const c = out.get(key) ?? { campaignExternalId, date, leads: 0, chargedLeads: 0 };
    c.leads += 1;
    if (l.leadCharged) c.chargedLeads += 1;
    out.set(key, c);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export interface SearchStreamBatch<T> {
  results?: T[];
  fieldMask?: string;
  requestId?: string;
}

export function flattenStream<T>(batches: SearchStreamBatch<T>[] | SearchStreamBatch<T>): T[] {
  const arr = Array.isArray(batches) ? batches : [batches];
  return arr.flatMap((b) => b.results ?? []);
}

export interface CustomerClientRow {
  customerClient?: {
    id?: string;
    descriptiveName?: string;
    currencyCode?: string;
    timeZone?: string;
    manager?: boolean;
    level?: string | number;
    status?: string;
    testAccount?: boolean;
  };
}

/** Rows from CUSTOMER_CLIENT_QUERY run against `managerId` → accounts. */
export function parseCustomerClients(rows: CustomerClientRow[], queriedCustomerId: string): RemoteAccount[] {
  const root = normalizeCustomerId(queriedCustomerId);
  return rows
    .map((r) => r.customerClient)
    .filter((c): c is NonNullable<CustomerClientRow["customerClient"]> => !!c?.id)
    .map((c) => {
      const id = normalizeCustomerId(c.id!);
      return {
        externalId: id,
        name: c.descriptiveName || formatCustomerId(id),
        displayId: formatCustomerId(id),
        currency: c.currencyCode ?? "USD",
        timezone: c.timeZone ?? "America/New_York",
        isManager: !!c.manager,
        isTestAccount: !!c.testAccount,
        // Reached through the queried manager unless it is the queried account itself.
        loginCustomerId: id === root ? undefined : root,
        level: int(c.level),
      };
    });
}

export interface CampaignRow {
  campaign?: { id?: string; name?: string; status?: string };
  campaignBudget?: { id?: string; amountMicros?: string; period?: string };
}

const STATUSES = new Set(["ENABLED", "PAUSED", "REMOVED"]);
const toStatus = (s?: string): RemoteCampaign["status"] => (s && STATUSES.has(s) ? (s as RemoteCampaign["status"]) : "UNKNOWN");

export function parseCampaigns(rows: CampaignRow[]): RemoteCampaign[] {
  return rows
    .filter((r) => r.campaign?.id)
    .map((r) => ({
      externalId: r.campaign!.id!,
      name: r.campaign!.name ?? `Campaign ${r.campaign!.id}`,
      status: toStatus(r.campaign!.status),
      ...googleBudget(r.campaignBudget),
    }));
}

/**
 * Google budgets: DAILY (and the older FIXED_DAILY) are daily amounts, shared by
 * every campaign with the same budget id. CUSTOM_PERIOD is a total for the
 * campaign's dates (no fixed daily amount). Anything else is left unreported.
 */
function googleBudget(b: CampaignRow["campaignBudget"]): Pick<RemoteCampaign, "dailyBudgetMinor" | "budgetKind" | "budgetId"> {
  if (!b) return {};
  const budgetId = b.id ? `google:${b.id}` : undefined;
  const period = b.period ?? "DAILY";
  if (period === "CUSTOM_PERIOD") return { budgetKind: "LIFETIME", budgetId };
  if ((period === "DAILY" || period === "FIXED_DAILY") && b.amountMicros) return { budgetKind: "DAILY", dailyBudgetMinor: microsToMinor(b.amountMicros), budgetId };
  return {};
}

export interface PerformanceRow {
  campaign?: { id?: string; name?: string; status?: string };
  segments?: { date?: string };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: number | string;
    conversionsValue?: number | string;
  };
}

/**
 * Daily rows → one RemoteDailyRow per campaign per date. If the API returns
 * more than one row for the same campaign and date they are summed, so the
 * result is always leaf-level and unique.
 */
export function parseDailyPerformance(rows: PerformanceRow[]): { rows: RemoteDailyRow[]; campaigns: RemoteCampaign[] } {
  const byKey = new Map<string, RemoteDailyRow>();
  const campaigns = new Map<string, RemoteCampaign>();
  for (const r of rows) {
    const id = r.campaign?.id;
    const date = r.segments?.date;
    if (!id || !date) continue;
    assertIsoDate(date);
    campaigns.set(id, { externalId: id, name: r.campaign?.name ?? `Campaign ${id}`, status: toStatus(r.campaign?.status) });
    const key = `${id}|${date}`;
    const row = byKey.get(key) ?? {
      campaignExternalId: id,
      date,
      costMinor: 0,
      costIsEstimated: false,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversionValueMinor: 0,
    };
    const m = r.metrics ?? {};
    row.costMinor += microsToMinor(m.costMicros);
    row.impressions += int(m.impressions);
    row.clicks += int(m.clicks);
    row.conversions += Number(m.conversions ?? 0);
    row.conversionValueMinor += unitsToMinor(m.conversionsValue);
    byKey.set(key, row);
  }
  return { rows: [...byKey.values()], campaigns: [...campaigns.values()] };
}
