import "server-only";
import { prisma } from "../db";
import { isoToDate, dateToIso, type IsoDate } from "@/lib/pacing/dates";
import { METRIC_BY_KEY } from "@/lib/metrics-registry";
import { aggregateMetric, type DailyValue } from "@/lib/metrics-registry/aggregate";

// Read API for non-ad metrics stored in MetricDaily. Dashboards, reports and
// the AI assistant use these; never query MetricDaily directly elsewhere.

/** Every metric a weighted metric needs (itself plus its ratio parts). */
function withDeps(keys: string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    out.add(k);
    const r = METRIC_BY_KEY[k]?.ratioOf;
    if (r) { out.add(r.numerator); out.add(r.denominator); }
    const d = METRIC_BY_KEY[k]?.diffOf;
    if (d) { out.add(d.minuend); out.add(d.subtrahend); }
  }
  return [...out];
}

async function totalsByDay(clientId: string, keys: string[], from: IsoDate, to: IsoDate): Promise<Record<string, DailyValue[]>> {
  const rows = await prisma.metricDaily.groupBy({
    by: ["metric", "date"],
    where: { clientId, metric: { in: withDeps(keys) }, dimension: "", date: { gte: isoToDate(from), lte: isoToDate(to) } },
    _sum: { value: true },
  });
  const out: Record<string, DailyValue[]> = {};
  for (const r of rows) (out[r.metric] ??= []).push({ date: dateToIso(r.date), value: r._sum.value ?? 0 });
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

/** Range totals per metric (null = no data). */
export async function metricTotals(clientId: string, keys: string[], from: IsoDate, to: IsoDate): Promise<Record<string, number | null>> {
  const byDay = await totalsByDay(clientId, keys, from, to);
  return Object.fromEntries(keys.map((k) => [k, aggregateMetric(k, byDay[k] ?? [], byDay)]));
}

/** Daily series per metric (weighted metrics computed per day). */
export async function metricSeries(clientId: string, keys: string[], from: IsoDate, to: IsoDate): Promise<Record<string, DailyValue[]>> {
  const byDay = await totalsByDay(clientId, keys, from, to);
  const out: Record<string, DailyValue[]> = {};
  for (const k of keys) {
    const def = METRIC_BY_KEY[k];
    if (def?.aggregation === "weighted" && def.ratioOf) {
      const dates = [...new Set((byDay[def.ratioOf.numerator] ?? []).map((d) => d.date))].sort();
      out[k] = dates.map((date) => {
        const pick = (m: string) => (byDay[m] ?? []).filter((d) => d.date === date);
        return { date, value: aggregateMetric(k, [], { [def.ratioOf!.numerator]: pick(def.ratioOf!.numerator), [def.ratioOf!.denominator]: pick(def.ratioOf!.denominator) }) ?? 0 };
      });
    } else if (def?.aggregation === "difference" && def.diffOf) {
      const parts = [def.diffOf.minuend, def.diffOf.subtrahend];
      out[k] = (byDay[def.diffOf.minuend] ?? []).map(({ date }) => {
        const pick = Object.fromEntries(parts.map((m) => [m, (byDay[m] ?? []).filter((x) => x.date === date)]));
        return { date, value: aggregateMetric(k, [], pick) ?? 0 };
      });
    } else out[k] = byDay[k] ?? [];
  }
  return out;
}

/** Breakdown table: top dimension values for the given metrics over the range, sorted by the first metric. */
export async function metricBreakdown(clientId: string, dimension: string, keys: string[], from: IsoDate, to: IsoDate, limit = 25): Promise<{ value: string; metrics: Record<string, number | null> }[]> {
  const rows = await prisma.metricDaily.findMany({
    where: { clientId, dimension, metric: { in: withDeps(keys) }, date: { gte: isoToDate(from), lte: isoToDate(to) } },
    select: { metric: true, date: true, dimensionValue: true, value: true },
  });
  const byValue = new Map<string, Record<string, DailyValue[]>>();
  for (const r of rows) {
    const m = byValue.get(r.dimensionValue) ?? {};
    (m[r.metric] ??= []).push({ date: dateToIso(r.date), value: r.value });
    byValue.set(r.dimensionValue, m);
  }
  const table = [...byValue.entries()].map(([value, m]) => ({ value, metrics: Object.fromEntries(keys.map((k) => [k, aggregateMetric(k, m[k] ?? [], m)])) }));
  const first = keys[0];
  const dir = METRIC_BY_KEY[first]?.better === "down" ? 1 : -1;
  table.sort((a, b) => ((a.metrics[first] ?? (dir > 0 ? Infinity : -Infinity)) - (b.metrics[first] ?? (dir > 0 ? Infinity : -Infinity))) * dir);
  return table.slice(0, limit);
}
