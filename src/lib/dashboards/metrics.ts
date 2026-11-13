// One view over every metric a dashboard widget can show: ad KPIs ("ads.<KpiKey>",
// from src/lib/kpis.ts) and the non-ad metric registry ("ga4.sessions", …).
// Pure, so client components (widget library, charts) can use it too.

import { isKpiKey, KPI_BY_KEY, KPIS, type KpiKey } from "@/lib/kpis";
import { DIMENSIONS, METRIC_BY_KEY, metricsForSource, type MetricSource } from "@/lib/metrics-registry";
import type { MetricFormat } from "@/lib/metrics-registry/types";
import { pctChange } from "@/lib/metrics";
import { changeVerdict, type Verdict } from "@/lib/change";
import { formatMoney, formatMoneyCompact, formatNumber, formatPct } from "@/lib/money";

export interface MetricInfo {
  key: string;
  source: MetricSource;
  label: string;
  short: string;
  format: MetricFormat;
  better: "up" | "down" | "neutral";
  description: string;
  /** One-line plain definition (the ⓘ text). */
  plain: string;
}

export const SOURCE_LABEL: Record<MetricSource, string> = {
  ads: "Ads",
  ga4: "Website (Google Analytics)",
  gsc: "Google Search",
  gbp: "Google Business Profile",
  callrail: "CallRail",
  facebook: "Facebook page",
  instagram: "Instagram",
  rank: "Google rankings",
};

/** Order of sources in the widget library. */
export const SOURCE_ORDER: MetricSource[] = ["ads", "ga4", "gsc", "gbp", "callrail", "facebook", "instagram", "rank"];

const KIND_TO_FORMAT: Record<string, MetricFormat> = { money: "money", count: "count", pct: "pct", ratio: "ratio" };

export const adKpiKey = (key: string): KpiKey | null => {
  if (!key.startsWith("ads.")) return null;
  const k = key.slice(4);
  return isKpiKey(k) ? k : null;
};

export function sourceOf(key: string): MetricSource | null {
  if (key.startsWith("ads.")) return "ads";
  return METRIC_BY_KEY[key]?.source ?? null;
}

/** Label, format and direction for any metric key, or null when the key is unknown. */
export function metricInfo(key: string): MetricInfo | null {
  const ad = adKpiKey(key);
  if (ad) {
    const d = KPI_BY_KEY[ad];
    return { key, source: "ads", label: d.label, short: d.short, format: KIND_TO_FORMAT[d.kind], better: d.better, description: d.description, plain: d.plain };
  }
  const m = METRIC_BY_KEY[key];
  if (!m) return null;
  return { key, source: m.source, label: m.label, short: m.short ?? m.label, format: m.format, better: m.better, description: m.description, plain: m.plain };
}

export const isKnownMetric = (key: string): boolean => metricInfo(key) !== null;

/** Every metric offered for a source in the widget library. */
export function metricsFor(source: MetricSource): MetricInfo[] {
  if (source === "ads") return KPIS.map((k) => metricInfo(`ads.${k.key}`)!);
  return metricsForSource(source).map((m) => metricInfo(m.key)!);
}

/** Ad breakdowns come from the ad report itself (per campaign / per ad account). */
export const AD_DIMENSIONS = [
  { dimension: "network", label: "Platform" },
  { dimension: "platform", label: "Ad account" },
  { dimension: "campaign", label: "Campaign" },
] as const;

/** Dimensions a source's metrics can be broken down by (MetricDaily.dimension values). */
export function dimensionsFor(source: MetricSource): { dimension: string; label: string }[] {
  if (source === "ads") return [...AD_DIMENSIONS];
  return DIMENSIONS.filter((d) => d.source === source).map((d) => ({ dimension: d.dimension, label: d.label }));
}

export function dimensionLabel(source: MetricSource | null, dimension: string): string {
  if (!source) return dimension;
  return dimensionsFor(source).find((d) => d.dimension === dimension)?.label ?? dimension.charAt(0).toUpperCase() + dimension.slice(1);
}

export type Tone = "good" | "bad" | "neutral";

/**
 * Change vs the comparison period and whether it is good news, with the same
 * rules as the report tiles (src/lib/change.ts): under 5% is "about the
 * same", counts below 10 in either period are "too few to compare", and
 * neutral metrics get no verdict.
 */
export function changeOf(
  value: number | null,
  previous: number | null,
  better: MetricInfo["better"],
  opts: { format?: MetricFormat; sample?: { current: number; previous: number } | null } = {},
): { changePct: number | null; tone: Tone | null; verdict: Verdict | null } {
  const changePct = value !== null && previous !== null ? pctChange(value, previous) : null;
  const sample = opts.sample ?? (opts.format === "count" && value !== null && previous !== null ? { current: value, previous } : null);
  const { verdict, tone } = changeVerdict({ changePct, better, sample });
  return { changePct, tone, verdict };
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Formats a value for display. Money is in minor units (cents) everywhere in
 * the app, ad KPIs and registry metrics alike.
 */
export function formatMetric(info: Pick<MetricInfo, "key" | "format">, v: number | null | undefined, currency = "USD", opts: { axis?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return opts.axis ? "" : "—";
  switch (info.format) {
    case "money": {
      if (opts.axis) return formatMoneyCompact(v, currency);
      const whole = info.key === "ads.spend" || info.key === "ads.conversionValue" || Math.abs(v) >= 100000;
      return formatMoney(v, currency, { whole });
    }
    case "count":
      return formatNumber(v, v % 1 && Math.abs(v) < 100 ? 1 : 0);
    case "pct":
      return formatPct(v, opts.axis ? 1 : 2);
    case "ratio":
      return `${v.toFixed(opts.axis ? 1 : 2)}×`;
    case "duration":
      return formatDuration(v);
    case "position":
      return v.toFixed(1);
  }
}
