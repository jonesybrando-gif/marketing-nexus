import { displayCampaignName } from "@/lib/campaign-name";
import "server-only";
import { getClientPerformance, type ClientPerformance } from "../reporting";
import { metricBreakdown, metricSeries, metricTotals } from "../metrics/query";
import { callLog, formLog, keywordRankTable, type CallLogFn, type FormLogFn, type KeywordRankTableFn } from "./sources";
import type { ClientReport } from "../client-report";
import { comparisonRange, resolveRange, type CompareMode, type DateRange, type RangePreset } from "@/lib/date-ranges";
import { eachDay, type IsoDate } from "@/lib/pacing/dates";
import { dailyKpiValue, KPI_BY_KEY, kpiValues, type KpiKey } from "@/lib/kpis";
import type { MetricTotals } from "@/lib/metrics";
import type { DailyValue } from "@/lib/metrics-registry/aggregate";
import { DIMENSIONS, type MetricSource } from "@/lib/metrics-registry";
import { PLATFORM_LABEL, type PlatformKey } from "@/lib/platforms";
import { adKpiKey, changeOf, dimensionLabel, metricInfo, SOURCE_LABEL, sourceOf, type MetricInfo } from "@/lib/dashboards/metrics";
import type { DashboardWidget } from "@/lib/dashboards/types";
import type { DashboardData, WidgetData } from "@/lib/dashboards/widget-data";

// Resolves every widget of a dashboard for one client and date range (with
// comparison) into render-ready data. Ad KPIs ("ads.*") come from the ad
// report the page already loaded (src/server/client-report.ts); everything
// else from the metric query API (src/server/metrics/query.ts). Queries are
// batched: one totals and one series query per period, whatever the number of
// widgets.

export interface AdData {
  perf: ClientPerformance;
  cmpPerf: ClientPerformance | null;
  campaigns: { id: string; name: string }[];
  accounts: { id: string; name: string; platform: PlatformKey }[];
}

export interface ResolveContext {
  clientId: string;
  /** Client's local today, for widgets with their own range preset. */
  today: IsoDate;
  range: DateRange;
  cmpRange: DateRange | null;
  compareMode: CompareMode;
  /** The page's ad report; null when the client has no ad accounts. */
  ads: AdData | null;
  /** Sources linked to the client ("ads" = any ad account). */
  linked: MetricSource[];
  /** Agency staff (not a client login or shared link): sees call recordings. */
  staff?: boolean;
}

export interface ResolverDeps {
  metricTotals: typeof metricTotals;
  metricSeries: typeof metricSeries;
  metricBreakdown: typeof metricBreakdown;
  keywordRankTable: KeywordRankTableFn;
  callLog: CallLogFn;
  formLog: FormLogFn;
  adPerformance: (clientId: string, range: DateRange) => Promise<ClientPerformance>;
}

export const defaultResolverDeps: ResolverDeps = { metricTotals, metricSeries, metricBreakdown, keywordRankTable, callLog, formLog, adPerformance: getClientPerformance };

/** The ad part of a loaded client report, in the shape the resolver needs. */
export function adDataFromReport(rep: Pick<ClientReport, "perf" | "cmpPerf" | "client">): AdData | null {
  if (rep.client.accounts.length === 0) return null;
  return {
    perf: rep.perf,
    cmpPerf: rep.cmpPerf,
    campaigns: rep.client.accounts.flatMap((a) => a.campaigns.map((c) => ({ id: c.id, name: c.name }))),
    accounts: rep.client.accounts.map((a) => ({ id: a.id, name: a.name, platform: a.platform as PlatformKey })),
  };
}

export function contextFromReport(rep: ClientReport, linked: MetricSource[], staff = false): ResolveContext {
  return { clientId: rep.client.id, today: rep.today, range: rep.range, cmpRange: rep.cmpRange, compareMode: rep.compareMode, ads: adDataFromReport(rep), linked, staff };
}

interface Period {
  key: string;
  range: DateRange;
  cmp: DateRange | null;
}

const BREAKDOWN_LIMIT = 25;
const isBreakdown = (w: DashboardWidget) => w.kind === "table" || w.kind === "pie" || (w.kind === "bar" && !!w.dimension);
const isSeries = (w: DashboardWidget) => w.kind === "line" || w.kind === "area" || (w.kind === "bar" && !w.dimension);

function emptyFor(source: MetricSource | null, linked: MetricSource[], fallback = "No data for this period yet."): WidgetData {
  if (source && !linked.includes(source)) {
    const what = source === "ads" ? "an ad account" : source === "rank" ? "rank tracking" : SOURCE_LABEL[source];
    return { kind: "empty", reason: "not_connected", source, message: `Connect ${what} to see this` };
  }
  return { kind: "empty", reason: "no_data", source, message: fallback };
}

const FAILED: WidgetData = { kind: "empty", reason: "no_data", source: null, message: "This widget couldn't be loaded. Try again shortly." };

const unknownMetric = (key: string): WidgetData => ({
  kind: "empty",
  reason: "unknown_metric",
  source: null,
  message: `This metric (${key}) isn't available. Edit the widget to pick another.`,
});

/** Aligns daily values to every day of the range (missing days = null). */
function alignDaily(days: DailyValue[] | undefined, range: DateRange): (number | null)[] {
  const m = new Map((days ?? []).map((d) => [d.date, d.value]));
  return eachDay(range.from, range.to).map((d) => m.get(d) ?? null);
}

function adDaily(perf: ClientPerformance, k: KpiKey, range: DateRange): (number | null)[] {
  const m = new Map(perf.byDate.map((d) => [d.date, dailyKpiValue(d, k)]));
  return eachDay(range.from, range.to).map((d) => m.get(d) ?? null);
}

export async function resolveWidgets(widgets: DashboardWidget[], ctx: ResolveContext, deps: ResolverDeps = defaultResolverDeps): Promise<DashboardData> {
  const basePeriod: Period = { key: "base", range: ctx.range, cmp: ctx.cmpRange };
  const periods = new Map<string, Period>([["base", basePeriod]]);
  const periodOf = (w: DashboardWidget): Period => {
    if (!w.range) return basePeriod;
    const existing = periods.get(w.range);
    if (existing) return existing;
    let range: DateRange;
    try {
      range = resolveRange(w.range as RangePreset, ctx.today);
    } catch {
      return basePeriod;
    }
    const p = { key: w.range, range, cmp: comparisonRange(range, ctx.compareMode) };
    periods.set(w.range, p);
    return p;
  };

  // 1. Collect what each period needs.
  const totalsKeys = new Map<string, Set<string>>();
  const seriesKeys = new Map<string, Set<string>>();
  const adPeriods = new Set<string>();
  const add = (map: Map<string, Set<string>>, p: Period, k: string) => (map.get(p.key) ?? map.set(p.key, new Set()).get(p.key)!).add(k);
  for (const w of widgets) {
    const p = periodOf(w);
    for (const k of w.metrics ?? []) {
      if (adKpiKey(k)) {
        if (p.key !== "base") adPeriods.add(p.key);
        continue;
      }
      if (!metricInfo(k)) continue;
      if (w.kind === "kpi") {
        add(totalsKeys, p, k);
        add(seriesKeys, p, k);
      } else if (isSeries(w)) add(seriesKeys, p, k);
    }
    if ((w.kind === "pacing" || w.kind === "campaigns") && p.key !== "base") adPeriods.add(p.key);
  }

  // 2. Fetch in parallel.
  type Pair<T> = { cur: T; cmp: T | null };
  const totals = new Map<string, Pair<Record<string, number | null>>>();
  const series = new Map<string, Pair<Record<string, DailyValue[]>>>();
  const adPerf = new Map<string, Pair<ClientPerformance> | null>();
  if (ctx.ads) adPerf.set("base", { cur: ctx.ads.perf, cmp: ctx.ads.cmpPerf });
  const jobs: Promise<unknown>[] = [];
  for (const [pk, keys] of totalsKeys) {
    const p = periods.get(pk)!;
    const ks = [...keys];
    jobs.push(Promise.all([deps.metricTotals(ctx.clientId, ks, p.range.from, p.range.to), p.cmp ? deps.metricTotals(ctx.clientId, ks, p.cmp.from, p.cmp.to) : null]).then(([cur, cmp]) => totals.set(pk, { cur, cmp }), () => undefined));
  }
  for (const [pk, keys] of seriesKeys) {
    const p = periods.get(pk)!;
    const ks = [...keys];
    jobs.push(Promise.all([deps.metricSeries(ctx.clientId, ks, p.range.from, p.range.to), p.cmp ? deps.metricSeries(ctx.clientId, ks, p.cmp.from, p.cmp.to) : null]).then(([cur, cmp]) => series.set(pk, { cur, cmp }), () => undefined));
  }
  if (ctx.ads) {
    for (const pk of adPeriods) {
      const p = periods.get(pk)!;
      jobs.push(Promise.all([deps.adPerformance(ctx.clientId, p.range), p.cmp ? deps.adPerformance(ctx.clientId, p.cmp) : null]).then(([cur, cmp]) => adPerf.set(pk, { cur, cmp }), () => adPerf.set(pk, null)));
    }
  }
  const breakdowns = new Map<string, Promise<WidgetData>>();
  for (const w of widgets) if (isBreakdown(w)) breakdowns.set(w.id, resolveBreakdown(w, periodOf(w), ctx, deps).catch(() => FAILED));
  const rankings = new Map<string, Promise<WidgetData>>();
  for (const w of widgets) {
    if (w.kind !== "rankings") continue;
    const p = periodOf(w);
    rankings.set(
      w.id,
      deps.keywordRankTable(ctx.clientId, { from: p.range.from, to: p.range.to, compareTo: p.cmp?.to, limit: 50 }).then((rows): WidgetData =>
        rows.length ? { kind: "rankings", rows, hasComparison: !!p.cmp } : emptyFor("rank", ctx.linked, "No tracked keywords yet."),
      ).catch(() => FAILED),
    );
  }
  const logs = new Map<string, Promise<WidgetData>>();
  for (const w of widgets) {
    if (w.kind !== "calllog") continue;
    const p = periodOf(w);
    logs.set(
      w.id,
      deps.callLog(ctx.clientId, { from: p.range.from, to: p.range.to, limit: 100, staff: !!ctx.staff }).then((r): WidgetData =>
        r.rows.length ? { kind: "calllog", rows: r.rows, total: r.total, timeZone: r.timeZone } : emptyFor("callrail", ctx.linked, "No calls in this period."),
      ).catch(() => FAILED),
    );
  }
  for (const w of widgets) {
    if (w.kind !== "formlog") continue;
    const p = periodOf(w);
    logs.set(
      w.id,
      deps.formLog(ctx.clientId, { from: p.range.from, to: p.range.to, limit: 100 }).then((r): WidgetData =>
        r.rows.length ? { kind: "formlog", rows: r.rows, total: r.total, timeZone: r.timeZone } : emptyFor("callrail", ctx.linked, "No form submissions in this period."),
      ).catch(() => FAILED),
    );
  }
  await Promise.all(jobs);

  // 3. Build each widget.
  const out: DashboardData = {};
  for (const w of widgets) {
    const p = periodOf(w);
    try {
      out[w.id] = await buildWidget(w, p, ctx, { totals: totals.get(p.key), series: series.get(p.key), ad: adPerf.get(p.key) ?? null, breakdown: breakdowns.get(w.id), rankings: rankings.get(w.id), calllog: logs.get(w.id) });
    } catch {
      out[w.id] = FAILED;
    }
  }
  return out;
}

interface Loaded {
  totals?: { cur: Record<string, number | null>; cmp: Record<string, number | null> | null };
  series?: { cur: Record<string, DailyValue[]>; cmp: Record<string, DailyValue[]> | null };
  ad: { cur: ClientPerformance; cmp: ClientPerformance | null } | null;
  breakdown?: Promise<WidgetData>;
  rankings?: Promise<WidgetData>;
  calllog?: Promise<WidgetData>;
}

async function buildWidget(w: DashboardWidget, p: Period, ctx: ResolveContext, l: Loaded): Promise<WidgetData> {
  switch (w.kind) {
    case "text":
      return { kind: "text" };
    case "pacing":
    case "campaigns":
      return ctx.ads ? { kind: w.kind } : emptyFor("ads", ctx.linked);
    case "rankings":
      return l.rankings!;
    case "calllog":
    case "formlog":
      return l.calllog!;
    case "table":
    case "pie":
      return l.breakdown!;
    case "bar":
      if (w.dimension) return l.breakdown!;
      return buildSeries(w, p, ctx, l);
    case "line":
    case "area":
      return buildSeries(w, p, ctx, l);
    case "kpi":
      return buildKpi(w, p, ctx, l);
  }
}

function buildKpi(w: DashboardWidget, p: Period, ctx: ResolveContext, l: Loaded): WidgetData {
  const key = w.metrics?.[0] ?? "";
  const info = metricInfo(key);
  if (!info) return unknownMetric(key);
  const ad = adKpiKey(key);
  if (ad) {
    if (!l.ad) return emptyFor("ads", ctx.linked);
    const [kv] = kpiValues([ad], l.ad.cur.totals, l.ad.cmp?.totals ?? null);
    return { kind: "kpi", metric: info, value: kv.value, previous: kv.previous, changePct: kv.changePct, tone: kv.tone, verdict: kv.verdict, spark: adDaily(l.ad.cur, ad, p.range), hasComparison: !!l.ad.cmp };
  }
  const value = l.totals?.cur[key] ?? null;
  const previous = l.totals?.cmp?.[key] ?? null;
  const spark = alignDaily(l.series?.cur[key], p.range);
  if (value === null && spark.every((v) => v === null)) return emptyFor(info.source, ctx.linked);
  return { kind: "kpi", metric: info, value, previous, ...changeOf(value, previous, info.better, { format: info.format }), spark, hasComparison: !!p.cmp };
}

function buildSeries(w: DashboardWidget, p: Period, ctx: ResolveContext, l: Loaded): WidgetData {
  const keys = w.metrics ?? [];
  const infos = keys.map(metricInfo);
  const missing = keys.find((_, i) => !infos[i]);
  if (missing) return unknownMetric(missing);
  const metrics = infos as MetricInfo[];
  const dates = eachDay(p.range.from, p.range.to);
  const previousDates = p.cmp ? eachDay(p.cmp.from, p.cmp.to).slice(0, dates.length) : null;
  const current: Record<string, (number | null)[]> = {};
  const previous: Record<string, (number | null)[]> | null = p.cmp ? {} : null;
  for (const m of metrics) {
    const ad = adKpiKey(m.key);
    if (ad) {
      current[m.key] = l.ad ? adDaily(l.ad.cur, ad, p.range) : dates.map(() => null);
      if (previous && p.cmp) previous[m.key] = l.ad?.cmp ? adDaily(l.ad.cmp, ad, p.cmp).slice(0, dates.length) : dates.map(() => null);
    } else {
      current[m.key] = alignDaily(l.series?.cur[m.key], p.range);
      if (previous && p.cmp) previous[m.key] = alignDaily(l.series?.cmp?.[m.key], p.cmp).slice(0, dates.length);
    }
  }
  const hasData = metrics.some((m) => current[m.key].some((v) => v !== null && v !== 0) || (m.source === "ads" && l.ad));
  if (!hasData) {
    const unlinked = metrics.find((m) => !ctx.linked.includes(m.source));
    return emptyFor(unlinked?.source ?? metrics[0]?.source ?? null, ctx.linked, "No data for this period yet.");
  }
  return { kind: "series", metrics, dates, current, previous, previousDates };
}

async function resolveBreakdown(w: DashboardWidget, p: Period, ctx: ResolveContext, deps: ResolverDeps): Promise<WidgetData> {
  const keys = w.metrics ?? [];
  const infos = keys.map(metricInfo);
  const missing = keys.find((_, i) => !infos[i]);
  if (missing) return unknownMetric(missing);
  const metrics = infos as MetricInfo[];
  const source = metrics[0]?.source ?? sourceOf(keys[0] ?? "");
  const dim = w.dimension ?? "";
  const label = dimensionLabel(source, dim);
  if (source === "ads") {
    if (!ctx.ads) return emptyFor("ads", ctx.linked);
    const perf = p.key === "base" ? ctx.ads.perf : await deps.adPerformance(ctx.clientId, p.range);
    const items: { label: string; t: MetricTotals | undefined }[] =
      dim === "campaign"
        ? ctx.ads.campaigns.map((c) => ({ label: displayCampaignName(c.name), t: perf.byCampaign[c.id] }))
        : ctx.ads.accounts.map((a, _, all) => ({
            label: all.filter((b) => b.platform === a.platform).length > 1 ? `${PLATFORM_LABEL[a.platform]} · ${a.name}` : PLATFORM_LABEL[a.platform],
            t: perf.byAccount[a.id],
          }));
    if (dim !== "campaign" && dim !== "platform") return { kind: "empty", reason: "no_data", source, message: "Pick a breakdown for this widget." };
    const first = metrics[0];
    const dir = first.better === "down" ? 1 : -1;
    const rows = items
      .filter((it) => it.t && (it.t.costMinor > 0 || it.t.clicks > 0 || it.t.impressions > 0 || it.t.conversions > 0 || it.t.leads > 0))
      .map((it) => ({ label: it.label, values: Object.fromEntries(metrics.map((m) => [m.key, KPI_BY_KEY[adKpiKey(m.key)!].value(it.t!)])) }))
      .sort((a, b) => ((a.values[first.key] ?? (dir > 0 ? Infinity : -Infinity)) - (b.values[first.key] ?? (dir > 0 ? Infinity : -Infinity))) * dir)
      .slice(0, BREAKDOWN_LIMIT);
    if (!rows.length) return emptyFor("ads", ctx.linked, "No ad activity in this period.");
    return { kind: "breakdown", metrics, dimensionLabel: label, rows };
  }
  const ordered = DIMENSIONS.some((d) => d.source === source && d.dimension === dim && d.ordered);
  const table = await deps.metricBreakdown(ctx.clientId, dim, keys, p.range.from, p.range.to, ordered ? 100 : BREAKDOWN_LIMIT);
  if (!table.length) return emptyFor(source, ctx.linked);
  // Natural-order dimensions (weekday, hour) list every value in order; "1 Mon" shows as "Mon".
  const rows = ordered ? [...table].sort((a, b) => a.value.localeCompare(b.value)).map((r) => ({ ...r, value: r.value.replace(/^\d+ /, "") })) : table;
  return { kind: "breakdown", metrics, dimensionLabel: label, rows: rows.map((r) => ({ label: r.value || "(not set)", values: r.metrics })) };
}
