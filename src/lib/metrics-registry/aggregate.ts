// Pure aggregation of daily metric values over a range (no DB access).
import { METRIC_BY_KEY } from "./index";

export interface DailyValue { date: string; value: number }

/** Combine one metric's daily values per its aggregation. `byMetric` gives other metrics' daily values for weighted ratios. */
export function aggregateMetric(key: string, days: DailyValue[], byMetric: Record<string, DailyValue[]> = {}): number | null {
  const def = METRIC_BY_KEY[key];
  if (!def) return null;
  const sum = (xs: DailyValue[]) => xs.reduce((a, d) => a + d.value, 0);
  switch (def.aggregation) {
    case "sum":
      return days.length ? sum(days) : null;
    case "last": {
      if (!days.length) return null;
      return [...days].sort((a, b) => (a.date < b.date ? 1 : -1))[0].value;
    }
    case "avg":
      return days.length ? sum(days) / days.length : null;
    case "weighted": {
      if (!def.ratioOf) return null;
      const num = sum(byMetric[def.ratioOf.numerator] ?? []);
      const den = sum(byMetric[def.ratioOf.denominator] ?? []);
      if (!den) return null;
      const r = num / den;
      return def.format === "pct" ? r * 100 : r;
    }
    case "difference": {
      if (!def.diffOf) return null;
      const a = byMetric[def.diffOf.minuend] ?? [];
      // No data for the base metric means unknown, never zero.
      if (!a.length) return null;
      return Math.max(0, sum(a) - sum(byMetric[def.diffOf.subtrahend] ?? []));
    }
  }
}
