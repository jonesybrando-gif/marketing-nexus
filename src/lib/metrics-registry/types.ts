// Metric catalogue for non-ad data sources (GA4, Search Console, Business
// Profile, CallRail, Facebook/Instagram organic, rank tracking). Each source
// registers its metrics in its own file and adds one line to ./index.ts.
// Dashboards, reports and the AI assistant read metrics only through this
// catalogue, so a metric key ("ga4.sessions") means the same thing everywhere.

export type MetricSource = "ads" | "ga4" | "gsc" | "gbp" | "callrail" | "facebook" | "instagram" | "rank";

/** "money" values are stored in minor units (cents), like ad spend. "duration" is seconds. */
export type MetricFormat = "count" | "money" | "pct" | "duration" | "position" | "ratio";

/**
 * How daily values combine over a date range:
 * - sum: add the days (sessions, calls)
 * - last: the latest day's value (followers, total reviews)
 * - avg: plain mean of the days (rarely right; prefer weighted)
 * - weighted: ratio of two summed metrics, see `ratioOf`
 * - difference: one summed metric minus another, see `diffOf` (e.g. repeat callers = calls − first-time callers)
 */
export type Aggregation = "sum" | "last" | "avg" | "weighted" | "difference";

export interface MetricDef {
  /** Globally unique, "<source>.<name>", e.g. "ga4.sessions". */
  key: string;
  source: MetricSource;
  label: string;
  short?: string;
  format: MetricFormat;
  aggregation: Aggregation;
  /** For aggregation "weighted": value = sum(numerator) / sum(denominator) (* 100 for pct). */
  ratioOf?: { numerator: string; denominator: string };
  /** For aggregation "difference": value = sum(minuend) − sum(subtrahend). */
  diffOf?: { minuend: string; subtrahend: string };
  /** Is an increase good, bad or neither? Drives change colours. Lower position = better for rankings. */
  better: "up" | "down" | "neutral";
  description: string;
  /** One-line plain-English definition (the ⓘ text). Filled from ./plain.ts by ./index.ts when omitted. */
  plain?: string;
  /** Dimensions this metric is stored with, for tables/breakdowns (e.g. ["channel","page"]). */
  dimensions?: string[];
}

export interface DimensionDef {
  /** e.g. "ga4.channel" */
  key: string;
  source: MetricSource;
  /** Value stored in MetricDaily.dimension, e.g. "channel" */
  dimension: string;
  label: string;
  /**
   * Natural order (e.g. weekdays, hours): breakdowns list every value sorted by
   * the stored value instead of the top rows by metric. Stored values may carry
   * a sort prefix ("1 Mon") that is hidden when shown.
   */
  ordered?: boolean;
}
