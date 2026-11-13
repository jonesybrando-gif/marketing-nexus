"use server";

import { requireClientView } from "@/server/access";
import { loadClientReportHead, type ReportParams } from "@/server/client-report";
import { getClientPerformance } from "@/server/reporting";
import type { MetricTotals } from "@/lib/metrics";
import type { DailyMetrics } from "@/server/reporting";

export type CampaignDetail =
  | {
      ok: true;
      name: string;
      platform: string;
      account: string;
      status: string;
      currency: string;
      range: { from: string; to: string };
      cmpRange: { from: string; to: string } | null;
      totals: MetricTotals;
      previous: MetricTotals | null;
      daily: DailyMetrics[];
      cmpDaily: DailyMetrics[] | null;
    }
  | { ok: false; error: string };

/** One campaign's figures and daily history for the page's range and comparison (the campaign detail view). */
export async function campaignDetailAction(clientId: string, campaignId: string, params: ReportParams): Promise<CampaignDetail> {
  await requireClientView(clientId);
  const p = params && typeof params === "object" ? params : {};
  const head = await loadClientReportHead(clientId, { range: p.range, compare: p.compare, from: p.from, to: p.to });
  const account = head.client.accounts.find((a) => a.campaigns.some((c) => c.id === campaignId));
  const campaign = account?.campaigns.find((c) => c.id === campaignId);
  if (!account || !campaign) return { ok: false, error: "That campaign isn't part of this client's report." };
  const [cur, cmp] = await Promise.all([
    getClientPerformance(clientId, head.range, undefined, [campaignId]),
    head.cmpRange ? getClientPerformance(clientId, head.cmpRange, undefined, [campaignId]) : Promise.resolve(null),
  ]);
  return {
    ok: true,
    name: campaign.name,
    platform: account.platform,
    account: account.name,
    status: campaign.status,
    currency: account.currency,
    range: head.range,
    cmpRange: head.cmpRange,
    totals: cur.totals,
    previous: cmp?.totals ?? null,
    daily: cur.byDate,
    cmpDaily: cmp?.byDate ?? null,
  };
}
