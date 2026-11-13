import { displayCampaignName } from "@/lib/campaign-name";
import { isAccountDisconnected, isAccountRetired } from "@/lib/account-health";
import "server-only";
import type { ClientReport } from "../client-report";
import { buildAiContext, type AiContextInput } from "@/lib/ai-context";
import { PLATFORM_LABEL } from "@/lib/platforms";
import { rangeLabel } from "@/lib/date-ranges";
import { formatDate } from "@/lib/time";
import { stillCounting } from "@/lib/results";
import { webContextFor } from "./web-context";

/** The grounding text for one client's report, as the page and PDF show it. */
export function contextForReport(rep: ClientReport): string {
  return buildAiContext(contextInput(rep));
}

/**
 * The grounding text the AI features use: the report plus the client's website,
 * organic search and keyword-rank data for the same period, when connected.
 */
export async function aiContextForReport(rep: ClientReport): Promise<string> {
  const web = await webContextFor(rep.client.id, rep.client.currency, rep.range, rep.cmpRange).catch(() => null);
  return buildAiContext({ ...contextInput(rep), web });
}

export function contextInput(rep: ClientReport): AiContextInput {
  const { client, pacing, perf, cmpPerf, template } = rep;
  const total = pacing.total;
  const metaById = new Map(pacing.accounts.map((a) => [a.id, a]));
  // When the report covers exactly a past budget month, its final result is relevant.
  const past = rep.history.find((h) => h.period.start === rep.range.from && h.period.end === rep.range.to && h.total);
  // Only the ad accounts the report is filtered to (all by default).
  const scope = rep.accountScope?.ids ?? null;
  const inScope = client.accounts.filter((a) => !scope || scope.includes(a.id));
  return {
    clientName: client.name,
    currency: client.currency,
    isDemo: client.accounts.some((a) => a.isDemo),
    rangeLabel: rangeLabel(rep.preset, rep.range),
    range: rep.range,
    comparison: rep.cmpRange,
    kpis: template.kpis,
    totals: perf.totals,
    previous: cmpPerf?.totals ?? null,
    accounts: inScope.map((a) => {
      const meta = metaById.get(a.id);
      const dataNote =
        isAccountRetired(a)
          ? "no longer synced; earlier data only"
          : isAccountDisconnected(a)
          ? "disconnected; data may be missing"
          : meta?.stale
            ? `stale: last synced ${meta.lastSuccessfulSyncAt ? formatDate(meta.lastSuccessfulSyncAt.slice(0, 10)) : "never"}`
            : null;
      return { platform: PLATFORM_LABEL[a.platform], name: a.name, totals: perf.byAccount[a.id] ?? null, previousTotals: cmpPerf?.byAccount[a.id] ?? null, spendVerified: a.spendIsVerified, dataNote };
    }),
    campaigns: inScope.flatMap((a) =>
      a.campaigns
        .filter((cmp) => (perf.byCampaign[cmp.id]?.costMinor ?? 0) > 0)
        .map((cmp) => {
          // Its own budget line this month, if it has one (campaign budget rows are labelled with the campaign name).
          const row = pacing.subRows.find((r) => r.level === "CAMPAIGNS" && r.label === cmp.name && r.accounts[0]?.id === a.id && r.result);
          const budget = row?.result ? { status: row.result.status, currentDailyRateMinor: row.result.currentDailyRateMinor, requiredDailyMinor: row.result.requiredDailyMinor } : null;
          return { name: displayCampaignName(cmp.name), platform: PLATFORM_LABEL[a.platform], status: cmp.status, totals: perf.byCampaign[cmp.id], previous: cmpPerf?.byCampaign[cmp.id] ?? null, budget };
        }),
    ),
    pacing: total
      ? {
          periodStart: pacing.period.start,
          periodEnd: pacing.period.end,
          asOf: total.asOf,
          status: total.status,
          forecastStatus: total.forecastStatus,
          budgetMinor: total.budgetMinor,
          actualToDateMinor: total.actualToDateMinor,
          expectedToDateMinor: total.expectedToDateMinor,
          projectedMinor: total.projectedMinor,
          requiredDailyMinor: total.requiredDailyMinor,
          currentDailyRateMinor: total.currentDailyRateMinor,
          remainingActiveDays: total.remainingActiveDays,
          pacingPct: total.pacingPct,
        }
      : null,
    pastBudget: past?.total
      ? { month: formatDate(past.period.start, { month: "long", year: "numeric" }), budgetMinor: past.total.budgetMinor, spentMinor: past.total.actualToDateMinor, status: past.total.status }
      : null,
    notes: [...new Set([...pacing.rows, ...pacing.subRows].flatMap((r) => r.warnings))],
    goal: client.goal,
    today: rep.today,
    stillCounting: stillCounting(rep.range.to, rep.today),
  };
}
