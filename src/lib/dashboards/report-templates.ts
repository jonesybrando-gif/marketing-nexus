// Report templates: the layout a client's Report tab starts from. A template is
// data — blocks of configured widgets, one block per data source — and a
// client's Report gets the blocks for the sources it actually has connected,
// stacked top to bottom. Adding a template (Lead Generation, E-commerce, …)
// means adding an entry here; nothing else changes. A client's saved Report
// (Dashboard role "REPORT") overrides its template; Reset to default rebuilds
// from the template again. Pure, so it is unit-tested.

import type { MetricSource } from "@/lib/metrics-registry";
import type { DashboardWidget } from "./types";

/** Format version of saved Report widgets (Dashboard.layoutVersion). Bump with a migration in readReportWidgets when the format changes. */
export const REPORT_LAYOUT_VERSION = 1;

/** One source's widgets, positioned as if the block started at row 0. */
export interface ReportBlock {
  source: MetricSource;
  widgets: DashboardWidget[];
}

export interface ReportTemplate {
  key: string;
  name: string;
  description: string;
  /** Blocks in display order; only those whose source the client has are used. */
  blocks: ReportBlock[];
  /** Block used when the client has none of the blocks' sources (shows connect prompts). */
  fallback: MetricSource;
}

// --- Widget helpers (ids are stable per template so Reset keeps unchanged widgets' data) ---

const num = (id: string, metric: string, x: number, y: number, w = 2): DashboardWidget => ({ id, kind: "kpi", metrics: [metric], x, y, w, h: 2 });
const chart = (id: string, kind: "line" | "area" | "bar", metrics: string[], x: number, y: number, w: number, title?: string): DashboardWidget => ({ id, kind, metrics, x, y, w, h: 4, ...(title ? { title } : {}) });
const donut = (id: string, metric: string, dimension: string, x: number, y: number, w: number, title?: string): DashboardWidget => ({ id, kind: "pie", metrics: [metric], dimension, x, y, w, h: 4, ...(title ? { title } : {}) });

/** Number tiles, four per row (each 3 of the 12 columns), wrapping onto more rows. */
const PER_ROW = 4;
function numberRows(prefix: string, metrics: string[], y = 0): DashboardWidget[] {
  const w = 12 / PER_ROW;
  return metrics.map((m, i) => num(`${prefix}-${m.split(".")[1]}`, m, (i % PER_ROW) * w, y + Math.floor(i / PER_ROW) * 2, w));
}
const rowsHeight = (n: number) => Math.ceil(n / PER_ROW) * 2;

// --- Blocks ---

const adsBlock = (prefix: string, metrics: string[]): ReportBlock => ({
  source: "ads",
  widgets: [
    ...numberRows(prefix, metrics),
    chart(`${prefix}-trend`, "line", ["ads.spend", "ads.conversions", "ads.clicks"], 0, rowsHeight(metrics.length), 7, "Spend and results by day"),
    donut(`${prefix}-share`, "ads.spend", "platform", 7, rowsHeight(metrics.length), 5, "Spend by ad account"),
  ],
});

const ga4Block: ReportBlock = {
  source: "ga4",
  widgets: [
    ...numberRows("r-ga4", ["ga4.sessions", "ga4.totalUsers", "ga4.engagementRate", "ga4.keyEvents"]),
    chart("r-ga4-trend", "area", ["ga4.sessions", "ga4.totalUsers"], 0, 2, 8, "Website visits by day"),
    donut("r-ga4-channels", "ga4.sessions", "channel", 8, 2, 4, "Visits by channel"),
  ],
};

const gscBlock: ReportBlock = {
  source: "gsc",
  widgets: [
    ...numberRows("r-gsc", ["gsc.clicks", "gsc.impressions", "gsc.ctr", "gsc.position"]),
    chart("r-gsc-trend", "line", ["gsc.clicks", "gsc.impressions"], 0, 2, 12, "Google Search clicks by day"),
  ],
};

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    key: "standard",
    name: "Standard",
    description: "Headline ad results, then website traffic and Google Search when connected.",
    // Row 1: spend, conversions, cost per conversion, ROAS. Row 2: clicks, CTR, CPC, impressions.
    blocks: [adsBlock("r-ads", ["ads.spend", "ads.conversions", "ads.costPerConversion", "ads.roas", "ads.clicks", "ads.ctr", "ads.cpc", "ads.impressions"]), ga4Block, gscBlock],
    fallback: "ads",
  },
  {
    key: "lead-generation",
    name: "Lead Generation",
    description: "Leads and what they cost, then website goals.",
    blocks: [adsBlock("r-lead", ["ads.spend", "ads.leads", "ads.costPerLead", "ads.conversions", "ads.costPerConversion", "ads.conversionRate", "ads.clicks", "ads.cpc"]), ga4Block, gscBlock],
    fallback: "ads",
  },
  {
    key: "ecommerce",
    name: "E-commerce",
    description: "Revenue and return on ad spend, then website traffic.",
    blocks: [adsBlock("r-ecom", ["ads.spend", "ads.conversionValue", "ads.roas", "ads.conversions", "ads.costPerConversion", "ads.cpc", "ads.clicks", "ads.ctr"]), ga4Block, gscBlock],
    fallback: "ads",
  },
  {
    key: "seo-performance",
    name: "SEO Performance",
    description: "Google Search first, then website traffic.",
    blocks: [gscBlock, ga4Block],
    fallback: "gsc",
  },
  {
    key: "executive-summary",
    name: "Executive Summary",
    description: "Four headline numbers per connected source.",
    blocks: [
      { source: "ads", widgets: numberRows("r-exec-ads", ["ads.spend", "ads.conversions", "ads.costPerConversion", "ads.roas"]) },
      { source: "ga4", widgets: numberRows("r-exec-ga4", ["ga4.sessions", "ga4.totalUsers", "ga4.keyEvents", "ga4.engagementRate"]) },
      { source: "gsc", widgets: numberRows("r-exec-gsc", ["gsc.clicks", "gsc.impressions", "gsc.ctr", "gsc.position"]) },
    ],
    fallback: "ads",
  },
];

export const DEFAULT_REPORT_TEMPLATE = "standard";

export const reportTemplate = (key: string | null | undefined): ReportTemplate =>
  REPORT_TEMPLATES.find((t) => t.key === key) ?? REPORT_TEMPLATES.find((t) => t.key === DEFAULT_REPORT_TEMPLATE)!;

/**
 * The template's widgets for a client: its blocks for the client's connected
 * sources, stacked in order (each block below the one before). "ads" counts
 * as connected when the client has ad accounts.
 */
export function buildReportWidgets(template: ReportTemplate, linked: MetricSource[]): DashboardWidget[] {
  let blocks = template.blocks.filter((b) => linked.includes(b.source));
  if (blocks.length === 0) blocks = template.blocks.filter((b) => b.source === template.fallback).slice(0, 1);
  const out: DashboardWidget[] = [];
  let top = 0;
  for (const b of blocks) {
    const height = b.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    for (const w of b.widgets) out.push({ ...w, ...(w.metrics ? { metrics: [...w.metrics] } : {}), y: w.y + top });
    top += height;
  }
  return out;
}
