import "server-only";
import { prisma } from "./db";
import { INCLUDED_ROWS } from "./campaign-selection";
import { dateToIso, eachDay, isoToDate, type IsoDate } from "@/lib/pacing/dates";
import { addInto, emptyTotals, reportsLeads, type MetricTotals } from "@/lib/metrics";
import type { DateRange } from "@/lib/date-ranges";

export interface DailyMetrics extends MetricTotals {
  date: IsoDate;
}

export interface ClientPerformance {
  range: DateRange;
  totals: MetricTotals;
  byDate: DailyMetrics[];
  byAccount: Record<string, MetricTotals>;
  byCampaign: Record<string, MetricTotals>;
}

/**
 * Aggregates leaf daily rows for a client and range. Callers must have already
 * checked the user may view this client.
 */
/**
 * `accountIds`: only these ad accounts (the report's account filter); omitted = every account.
 * `campaignIds`: only these campaigns (a campaign's detail view).
 */
export async function getClientPerformance(clientId: string, range: DateRange, accountIds?: string[], campaignIds?: string[]): Promise<ClientPerformance> {
  const rows = await prisma.dailyPerformance.findMany({
    where: { account: { clientId }, ...(accountIds ? { accountId: { in: accountIds } } : {}), ...(campaignIds ? { campaignId: { in: campaignIds } } : {}), date: { gte: isoToDate(range.from), lte: isoToDate(range.to) }, ...INCLUDED_ROWS },
    select: {
      accountId: true,
      campaignId: true,
      date: true,
      costMinor: true,
      costIsEstimated: true,
      impressions: true,
      clicks: true,
      conversions: true,
      conversionValueMinor: true,
      leads: true,
      account: { select: { platform: true } },
    },
  });
  const byDateMap = new Map<IsoDate, MetricTotals>(eachDay(range.from, range.to).map((d) => [d, emptyTotals()]));
  const byAccount: Record<string, MetricTotals> = {};
  const byCampaign: Record<string, MetricTotals> = {};
  const totals = emptyTotals();
  for (const r of rows) {
    const m = {
      costMinor: Number(r.costMinor),
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
      conversions: Number(r.conversions),
      conversionValueMinor: Number(r.conversionValueMinor),
      leads: r.leads === null ? 0 : Number(r.leads),
      hasEstimatedCost: r.costIsEstimated,
      leadsReported: reportsLeads(r.account.platform),
    };
    addInto(totals, m);
    addInto(byDateMap.get(dateToIso(r.date))!, m);
    addInto((byAccount[r.accountId] ??= emptyTotals()), m);
    if (r.campaignId) addInto((byCampaign[r.campaignId] ??= emptyTotals()), m);
  }
  return {
    range,
    totals,
    byDate: [...byDateMap.entries()].map(([date, t]) => ({ date, ...t })),
    byAccount,
    byCampaign,
  };
}
