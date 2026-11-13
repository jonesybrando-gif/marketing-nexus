// The automatic executive summary: plain sentences built directly from the
// report's figures for the selected date range, plus what's working, what
// isn't and recommendations. Used when the AI assistant isn't set up or the
// layout asks for it, and while an AI version is written.

import type { AiContextInput } from "./ai-context";
import { analyzePerformance } from "./insights";
import { derive, pctChange, type MetricTotals } from "./metrics";
import { formatMoney, formatNumber, formatPct } from "./money";
import { STATUS_LABEL } from "./pacing/status";
import { addDays } from "./pacing/dates";
import { formatDate } from "./time";
import { hasPlaceholderValues, resolveGoal, resultsFor } from "./results";
import { MIN_CHANGE_PCT, MIN_SAMPLE } from "./change";
import { headlineSentence } from "./at-a-glance";

/** " (up 7%)", " (about the same)", or "" when there is nothing to compare or too few to compare. */
const change = (cur: number | null, prev: number | null | undefined, sample?: [number, number]) => {
  if (cur === null || prev === null || prev === undefined) return "";
  if (sample && (sample[0] < MIN_SAMPLE || sample[1] < MIN_SAMPLE)) return "";
  const p = pctChange(cur, prev);
  if (p === null) return "";
  return Math.abs(p) < MIN_CHANGE_PCT ? " (about the same as the previous period)" : ` (${p > 0 ? "up" : "down"} ${formatPct(Math.abs(p), 0)})`;
};

export interface ExecutiveSummaryContent {
  /** One or two paragraphs, separated by a blank line. */
  overview: string;
  working: string[];
  notWorking: string[];
  /** For the agency: what to change. Internal views only. */
  recommendations: string[];
  /** The same in agency voice ("We'll…") for client-facing reports; may be empty (then hidden). */
  nextSteps: string[];
}

export function autoExecutiveSummary(i: AiContextInput): ExecutiveSummaryContent {
  const { working, notWorking, recommendations, nextSteps } = analyzePerformance(i);
  return { overview: autoOverview(i), working, notWorking, recommendations, nextSteps };
}

/** Results for an AI context input: per ad account when available, so nothing is counted twice. */
export function contextResults(i: AiContextInput) {
  const lines = i.accounts.map((a) => a.totals).filter((x): x is MetricTotals => !!x);
  const cur = lines.length ? lines : i.totals;
  // The comparison is counted the same way (per account) when per-account figures exist.
  const prevLines = i.accounts.map((a) => a.previousTotals).filter((x): x is MetricTotals => !!x);
  const prev = i.previous ? (prevLines.length ? prevLines : i.previous) : null;
  const g = resolveGoal(i.goal, cur, prev);
  return { current: resultsFor(g.goal, cur, g.guessed), previous: prev ? resultsFor(g.goal, prev, g.guessed) : null };
}

/** The headline paragraphs: results for the period first, then what drove them, and the budget. */
export function autoOverview(i: AiContextInput): string {
  const c = i.currency;
  const money = (v: number) => formatMoney(v, c, { whole: v >= 10000 });
  const t = i.totals;
  const p = i.previous;
  const d = derive(t);
  const span = `${formatDate(i.range.from)} – ${formatDate(i.range.to, { month: "short", day: "numeric", year: "numeric" })}`;
  const demo = i.isDemo ? "These figures are illustrative demo data. " : "";

  if (t.costMinor === 0 && t.impressions === 0 && t.clicks === 0 && t.conversions === 0 && t.leads === 0) {
    return `${demo}No advertising activity was recorded for ${i.clientName} from ${span}.`;
  }

  // Paragraph 1: results first, then reach.
  const p1: string[] = [];
  const res = contextResults(i);
  const { driver } = analyzePerformance(i);
  p1.push(
    headlineSentence({
      range: i.range,
      comparison: i.comparison,
      today: i.today ?? addDays(i.range.to, 1),
      currency: c,
      results: res.current,
      previous: res.previous,
      stillCounting: i.stillCounting,
      driver,
    }),
  );
  const awareness = res.current.goal === "AWARENESS";
  if (awareness && res.current.guessed && t.costMinor > 0) p1.push("No conversions or leads were reported, so for now the ads can only be judged on clicks.");
  const clicks = `clicked ${formatNumber(t.clicks)} time${t.clicks === 1 ? "" : "s"}${change(t.clicks, p?.clicks, p ? [t.clicks, p.clicks] : undefined)}`;
  if (t.impressions > 0) p1.push(`${i.clientName}'s ads were shown ${formatNumber(t.impressions)} times and ${clicks}.`);
  else if (t.clicks > 0 && !awareness) p1.push(`${i.clientName}'s ads were ${clicks}.`);
  if (d.roas !== null && !hasPlaceholderValues(t)) {
    const per = `${formatMoney(Math.round(d.roas * 100), c)} in sales for every ${formatMoney(100, c, { whole: true })} spent`;
    p1.push(res.current.valueMinor ? `That is ${per}, as credited by the ad platforms (this is not profit).` : `Ad platforms credited your ads with ${money(t.conversionValueMinor)} in sales, or ${per} (this is not profit).`);
  }
  if (t.hasEstimatedCost) p1.push("Spend includes an estimate for Google Local Services ads.");
  if (i.stillCounting) p1.push("The last few days may still rise as ad platforms finish counting results.");

  // Paragraph 2: what drove it, and the budget.
  const p2: string[] = [];
  const top = [...i.campaigns].sort((a, b) => b.totals.costMinor - a.totals.costMinor)[0];
  if (top && i.campaigns.length > 1) {
    const share = t.costMinor ? (top.totals.costMinor / t.costMinor) * 100 : 0;
    const res = top.totals.conversions > 0 ? ` and ${formatNumber(top.totals.conversions, top.totals.conversions < 100 ? 1 : 0)} conversions` : top.totals.leads > 0 ? ` and ${formatNumber(top.totals.leads)} leads` : "";
    p2.push(`The largest campaign was ${top.name} on ${top.platform}, with ${money(top.totals.costMinor)} (${formatPct(share, 0)} of spend)${res}.`);
  }
  if (i.pastBudget) {
    const b = i.pastBudget;
    p2.push(`${b.month} finished at ${money(b.spentMinor)} against a ${money(b.budgetMinor)} budget (${formatPct(b.budgetMinor ? (b.spentMinor / b.budgetMinor) * 100 : null, 0)}).`);
  } else if (i.pacing && i.range.to >= i.pacing.periodStart) {
    const pc = i.pacing;
    const month = formatDate(pc.periodStart, { month: "long" });
    const where = pc.status === "ON_TARGET" ? "on plan" : pc.status.includes("OVER") ? "ahead of plan" : pc.status.includes("UNDER") ? "behind plan" : STATUS_LABEL[pc.status].toLowerCase();
    p2.push(`For ${month}, ${money(pc.actualToDateMinor)} of the ${money(pc.budgetMinor)} budget has been spent${pc.asOf ? ` through ${formatDate(pc.asOf)}` : ""}, ${where}; at the current pace the month would end around ${money(pc.projectedMinor)} (estimate).`);
  }
  return [demo + p1.filter(Boolean).join(" "), p2.join(" ")].filter((x) => x.trim()).join("\n\n");
}

// --- Email-ready copies -----------------------------------------------------

type SummaryLists = Partial<ExecutiveSummaryContent> & Pick<ExecutiveSummaryContent, "working" | "notWorking" | "recommendations">;

export interface SummarySection {
  title: string;
  items: string[];
  numbered: boolean;
}

/** Good news and problems, alternating, so a short list shows both sides. */
function interleave(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

export const OVERVIEW_TITLE = "Performance overview";

/**
 * The summary's sections after the overview: "What the data tells us" (what's
 * working and what needs attention, together) and "Recommended next steps"
 * (most important first). Client-facing copies show the agency's approved
 * "What we're doing next" in place of recommendations, or nothing when there
 * are none. `limit` trims each list for the compact view.
 */
export function summaryOutline(s: SummaryLists, clientFacing: boolean, limit?: number): SummarySection[] {
  const cap = (xs: string[]) => (limit ? xs.slice(0, limit) : xs);
  const insights = interleave(s.working ?? [], s.notWorking ?? []);
  const steps = clientFacing ? s.nextSteps ?? [] : s.recommendations ?? [];
  return [
    { title: "What the data tells us", items: cap(insights), numbered: false },
    { title: clientFacing ? "What we're doing next" : "Recommended next steps", items: cap(steps), numbered: !clientFacing },
  ].filter((sec) => sec.items.length > 0);
}

/** Plain text for pasting into any email client. */
export function summaryAsText(s: Partial<ExecutiveSummaryContent> & Pick<ExecutiveSummaryContent, "overview" | "working" | "notWorking" | "recommendations">, heading: string, opts: { clientFacing?: boolean } = {}): string {
  const out = [heading, "", OVERVIEW_TITLE, ...s.overview.split(/\n{2,}/).flatMap((p) => [p.trim(), ""])];
  for (const sec of summaryOutline(s, !!opts.clientFacing)) {
    out.push(sec.title, ...sec.items.map((x, i) => `${sec.numbered ? `${i + 1}.` : "•"} ${x}`), "");
  }
  return out.join("\n").trim();
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Simple inline-styled HTML that keeps its formatting when pasted into Gmail or Outlook. */
export function summaryAsHtml(s: Partial<ExecutiveSummaryContent> & Pick<ExecutiveSummaryContent, "overview" | "working" | "notWorking" | "recommendations">, heading: string, opts: { clientFacing?: boolean } = {}): string {
  const p = "margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;";
  const h = "margin:16px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#1f2328;";
  const li = "margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;";
  const parts = [`<p style="${h}margin-top:0;font-size:16px;">${esc(heading)}</p>`, `<p style="${h}">${OVERVIEW_TITLE}</p>`, ...s.overview.split(/\n{2,}/).map((x) => `<p style="${p}">${esc(x.trim())}</p>`)];
  for (const sec of summaryOutline(s, !!opts.clientFacing)) {
    const tag = sec.numbered ? "ol" : "ul";
    parts.push(`<p style="${h}">${esc(sec.title)}</p>`, `<${tag} style="margin:0 0 12px;padding-left:22px;">${sec.items.map((x) => `<li style="${li}">${esc(x)}</li>`).join("")}</${tag}>`);
  }
  return `<div>${parts.join("")}</div>`;
}
