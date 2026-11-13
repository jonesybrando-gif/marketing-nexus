import { linkedSources } from "@/server/dashboards/sources";
import { displayCampaignName } from "@/lib/campaign-name";
import { isAccountDisconnected, isAccountRetired } from "@/lib/account-health";
import "server-only";
import type { ClientReport } from "../client-report";
import { buildAiContext, type AiContextInput } from "@/lib/ai-context";
import { PLATFORM_LABEL, type PlatformKey } from "@/lib/platforms";
import { channelName } from "@/lib/exec-summary";
import { rangeLabel } from "@/lib/date-ranges";
import { formatDate } from "@/lib/time";
import { stillCounting } from "@/lib/results";
import { webContextFor } from "./web-context";
import { loadClientReportLayout } from "@/server/dashboards/report";
import { reportSources } from "@/lib/dashboards/report-sections";
import type { MetricSource } from "@/lib/metrics-registry";

/** The grounding text for one client's report, as the page and PDF show it. */
export function contextForReport(rep: ClientReport): string {
  return buildAiContext(contextInput(rep));
}

/**
 * The grounding text the AI features use: the report plus the client's website,
 * organic search and keyword-rank data for the same period, when connected.
 */
/** Connected sources that are in the client's Report (removing a section, e.g. CallRail, takes it out of the summary too). */
async function sourcesInReport(rep: ClientReport): Promise<{ linked: MetricSource[]; include: Set<MetricSource> }> {
  const linked = await linkedSources(rep.client.id).catch(() => [] as MetricSource[]);
  const platforms = [...new Set(rep.client.accounts.map((a) => a.platform as PlatformKey))];
  const inReport = await loadClientReportLayout(rep.client.id, linked, platforms)
    .then((l) => reportSources(l.layout))
    .catch(() => new Set<MetricSource>(linked));
  return { linked, include: new Set(linked.filter((s) => inReport.has(s))) };
}

/**
 * The traffic sources the summary's "By channel" part covers, in order: each
 * ad platform the report includes (within the account filter), then calls,
 * organic search and rankings, and website traffic when they're in the report.
 */
export async function summaryChannels(rep: ClientReport): Promise<string[]> {
  const { include } = await sourcesInReport(rep);
  const scope = rep.accountScope?.ids ?? null;
  const order: PlatformKey[] = ["GOOGLE_ADS", "META_ADS", "MICROSOFT_ADS", "GOOGLE_LSA"];
  const platforms = new Set(rep.client.accounts.filter((a) => !scope || scope.includes(a.id)).map((a) => a.platform as PlatformKey));
  const out: string[] = include.has("ads") ? order.filter((p) => platforms.has(p)).map((p) => channelName(PLATFORM_LABEL[p])) : [];
  if (include.has("callrail")) out.push("Phone calls");
  if (include.has("gsc") || include.has("rank")) out.push("Organic search and rankings");
  if (include.has("ga4")) out.push("Website traffic");
  return out;
}

export async function aiContextForReport(rep: ClientReport): Promise<string> {
  const { linked, include } = await sourcesInReport(rep);
  const web = await webContextFor(rep.client.id, rep.client.currency, rep.range, rep.cmpRange, { callrail: !linked.includes("callrail") ? false : include.has("callrail") ? true : undefined, callsFromAds: rep.callsFromAds ?? null, include }).catch(() => null);
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
    // Dated chart notes in the reporting period (and the comparison period, for before/after context).
    events: (rep.notes ?? [])
      .filter((n) => (n.date >= rep.range.from && n.date <= rep.range.to) || (rep.cmpRange && n.date >= rep.cmpRange.from && n.date <= rep.cmpRange.to))
      .slice(-20)
      .map((n) => ({ date: n.date, text: n.text })),
    goal: client.goal,
    today: rep.today,
    stillCounting: stillCounting(rep.range.to, rep.today),
  };
}
