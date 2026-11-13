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

/**
 * One summary, three questions: What happened? What does this mean? What
 * should we do next? `takeaway` is the one- or two-sentence headline shown
 * while the summary is collapsed; it is never repeated in the sections.
 */
/** One traffic source's update (Google Ads, Meta Ads, Local Services Ads, organic search, website traffic, calls…). */
export interface ChannelUpdate {
  channel: string;
  update: string;
}

export interface ExecutiveSummaryContent {
  takeaway: string;
  /** What happened? 2–4 sentences, overall. */
  happened: string;
  /** By channel: one short update per traffic source the client tracks, in a fixed order. */
  channels?: ChannelUpdate[];
  /** What does this mean? 2–4 sentences, plain English. */
  meaning: string;
  /** What should we do next? For the agency: at most three, most important first. Internal views only. */
  recommendations: string[];
  /** The same in agency voice ("We'll…") for client-facing copies; may be empty (then hidden). */
  nextSteps: string[];
}

export const MAX_STEPS = 3;
export const SUMMARY_TITLES = { notes: "Updates from our team", channels: "By channel", happened: "What happened?", meaning: "What does this mean?", next: "What should we do next?" } as const;

/** A summary with the agency's own notes (shown under the takeaway). */
export type SummaryWithNotes = ExecutiveSummaryContent & { notes?: string };

/** First sentence of a paragraph, and the rest. */
export function splitFirstSentence(text: string): [string, string] {
  const t = text.trim();
  const m = /^(.+?[.!?])(\s+|$)([\s\S]*)$/.exec(t);
  return m ? [m[1].trim(), m[3].trim()] : [t, ""];
}

/**
 * Reads a summary saved in the earlier format (overview, what's working,
 * what needs attention, recommendations) as the three questions, so approved
 * summaries keep showing until someone regenerates them.
 */
export function fromLegacySummary(s: { overview: string; working: string[]; notWorking: string[]; recommendations: string[]; nextSteps?: string[] }): ExecutiveSummaryContent {
  const paras = s.overview.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const [takeaway, rest] = splitFirstSentence(paras[0] ?? "");
  const findings: string[] = [];
  for (let i = 0; i < Math.max(s.working.length, s.notWorking.length) && findings.length < 2; i++) {
    if (s.working[i]) findings.push(s.working[i]);
    if (s.notWorking[i] && findings.length < 2) findings.push(s.notWorking[i]);
  }
  return {
    takeaway,
    happened: [rest, ...paras.slice(1)].filter(Boolean).join(" "),
    meaning: findings.join(" "),
    recommendations: s.recommendations.slice(0, MAX_STEPS),
    nextSteps: (s.nextSteps ?? []).slice(0, MAX_STEPS),
  };
}

/**
 * The automatic summary (no AI): the headline result as the takeaway, the
 * rest of the figures as what happened, the two strongest findings as what
 * it means, and up to three recommendations.
 */
/** Channel names as clients read them (Google LSA → Local Services Ads). */
export const channelName = (platformLabel: string) => (platformLabel === "Google LSA" ? "Local Services Ads" : platformLabel);

/**
 * One plain sentence per ad platform from the figures: spend, results and
 * what each cost, against the comparison period. Leads for platforms that
 * report them, otherwise results; missing figures are said, never shown as 0.
 */
export function autoChannelUpdates(i: AiContextInput): ChannelUpdate[] {
  const c = i.currency;
  const money = (v: number) => formatMoney(v, c, { whole: v >= 10000 });
  const groups = new Map<string, { cur: MetricTotals[]; prev: MetricTotals[]; missing: boolean }>();
  for (const a of i.accounts) {
    const g = groups.get(a.platform) ?? { cur: [], prev: [], missing: false };
    if (a.totals) g.cur.push(a.totals);
    else g.missing = true;
    if (a.previousTotals) g.prev.push(a.previousTotals);
    groups.set(a.platform, g);
  }
  const sum = (xs: MetricTotals[]) => xs.reduce((t, x) => ({ cost: t.cost + x.costMinor, conv: t.conv + x.conversions, leads: t.leads + x.leads, clicks: t.clicks + x.clicks }), { cost: 0, conv: 0, leads: 0, clicks: 0 });
  const out: ChannelUpdate[] = [];
  for (const [platform, g] of groups) {
    const channel = channelName(platform);
    if (!g.cur.length) {
      out.push({ channel, update: "No figures were reported for this period yet." });
      continue;
    }
    const t = sum(g.cur);
    const p = g.prev.length ? sum(g.prev) : null;
    if (t.cost === 0 && t.clicks === 0) {
      out.push({ channel, update: "No ad activity in this period." });
      continue;
    }
    const useLeads = t.leads > 0 && t.leads >= t.conv;
    const n = useLeads ? t.leads : t.conv;
    const noun = useLeads ? "lead" : "result";
    const parts = [`${money(t.cost)} spent`];
    if (n > 0) parts.push(`${formatNumber(n, n < 10 && n % 1 ? 1 : 0)} ${noun}${n === 1 ? "" : "s"} at about ${formatMoney(Math.round(t.cost / n), c)} each`);
    else parts.push(`no ${noun}s were reported, so for now it can only be judged on its ${formatNumber(t.clicks)} clicks`);
    let s = `${parts.join(", ")}.`;
    const pn = p ? (useLeads ? p.leads : p.conv) : 0;
    if (p && n > 0 && pn > 0) {
      const d = pctChange(n, pn);
      if (d !== null && n >= MIN_SAMPLE && pn >= MIN_SAMPLE) s += Math.abs(d) < MIN_CHANGE_PCT ? ` About the same number of ${noun}s as the previous period.` : ` That's ${d > 0 ? "more" : "fewer"} ${noun}s than the previous period (${formatNumber(pn, 0)} before).`;
    }
    if (g.missing) s += " One account hasn't reported figures yet.";
    out.push({ channel, update: s });
  }
  return out;
}

export function autoExecutiveSummary(i: AiContextInput): ExecutiveSummaryContent {
  const { working, notWorking, recommendations, nextSteps } = analyzePerformance(i);
  const paras = autoOverview(i).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const [takeaway, rest] = splitFirstSentence(paras[0] ?? "");
  const findings = [notWorking[0], working[0]].filter((x): x is string => !!x);
  return {
    takeaway,
    happened: [rest, ...paras.slice(1)].filter(Boolean).join(" "),
    ...(i.accounts.length > 1 || new Set(i.accounts.map((a) => a.platform)).size > 1 ? { channels: autoChannelUpdates(i) } : {}),
    meaning: findings.join(" ") || "There isn't enough data in this period to draw a firm conclusion yet.",
    recommendations: recommendations.slice(0, MAX_STEPS),
    nextSteps: nextSteps.slice(0, MAX_STEPS),
  };
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

// --- Sections and email-ready copies ----------------------------------------

export interface SummarySection {
  title: string;
  /** Prose (What happened? / What does this mean?). */
  text?: string;
  /** Labelled updates (By channel). */
  labelled?: { label: string; text: string }[];
  /** Steps (What should we do next?). */
  items: string[];
  numbered: boolean;
}

/**
 * The expanded summary: What happened?, What does this mean?, What should we
 * do next?. Client-facing copies show the agency's approved "What we're
 * doing next" steps instead of recommendations (the section is left out when
 * there are none). The takeaway isn't part of it, so nothing is said twice.
 */
export function summaryOutline(s: ExecutiveSummaryContent, clientFacing: boolean): SummarySection[] {
  const steps = (clientFacing ? s.nextSteps : s.recommendations).slice(0, MAX_STEPS);
  const out: SummarySection[] = [];
  if (s.happened.trim()) out.push({ title: SUMMARY_TITLES.happened, text: s.happened.trim(), items: [], numbered: false });
  const channels = (s.channels ?? []).filter((c) => c.channel.trim() && c.update.trim());
  if (channels.length) out.push({ title: SUMMARY_TITLES.channels, labelled: channels.map((c) => ({ label: c.channel.trim(), text: c.update.trim() })), items: [], numbered: false });
  if (s.meaning.trim()) out.push({ title: SUMMARY_TITLES.meaning, text: s.meaning.trim(), items: [], numbered: false });
  if (steps.length) out.push({ title: SUMMARY_TITLES.next, items: steps, numbered: true });
  return out;
}

/** Plain text for pasting into any email client: the takeaway as the opening line, then the three sections. */
export function summaryAsText(s: SummaryWithNotes, heading: string, opts: { clientFacing?: boolean } = {}): string {
  const out = [heading, "", s.takeaway.trim(), ""];
  if (s.notes?.trim()) out.push(SUMMARY_TITLES.notes, s.notes.trim(), "");
  for (const sec of summaryOutline(s, !!opts.clientFacing)) {
    out.push(sec.title);
    if (sec.text) out.push(sec.text);
    for (const l of sec.labelled ?? []) out.push(`${l.label}: ${l.text}`);
    out.push(...sec.items.map((x, i) => `${i + 1}. ${x}`), "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Simple inline-styled HTML that keeps its formatting when pasted into Gmail or Outlook. */
export function summaryAsHtml(s: SummaryWithNotes, heading: string, opts: { clientFacing?: boolean } = {}): string {
  const p = "margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;";
  const h = "margin:16px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#1f2328;";
  const li = "margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;";
  const parts = [`<p style="${h}margin-top:0;font-size:16px;">${esc(heading)}</p>`];
  if (s.takeaway.trim()) parts.push(`<p style="${p}">${esc(s.takeaway.trim())}</p>`);
  if (s.notes?.trim()) parts.push(`<p style="${h}">${SUMMARY_TITLES.notes}</p>`, ...s.notes.trim().split(/\n{2,}/).map((x) => `<p style="${p}">${esc(x.trim()).replace(/\n/g, "<br>")}</p>`));
  for (const sec of summaryOutline(s, !!opts.clientFacing)) {
    parts.push(`<p style="${h}">${esc(sec.title)}</p>`);
    if (sec.text) parts.push(`<p style="${p}">${esc(sec.text)}</p>`);
    for (const l of sec.labelled ?? []) parts.push(`<p style="${p}"><strong>${esc(l.label)}:</strong> ${esc(l.text)}</p>`);
    if (sec.items.length) parts.push(`<ol style="margin:0 0 12px;padding-left:22px;">${sec.items.map((x) => `<li style="${li}">${esc(x)}</li>`).join("")}</ol>`);
  }
  return `<div>${parts.join("")}</div>`;
}
