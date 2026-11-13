// Turns report data into the text block the AI assistant is grounded in.
// Every number is pre-formatted (money in currency, not minor units) so the
// model quotes figures rather than computing them, and anything the platforms
// didn't report is written as "not reported" instead of 0.

import { formatDate } from "./time";
import { formatKpi, KPI_BY_KEY, kpiValues, type KpiKey } from "./kpis";
import { formatMoney, formatNumber, formatPct } from "./money";
import { derive, type MetricTotals } from "./metrics";
import { STATUS_LABEL, type PacingStatus } from "./pacing/status";
import { hasPlaceholderValues, resolveGoal, resultsFor } from "./results";
import type { ClientGoal } from "@prisma/client";
import type { Verdict } from "./change";

export interface AiPacing {
  periodStart: string;
  periodEnd: string;
  asOf: string | null;
  status: PacingStatus;
  forecastStatus: PacingStatus;
  budgetMinor: number;
  actualToDateMinor: number;
  expectedToDateMinor: number;
  projectedMinor: number;
  requiredDailyMinor: number | null;
  currentDailyRateMinor: number;
  remainingActiveDays: number;
  pacingPct: number | null;
}

/** A campaign's own budget for the current month, when it has one. */
export interface CampaignBudget {
  status: PacingStatus;
  currentDailyRateMinor: number;
  requiredDailyMinor: number | null;
}

export interface AiContextInput {
  clientName: string;
  currency: string;
  isDemo: boolean;
  rangeLabel: string;
  range: { from: string; to: string };
  comparison: { from: string; to: string } | null;
  kpis: KpiKey[];
  totals: MetricTotals;
  previous: MetricTotals | null;
  accounts: { platform: string; name: string; totals: MetricTotals | null; previousTotals?: MetricTotals | null; spendVerified: boolean; dataNote: string | null }[];
  campaigns: { name: string; platform: string; status: string; totals: MetricTotals; previous: MetricTotals | null; budget?: CampaignBudget | null }[];
  pacing: AiPacing | null;
  /** Final budget result when the reporting period is exactly a past budget month. */
  pastBudget?: { month: string; budgetMinor: number; spentMinor: number; status: PacingStatus } | null;
  notes: string[];
  /** Dated notes the agency logged (budget changes, launches, tracking fixes), within or near the period. */
  events?: { date: string; text: string }[];
  /** What the client wants from advertising; null/undefined = guessed from the data. */
  goal?: ClientGoal | null;
  /** The client's local today (for "So far in October"); defaults to the day after the range. */
  today?: string;
  /** The range ends so recently that platforms may still add late-counted results. */
  stillCounting?: boolean;
  /** Website, organic search and keyword ranking data for the same period, when those sources are connected. */
  web?: AiWebContext | null;
}

/** A metric's value now and in the comparison period, already formatted as the AI should quote it. */
export interface AiWebMetric {
  label: string;
  value: string;
  previous: string | null;
  /** Percent change vs the comparison period; null when either side is missing or zero. */
  changePct: number | null;
}

/** Non-ad sources: Google Analytics 4, Search Console and tracked keyword ranks. */
export interface AiWebContext {
  analytics: AiWebMetric[] | null;
  /** Visits and website goals by channel (e.g. "Organic Search", "Paid Search"). */
  channels: { channel: string; visits: AiWebMetric; goals: AiWebMetric }[];
  search: AiWebMetric[] | null;
  rankings: {
    tracked: number;
    inTop3: number;
    inTop10: number;
    improved: number;
    declined: number;
    changeDays: number;
    /** Biggest moves, best first; change is positions gained (+) or lost (-). */
    movers: { keyword: string; position: number | null; change: number }[];
  } | null;
}

const VERDICT_NOTE: Record<Verdict, string> = {
  better: " (favourable)",
  worse: " (unfavourable)",
  few: " (too few to compare)",
  same: " (about the same: normal variation)",
  counting: " (recent results are still being counted, so don't judge this change yet)",
  neutral: "",
};

const ACCOUNT_KPIS: KpiKey[] = ["spend", "impressions", "clicks", "ctr", "cpc", "conversions", "costPerConversion", "leads", "costPerLead", "roas"];
const CAMPAIGN_KPIS: KpiKey[] = ["spend", "clicks", "ctr", "conversions", "conversionRate", "costPerConversion", "leads", "costPerLead"];
const MAX_CAMPAIGNS = 25;

// Big increases read better as multiples ("3.2×") than as percentages ("+220%").
const pct = (p: number) => (Math.abs(p) < 0.05 ? "no change" : p >= 100 ? `${((100 + p) / 100).toFixed(1)}×` : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`);

function kpiLine(keys: KpiKey[], cur: MetricTotals, prev: MetricTotals | null, currency: string): string {
  return kpiValues(keys, cur, prev)
    .map((kv) => {
      const v = kv.value === null ? "not reported" : formatKpi(kv.key, kv.value, currency);
      const change = kv.changePct === null ? "" : ` (${pct(kv.changePct)} vs ${formatKpi(kv.key, kv.previous, currency)})`;
      return `${KPI_BY_KEY[kv.key].label}: ${v}${change}`;
    })
    .join("; ");
}

/** "Sep 1, 2026": dates in the data are written the way the AI should write them. */
const longDate = (d: string) => formatDate(d, { month: "short", day: "numeric", year: "numeric" });

export function buildAiContext(i: AiContextInput): string {
  const c = i.currency;
  const m = (v: number | null) => (v === null ? "n/a" : formatMoney(v, c, { whole: true }));
  const lines: string[] = [];
  lines.push(`Client: ${i.clientName}`);
  lines.push(`Currency: ${c}`);
  if (i.isDemo) lines.push("IMPORTANT: this client's accounts contain illustrative demo data, not real advertising results.");
  lines.push(`Reporting period: ${i.rangeLabel}, ${longDate(i.range.from)} to ${longDate(i.range.to)} (complete days only)`);
  lines.push(i.comparison ? `Comparison period: ${longDate(i.comparison.from)} to ${longDate(i.comparison.to)}` : "Comparison period: none");
  lines.push("");
  // The client's headline result, counted per ad account so nothing is counted twice.
  const accountTotals = i.accounts.map((a) => a.totals).filter((x): x is MetricTotals => !!x);
  const resolved = resolveGoal(i.goal, accountTotals.length ? accountTotals : i.totals, i.previous);
  const res = resultsFor(resolved.goal, accountTotals.length ? accountTotals : i.totals, resolved.guessed);
  const resultName = res.goal === "AWARENESS" ? "people who clicked" : res.label.toLowerCase();
  lines.push("## Results (lead with these)");
  lines.push(`- Goal: ${resolved.guessed ? `not set by the agency; treated as ${res.goal === "AWARENESS" ? "awareness" : res.goal === "SALES" ? "sales" : "results (conversions and leads)"} from the data` : resolved.goal.toLowerCase()}`);
  lines.push(`- ${resultName}: ${formatNumber(Math.round(res.value))}; cost per ${res.goal === "AWARENESS" ? "click" : res.singular}: ${res.costPerMinor === null ? "n/a" : formatMoney(Math.round(res.costPerMinor), c)}${res.valueMinor ? `; sales value credited by the ad platforms: ${formatMoney(res.valueMinor, c, { whole: true })}` : ""}`);
  if (i.stillCounting) lines.push("- Note: the period ended recently; ad platforms may still add results for the last few days, so result figures may rise.");
  lines.push("");
  lines.push("## Totals, all platforms");
  for (const kv of kpiValues(i.kpis, i.totals, i.previous, { stillCounting: i.stillCounting })) {
    const def = KPI_BY_KEY[kv.key];
    const v = kv.value === null ? "not reported" : formatKpi(kv.key, kv.value, c);
    const prev = i.previous ? `; comparison ${kv.previous === null ? "not reported" : formatKpi(kv.key, kv.previous, c)}` : "";
    const change = kv.changePct === null ? "" : `; change ${pct(kv.changePct)}${kv.verdict ? VERDICT_NOTE[kv.verdict] : ""}`;
    lines.push(`- ${def.label}: ${v}${prev}${change}`);
  }
  if (i.totals.hasEstimatedCost) lines.push("- Note: spend includes estimated Local Services Ads cost.");
  if (hasPlaceholderValues(i.totals)) lines.push("- Note: conversion value is exactly 1 per conversion, the ad platform's default when no values are set, so conversion value and ROAS don't reflect revenue. Don't present them as results.");

  lines.push("", "## By ad account");
  if (i.accounts.length === 0) lines.push("- No ad accounts connected.");
  for (const a of i.accounts) {
    const body = a.totals ? kpiLine(ACCOUNT_KPIS, a.totals, null, c) : "no data in this period";
    lines.push(`- ${a.platform} · ${a.name}: ${body}${a.spendVerified ? "" : " [spend estimated or incomplete]"}${a.dataNote ? ` [${a.dataNote}]` : ""}`);
  }

  const campaigns = [...i.campaigns].sort((a, b) => b.totals.costMinor - a.totals.costMinor);
  lines.push("", `## Campaigns by spend${campaigns.length > MAX_CAMPAIGNS ? ` (top ${MAX_CAMPAIGNS} of ${campaigns.length})` : ""}`);
  if (campaigns.length === 0) lines.push("- No campaign spend in this period.");
  // Pre-computed comparisons with the whole report, so the model quotes them instead of doing arithmetic.
  const avgCpa = derive(i.totals).costPerConversionMinor;
  for (const cmp of campaigns.slice(0, MAX_CAMPAIGNS)) {
    const share = i.totals.costMinor > 0 ? `; share of spend: ${formatPct((cmp.totals.costMinor / i.totals.costMinor) * 100, 0)}` : "";
    const cpa = derive(cmp.totals).costPerConversionMinor;
    const ratio = cpa !== null && avgCpa ? cpa / avgCpa : null;
    const vsAvg =
      ratio === null ? "" : ratio >= 2 ? `; cost per conversion vs report average: ${ratio.toFixed(1)}× the average` : `; cost per conversion vs report average: ${formatPct(Math.abs(ratio - 1) * 100, 0)} ${ratio <= 1 ? "lower" : "higher"}`;
    const b = cmp.budget;
    const own = b ? `; own budget this month: ${STATUS_LABEL[b.status].toLowerCase()}, spending ${m(b.currentDailyRateMinor)} a day${b.requiredDailyMinor === null ? "" : ` against ${m(b.requiredDailyMinor)} a day needed to land on budget`}` : "";
    lines.push(`- ${cmp.name} (${cmp.platform}, ${cmp.status.toLowerCase()}): ${kpiLine(CAMPAIGN_KPIS, cmp.totals, cmp.previous, c)}${share}${vsAvg}${own}`);
  }

  lines.push("", "## Monthly budget pacing");
  const p = i.pacing;
  if (!p) lines.push("- No budget is set for the current month.");
  else {
    lines.push(`- Month: ${longDate(p.periodStart)} to ${longDate(p.periodEnd)}; data complete through ${p.asOf ? formatDate(p.asOf) : "no complete days yet"}`);
    lines.push(`- Budget ${m(p.budgetMinor)}; spent ${m(p.actualToDateMinor)}; expected by now ${m(p.expectedToDateMinor)}; pacing ${formatPct(p.pacingPct)} of expected`);
    lines.push(`- Status to date: ${STATUS_LABEL[p.status]}; month-end forecast: ${STATUS_LABEL[p.forecastStatus]}, projected ${m(p.projectedMinor)} (${p.projectedMinor >= p.budgetMinor ? "+" : "-"}${m(Math.abs(p.projectedMinor - p.budgetMinor))} vs budget)`);
    lines.push(`- Current daily rate (7-day): ${m(p.currentDailyRateMinor)}; required daily to land on budget: ${p.requiredDailyMinor === null ? "n/a" : `${m(p.requiredDailyMinor)} over ${p.remainingActiveDays} remaining days`}`);
  }

  if (i.pastBudget) {
    const b = i.pastBudget;
    lines.push("", `## Budget result for ${b.month} (the reporting period)`);
    lines.push(`- Budget ${m(b.budgetMinor)}; final spend ${m(b.spentMinor)} (${formatPct(b.budgetMinor ? (b.spentMinor / b.budgetMinor) * 100 : null, 0)} of budget); result: ${STATUS_LABEL[b.status]}`);
  }

  if (i.notes.length) {
    lines.push("", "## Data notes");
    for (const n of i.notes) lines.push(`- ${n}`);
  }
  if (i.events?.length) {
    lines.push("", "## Notes the agency logged (dated events; a change near one of these dates may be connected, but the note alone doesn't prove it)");
    for (const e of i.events) lines.push(`- ${e.date}: ${e.text}`);
  }
  if (i.web) {
    const w = i.web;
    const line = (x: AiWebMetric) => `${x.label}: ${x.value}${x.previous === null ? "" : `; comparison ${x.previous}`}${x.changePct === null ? "" : `; change ${pct(x.changePct)}`}`;
    lines.push("", "## Website and organic search (same period; from Google Analytics, Search Console and the rank tracker)");
    if (w.analytics) {
      lines.push("Website (Google Analytics 4, all traffic sources):");
      for (const x of w.analytics) lines.push(`- ${line(x)}`);
    } else lines.push("- Google Analytics is not connected for this client.");
    if (w.channels.length) {
      lines.push("Website visits and goals by channel:");
      for (const ch of w.channels) lines.push(`- ${ch.channel}: visits ${ch.visits.value}${ch.visits.changePct === null ? "" : ` (${pct(ch.visits.changePct)})`}; website goals ${ch.goals.value}${ch.goals.changePct === null ? "" : ` (${pct(ch.goals.changePct)})`}`);
    }
    if (w.search) {
      lines.push("Google organic search (Search Console):");
      for (const x of w.search) lines.push(`- ${line(x)}`);
    } else lines.push("- Search Console is not connected for this client.");
    const r = w.rankings;
    if (r && r.tracked > 0) {
      lines.push(`Tracked keyword rankings (${r.tracked} keywords): ${r.inTop3} in the top 3, ${r.inTop10} in the top 10; over the last ${r.changeDays} days ${r.improved} moved up and ${r.declined} moved down.`);
      for (const m of r.movers) lines.push(`- "${m.keyword}": now ${m.position === null ? "not in the top 100" : `position ${m.position}`} (${m.change > 0 ? `up ${m.change}` : `down ${-m.change}`} positions)`);
    } else lines.push("- No keyword rankings are tracked for this client.");
    lines.push("Website goals are key events counted by Google Analytics; ad conversions are counted by each ad platform. They overlap, so never add them together.");
  }

  lines.push("", "## What the metrics mean (use these plain explanations when you mention a metric)");
  for (const k of [...new Set([...i.kpis, ...ACCOUNT_KPIS, ...CAMPAIGN_KPIS])]) lines.push(`- ${KPI_BY_KEY[k].label}: ${KPI_BY_KEY[k].plain}`);
  lines.push("", "Conversions and conversion value are reported by each platform under its own attribution settings; platforms count them differently.");
  return lines.join("\n");
}
