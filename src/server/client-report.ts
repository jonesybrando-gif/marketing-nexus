import "server-only";
import { prisma } from "./db";
import { loadPacing } from "./pacing-service";
import { getClientPerformance } from "./reporting";
import { getClientTemplate } from "./report-templates";
import { comparisonRange, resolveRange, type CompareMode, type RangePreset } from "@/lib/date-ranges";
import { addDays, dateToIso, isoToDate, maxDate, minDate, monthBounds, todayInTimeZone } from "@/lib/pacing/dates";
import { linkedSources } from "./dashboards/sources";
import { isPaidCallSource } from "@/lib/call-sources";
import { resolveGoal, resultsFor, stillCounting, type Results } from "@/lib/results";
import type { DateRange } from "@/lib/date-ranges";

const PRESETS: RangePreset[] = ["mtd", "last_month", "last_7", "last_30", "last_90", "custom"];
const COMPARE: CompareMode[] = ["previous_period", "previous_month", "none"];

export interface ChartNoteInfo {
  id: string;
  date: string;
  text: string;
  clientVisible: boolean;
  authorId: string | null;
  taggedUserId: string | null;
}

export interface ReportParams {
  range?: string;
  compare?: string;
  from?: string;
  to?: string;
  /** Ad account filter: comma-separated AdAccount ids. Omitted = all paid media accounts. */
  accounts?: string;
}

/**
 * Which ad accounts the report adds up. Default: every account in the
 * client's reporting currency (amounts in different currencies are never
 * added together). `accounts` narrows it to the chosen ones; choosing only
 * accounts in another currency reports in that currency.
 */
export function resolveAccountScope<A extends { id: string; currency: string }>(accounts: A[], clientCurrency: string, param: string | undefined) {
  const wanted = (param ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const picked = wanted.length ? accounts.filter((a) => wanted.includes(a.id)) : [];
  const filtered = picked.length > 0;
  const base = filtered ? picked : accounts;
  const currencies = [...new Set(base.map((a) => a.currency))];
  const currency = base.length === 0 ? clientCurrency : currencies.includes(clientCurrency) ? clientCurrency : currencies.sort()[0];
  const inScope = base.filter((a) => a.currency === currency);
  const otherCurrency = base.filter((a) => a.currency !== currency);
  return {
    /** Accounts added up in this report. */
    accounts: inScope,
    /** True when the user picked accounts (not the default "all"). */
    filtered,
    /** Ids passed to the performance query; null = no restriction needed. */
    ids: filtered || otherCurrency.length ? inScope.map((a) => a.id) : null,
    currency,
    /** Accounts left out because they report in a different currency. */
    otherCurrency,
  };
}

/** Client, template and the resolved date ranges: cheap, and needed by everything else. */
async function loadReportBase(clientId: string, params: ReportParams, now: Date) {
  const client = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    include: { accounts: { include: { campaigns: { where: { excludedAt: null } }, syncRuns: { orderBy: { startedAt: "desc" }, take: 1 } }, orderBy: { platform: "asc" } } },
  });
  const today = todayInTimeZone(client.timezone, now);
  const { template, custom: hasCustomTemplate } = await getClientTemplate(client.agencyId, clientId);
  // The template sets the default range and comparison; the URL can override both.
  const preset: RangePreset = PRESETS.includes(params.range as RangePreset) ? (params.range as RangePreset) : template.defaultRange;
  const compareMode: CompareMode = COMPARE.includes(params.compare as CompareMode) ? (params.compare as CompareMode) : template.compare;
  let range;
  try {
    range = resolveRange(preset, today, { from: params.from, to: params.to });
  } catch {
    range = resolveRange(template.defaultRange, today);
  }
  const cmpRange = comparisonRange(range, compareMode);
  const scope = resolveAccountScope(client.accounts, client.currency, params.accounts);
  // The figures (tiles, charts, summary, comparisons) add up only the accounts in scope; the
  // account list itself stays complete (settings, sync status), and accounts outside the scope
  // simply have no rows in the figures.
  const scopedClient = { ...client, currency: scope.currency };
  const accountScope = {
    filtered: scope.filtered,
    ids: scope.ids,
    all: client.accounts.map((a) => ({ id: a.id, name: a.name, platform: a.platform, currency: a.currency })),
    selected: scope.filtered ? scope.accounts.map((a) => a.id) : [],
    otherCurrency: scope.otherCurrency.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
  };
  return { client: scopedClient, today, preset, compareMode, range, cmpRange, template, hasCustomTemplate, accountScope };
}

type ReportBase = Awaited<ReturnType<typeof loadReportBase>>;

/** The data-heavy part: performance for the range and comparison, budget history and chart notes. */
async function loadReportDetail(base: ReportBase, now: Date) {
  const { client, today, range, cmpRange, accountScope } = base;
  const ids = accountScope.ids ?? undefined;
  const clientId = client.id;
  // The three previous months for budget history.
  const historyDates = [1, 2, 3].map((n) => {
    let d = monthBounds(today).start;
    for (let i = 0; i < n; i++) d = monthBounds(addDays(d, -1)).start;
    return d;
  });
  const month = monthBounds(today);
  const [history, perf, cmpPerf, noteRows, callsFromAds] = await Promise.all([
    Promise.all(historyDates.map((d) => loadPacing({ id: clientId }, now, d).then((r) => r[0]))),
    getClientPerformance(clientId, range, ids),
    cmpRange ? getClientPerformance(clientId, cmpRange, ids) : Promise.resolve(null),
    // Chart notes for the report range and the current budget period.
    prisma.chartNote.findMany({
      where: { clientId, date: { gte: isoToDate(minDate(range.from, month.start)), lte: isoToDate(maxDate(range.to, month.end)) } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
    loadCallsFromAds(clientId, range, cmpRange),
  ]);
  const notes: ChartNoteInfo[] = noteRows.map((n) => ({ id: n.id, date: dateToIso(n.date), text: n.text, clientVisible: n.clientVisible, authorId: n.authorId, taggedUserId: n.taggedUserId }));
  return { history, perf, cmpPerf, notes, callsFromAds };
}

/** Calls whose CallRail source or medium is a paid ad, in a range. */
async function paidCalls(clientId: string, r: DateRange): Promise<number> {
  const rows = await prisma.callRecord.groupBy({
    by: ["source", "medium"],
    where: { clientId, date: { gte: isoToDate(r.from), lte: isoToDate(r.to) } },
    _count: { _all: true },
  });
  return rows.filter((x) => isPaidCallSource(x.source, x.medium)).reduce((n, x) => n + x._count._all, 0);
}

/**
 * "Calls from ads (CallRail)", a supporting figure next to Results when
 * CallRail is linked. Never added into Results: ad platforms usually count
 * the same calls. Null when CallRail isn't linked (or the lookup fails: it
 * must never break the report).
 */
async function loadCallsFromAds(clientId: string, range: DateRange, cmpRange: DateRange | null): Promise<{ current: number; previous: number | null } | null> {
  try {
    if (!(await linkedSources(clientId)).includes("callrail")) return null;
    const [current, previous] = await Promise.all([paidCalls(clientId, range), cmpRange ? paidCalls(clientId, cmpRange) : Promise.resolve(null)]);
    return { current, previous };
  } catch (e) {
    console.error("Calls from ads: lookup failed", e);
    return null;
  }
}

/**
 * Everything a client report needs, shared by the client page, the PDF and
 * the CSV export so they always show identical numbers. Callers must check
 * that the user may view the client first.
 */
export async function loadClientReport(clientId: string, params: ReportParams, now: Date = new Date()) {
  const base = await loadReportBase(clientId, params, now);
  const [[pacing], detail] = await Promise.all([loadPacing({ id: clientId }, now), loadReportDetail(base, now)]);
  return { ...base, pacing, ...detail };
}

/**
 * The quick part of a client report (client, template, ranges and current
 * pacing): enough for the client page header, so the page can stream while
 * `completeClientReport` loads the rest. Same access rule as loadClientReport.
 */
export async function loadClientReportHead(clientId: string, params: ReportParams, now: Date = new Date()) {
  const [base, [pacing]] = await Promise.all([loadReportBase(clientId, params, now), loadPacing({ id: clientId }, now)]);
  return { ...base, pacing };
}

export type ClientReportHead = Awaited<ReturnType<typeof loadClientReportHead>>;

/** Loads the rest of a report started with loadClientReportHead (pass the same `now`). */
export async function completeClientReport(head: ClientReportHead, now: Date): Promise<ClientReport> {
  return { ...head, ...(await loadReportDetail(head, now)) };
}

export type ClientReport = Awaited<ReturnType<typeof loadClientReport>>;

/**
 * The report's Results (see src/lib/results.ts) for the range and the
 * comparison, counted per ad account so nothing is counted twice. The goal is
 * the client's, or guessed from both periods.
 */
export function reportResults(rep: Pick<ClientReport, "client" | "perf" | "cmpPerf" | "range" | "today">): { current: Results; previous: Results | null; stillCounting: boolean } {
  const lines = (p: ClientReport["perf"]) => {
    const l = rep.client.accounts.map((a) => p.byAccount[a.id]).filter((x) => !!x);
    return l.length ? l : [p.totals];
  };
  const cur = lines(rep.perf);
  const prev = rep.cmpPerf ? lines(rep.cmpPerf) : null;
  const g = resolveGoal(rep.client.goal, cur, prev);
  return { current: resultsFor(g.goal, cur, g.guessed), previous: prev ? resultsFor(g.goal, prev, g.guessed) : null, stillCounting: stillCounting(rep.range.to, rep.today) };
}
