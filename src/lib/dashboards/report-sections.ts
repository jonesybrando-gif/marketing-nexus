// Report sections: a client's Report is a list of sections (Paid Media,
// CallRail, SEO, Google Analytics, Budget Pacing), each a container of the
// same widgets custom dashboards use, laid out on its own 12-column grid.
// Section templates are shared data; a client's saved layout is its own copy,
// so customizing one client never changes the templates or other clients.
// Pure (no DB), so it is unit-tested and shared by the editor and server.

import type { MetricSource } from "@/lib/metrics-registry";
import type { PlatformKey } from "@/lib/platforms";
import type { DashboardWidget } from "./types";
import { parseWidgets, readWidgets, MAX_WIDGETS } from "./parse";
import { sourceOf } from "./metrics";

/** Version of the saved Report format (Dashboard.layoutVersion): 1 = flat widgets, 2 = sections. */
export const REPORT_SECTIONS_VERSION = 2;

export type SectionType = "google_ads" | "meta_ads" | "microsoft_ads" | "lsa" | "ads" | "callrail" | "seo" | "ga4" | "pacing";

export interface SectionTypeDef {
  type: SectionType;
  title: string;
  /** What it covers, for the Add Section menu. */
  description: string;
  /** Sources whose data the section shows (and which feed the AI summary when the section is in the report). */
  sources: MetricSource[];
  /** Available when any of these sources is connected. */
  requires: MetricSource[];
  /** Ad platform sections: only that platform's accounts, available when the client has one. */
  platform?: PlatformKey;
  /** Not part of a default report (offered in Add Section only). */
  optional?: boolean;
}

/** Display order of a default report; future integrations add an entry here and a template below. */
export const SECTION_TYPES: SectionTypeDef[] = [
  { type: "google_ads", title: "Google Ads", description: "Spend, clicks, conversions and campaigns from Google Ads.", sources: ["ads"], requires: ["ads"], platform: "GOOGLE_ADS" },
  { type: "meta_ads", title: "Meta Ads", description: "Spend, reach, clicks, leads and campaigns from Facebook and Instagram ads.", sources: ["ads"], requires: ["ads"], platform: "META_ADS" },
  { type: "microsoft_ads", title: "Microsoft Ads", description: "Spend, clicks, conversions and campaigns from Microsoft Advertising.", sources: ["ads"], requires: ["ads"], platform: "MICROSOFT_ADS" },
  { type: "lsa", title: "Local Services Ads", description: "Spend, leads and cost per lead from Google Local Services.", sources: ["ads"], requires: ["ads"], platform: "GOOGLE_LSA" },
  { type: "ads", title: "Paid Media (all platforms)", description: "Every ad platform added together: spend, results, platforms and campaigns.", sources: ["ads"], requires: ["ads"], optional: true },
  { type: "callrail", title: "CallRail", description: "Calls, answered and missed, first-time callers, sources and campaigns.", sources: ["callrail"], requires: ["callrail"] },
  { type: "seo", title: "SEO", description: "Google Search clicks and positions, top queries and pages, keyword rankings.", sources: ["gsc", "rank"], requires: ["gsc", "rank"] },
  { type: "ga4", title: "Google Analytics", description: "Website visitors, visits, engagement, channels, pages and goals.", sources: ["ga4"], requires: ["ga4"] },
  { type: "pacing", title: "Budget Pacing", description: "This month's budget, spend so far, what's left and the spending pace.", sources: [], requires: ["ads"] },
];
export const SECTION_TYPE: Record<SectionType, SectionTypeDef> = Object.fromEntries(SECTION_TYPES.map((d) => [d.type, d])) as Record<SectionType, SectionTypeDef>;
export const isSectionType = (t: unknown): t is SectionType => typeof t === "string" && t in SECTION_TYPE;

export interface ReportSection {
  id: string;
  type: SectionType;
  title: string;
  /** Starts collapsed for viewers (each viewer can still open or close it). */
  collapsed?: boolean;
  /** Widgets on the section's own grid (y starts at 0). */
  widgets: DashboardWidget[];
}

export interface ReportLayout {
  version: typeof REPORT_SECTIONS_VERSION;
  /** In display order. */
  sections: ReportSection[];
  /** Section types someone removed on purpose: never added back automatically. */
  removed: SectionType[];
  /** Section types the layout already knows about (offered or decided): a newly connected integration outside this list is offered once. */
  known: SectionType[];
}

// --- Templates ---------------------------------------------------------------

type W = DashboardWidget;
const tile = (id: string, metric: string, x: number, y: number, w = 3): W => ({ id, kind: "kpi", metrics: [metric], x, y, w, h: 2 });
const tiles = (p: string, metrics: string[], perRow = 4): W[] => metrics.map((m, i) => tile(`${p}-${m.split(".")[1]}`, m, (i % perRow) * (12 / perRow), Math.floor(i / perRow) * 2, 12 / perRow));
const rowsOf = (n: number, perRow = 4) => Math.ceil(n / perRow) * 2;

/** An ad platform section: number tiles, the trend, spend by campaign and the campaign table (all limited to the platform). */
function platformWidgets(p: string, metrics: string[], withCampaignShare = true): W[] {
  const y = rowsOf(metrics.length);
  return [
    ...tiles(p, metrics),
    { id: `${p}-trend`, kind: "line", title: "Performance over time", metrics: ["ads.spend", metrics.includes("ads.leads") && !metrics.includes("ads.clicks") ? "ads.leads" : "ads.conversions", "ads.clicks"], x: 0, y, w: withCampaignShare ? 8 : 12, h: 4 },
    ...(withCampaignShare ? [{ id: `${p}-spend-campaign`, kind: "pie" as const, title: "Spend by campaign", metrics: ["ads.spend"], dimension: "campaign", x: 8, y, w: 4, h: 4 }] : []),
    { id: `${p}-campaigns`, kind: "campaigns", title: "Campaign performance", x: 0, y: y + 4, w: 12, h: 7 },
  ];
}

/**
 * Default widgets for a section type. `p` prefixes every widget id, so two
 * sections (or a reset) never share ids and saved widgets keep their data.
 */
export function sectionTemplate(type: SectionType, p: string, linked?: MetricSource[]): W[] {
  switch (type) {
    case "google_ads":
    case "microsoft_ads": {
      const m = ["ads.spend", "ads.impressions", "ads.clicks", "ads.ctr", "ads.cpc", "ads.conversions", "ads.costPerConversion", "ads.conversionRate", "ads.conversionValue", "ads.roas"];
      return platformWidgets(p, m);
    }
    case "meta_ads":
      return platformWidgets(p, ["ads.spend", "ads.impressions", "ads.clicks", "ads.ctr", "ads.cpc", "ads.leads", "ads.costPerLead", "ads.conversions", "ads.costPerConversion", "ads.roas"]);
    case "lsa":
      return platformWidgets(p, ["ads.spend", "ads.leads", "ads.costPerLead", "ads.conversions", "ads.costPerConversion", "ads.impressions", "ads.clicks"], false);
    case "ads": {
      const m = ["ads.spend", "ads.impressions", "ads.clicks", "ads.ctr", "ads.cpc", "ads.conversions", "ads.costPerConversion", "ads.conversionRate", "ads.conversionValue", "ads.roas"];
      const y = rowsOf(m.length);
      return [
        ...tiles(p, m),
        { id: `${p}-trend`, kind: "line", title: "Performance over time", metrics: ["ads.spend", "ads.conversions", "ads.clicks"], x: 0, y, w: 12, h: 4 },
        { id: `${p}-spend-platform`, kind: "pie", title: "Spend by platform", metrics: ["ads.spend"], dimension: "network", x: 0, y: y + 4, w: 6, h: 4 },
        { id: `${p}-conv-platform`, kind: "pie", title: "Conversions by platform", metrics: ["ads.conversions"], dimension: "network", x: 6, y: y + 4, w: 6, h: 4 },
        { id: `${p}-campaigns`, kind: "campaigns", title: "Campaign performance", x: 0, y: y + 8, w: 12, h: 7 },
      ];
    }
    case "callrail": {
      const m = ["callrail.calls", "callrail.answered", "callrail.missed", "callrail.answerRate", "callrail.firstTimeCallers", "callrail.repeatCallers", "callrail.avgDuration", "callrail.leads"];
      const y = rowsOf(m.length);
      return [
        ...tiles(p, m),
        { id: `${p}-trend`, kind: "line", title: "Calls over time", metrics: ["callrail.calls", "callrail.answered", "callrail.missed"], x: 0, y, w: 8, h: 4 },
        { id: `${p}-status`, kind: "pie", title: "Answered vs missed calls", metrics: ["callrail.calls"], dimension: "status", x: 8, y, w: 4, h: 4 },
        { id: `${p}-sources`, kind: "pie", title: "Calls by source", metrics: ["callrail.calls"], dimension: "source", x: 0, y: y + 4, w: 5, h: 5 },
        { id: `${p}-campaigns`, kind: "table", title: "Calls by campaign", dimension: "campaign", metrics: ["callrail.calls", "callrail.answered", "callrail.missed", "callrail.firstTimeCallers", "callrail.leads"], x: 5, y: y + 4, w: 7, h: 5 },
      ];
    }
    case "seo": {
      // Search Console and rank tracking are separate connections: lay out what the client has (both when unknown).
      const gsc = !linked || linked.includes("gsc");
      const rank = !linked || linked.includes("rank");
      const m = [...(gsc ? ["gsc.clicks", "gsc.impressions", "gsc.ctr", "gsc.position"] : []), ...(rank ? ["rank.tracked", "rank.top10", "rank.top3", "rank.avgPosition"] : [])];
      let y = rowsOf(m.length);
      const out: W[] = tiles(p, m);
      if (gsc) {
        out.push(
          { id: `${p}-trend`, kind: "line", title: "Organic search performance over time", metrics: ["gsc.clicks", "gsc.impressions"], x: 0, y, w: 12, h: 4 },
          { id: `${p}-queries`, kind: "table", title: "Top search queries", dimension: "query", metrics: ["gsc.clicks", "gsc.impressions", "gsc.ctr", "gsc.position"], x: 0, y: y + 4, w: 6, h: 6 },
          { id: `${p}-pages`, kind: "table", title: "Top organic landing pages", dimension: "page", metrics: ["gsc.clicks", "gsc.impressions", "gsc.ctr", "gsc.position"], x: 6, y: y + 4, w: 6, h: 6 },
        );
        y += 10;
      }
      if (rank) {
        out.push(
          { id: `${p}-rank-trend`, kind: "line", title: "Keyword ranking trend", metrics: ["rank.top3", "rank.top10"], x: 0, y, w: 6, h: 6 },
          { id: `${p}-rankings`, kind: "rankings", title: "Keyword rankings", x: 6, y, w: 6, h: 6 },
        );
      }
      return out;
    }
    case "ga4": {
      const m = ["ga4.totalUsers", "ga4.newUsers", "ga4.sessions", "ga4.engagedSessions", "ga4.engagementRate", "ga4.avgEngagementTime", "ga4.keyEvents", "ga4.keyEventRate"];
      const y = rowsOf(m.length);
      return [
        ...tiles(p, m),
        { id: `${p}-trend`, kind: "area", title: "Website traffic over time", metrics: ["ga4.sessions", "ga4.totalUsers"], x: 0, y, w: 8, h: 4 },
        { id: `${p}-channels`, kind: "pie", title: "Traffic by channel", metrics: ["ga4.sessions"], dimension: "channel", x: 8, y, w: 4, h: 4 },
        { id: `${p}-pages`, kind: "table", title: "Top landing pages", dimension: "page", metrics: ["ga4.sessions", "ga4.engagementRate", "ga4.keyEvents"], x: 0, y: y + 4, w: 7, h: 5 },
        { id: `${p}-goals`, kind: "line", title: "Website goals over time", metrics: ["ga4.keyEvents"], x: 7, y: y + 4, w: 5, h: 5 },
      ];
    }
    case "pacing":
      // The existing pacing block: budget, spent, left, % used, spend vs plan by day and the daily spend needed.
      return [{ id: `${p}-pacing`, kind: "pacing", title: "Budget pacing", x: 0, y: 0, w: 12, h: 6 }];
  }
}

/**
 * Section types whose data is connected for the client. Ad platform sections
 * need an account on that platform (`platforms`); without the list (older
 * callers) any ad account counts.
 */
export function availableSectionTypes(linked: MetricSource[], platforms?: PlatformKey[]): SectionType[] {
  return SECTION_TYPES.filter((d) => d.requires.some((s) => linked.includes(s)) && (!d.platform || !platforms || platforms.includes(d.platform))).map((d) => d.type);
}

/** The default sections: every available type except the optional ones (the combined Paid Media view). */
// Without the platform list, ads stay one combined Paid Media section.
const defaultTypes = (linked: MetricSource[], platforms?: PlatformKey[]) =>
  availableSectionTypes(linked, platforms).filter((t) => (platforms ? !SECTION_TYPE[t].optional : !SECTION_TYPE[t].platform));

const sectionId = (type: SectionType, n = 1) => (n === 1 ? `s-${type}` : `s-${type}-${n}`);

/** A new section of a type, with a unique id among `existing`. */
export function newSection(type: SectionType, existing: Pick<ReportSection, "id">[] = [], linked?: MetricSource[]): ReportSection {
  let n = 1;
  while (existing.some((s) => s.id === sectionId(type, n))) n++;
  const id = sectionId(type, n);
  const title = n === 1 ? SECTION_TYPE[type].title : `${SECTION_TYPE[type].title} (${n})`;
  return { id, type, title, widgets: sectionTemplate(type, id, linked) };
}

/** The default report for a client: one section per connected integration, in the standard order. */
export function defaultReportLayout(linked: MetricSource[], platforms?: PlatformKey[]): ReportLayout {
  const types = defaultTypes(linked, platforms);
  const sections: ReportSection[] = [];
  for (const t of types) sections.push(newSection(t, sections, linked));
  return { version: REPORT_SECTIONS_VERSION, sections, removed: [], known: types };
}

/** Which section a version 1 widget belonged to, by its data source. */
function typeOfWidget(w: DashboardWidget): SectionType {
  if (w.kind === "pacing") return "pacing";
  if (w.kind === "campaigns") return "ads";
  if (w.kind === "rankings") return "seo";
  if (w.kind === "calllog" || w.kind === "formlog") return "callrail";
  const src = w.metrics?.length ? sourceOf(w.metrics[0]) : null;
  if (src === "callrail") return "callrail";
  if (src === "gsc" || src === "rank") return "seo";
  if (src === "ga4") return "ga4";
  return "ads";
}

/**
 * Converts a saved version 1 Report (one flat grid) into sections without
 * dropping anything: widgets are grouped by data source in their original
 * order and keep their sizes; text widgets join the section below them.
 */
export function migrateFlatReport(widgets: DashboardWidget[]): ReportLayout {
  const sorted = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups = new Map<SectionType, DashboardWidget[]>();
  let pendingText: DashboardWidget[] = [];
  for (const w of sorted) {
    if (w.kind === "text") {
      pendingText.push(w);
      continue;
    }
    const t = typeOfWidget(w);
    groups.set(t, [...(groups.get(t) ?? []), ...pendingText, w]);
    pendingText = [];
  }
  if (pendingText.length) {
    const last = [...groups.keys()].pop() ?? "ads";
    groups.set(last, [...(groups.get(last) ?? []), ...pendingText]);
  }
  const order = SECTION_TYPES.map((d) => d.type).filter((t) => groups.has(t));
  const sections = order.map((type) => {
    const ws = groups.get(type)!;
    const top = Math.min(...ws.map((w) => w.y));
    return { id: sectionId(type), type, title: SECTION_TYPE[type].title, widgets: ws.map((w) => ({ ...w, y: w.y - top })) };
  });
  return { version: REPORT_SECTIONS_VERSION, sections, removed: [], known: order };
}

export type ParsedLayout = { ok: true; layout: ReportLayout } | { ok: false; error: string };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_SECTIONS = 20;

/** Validates a layout from the editor (untrusted). Widget ids must be unique across the whole report. */
export function parseReportLayout(raw: unknown): ParsedLayout {
  if (!raw || typeof raw !== "object") return { ok: false, error: "The report layout is missing." };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.sections)) return { ok: false, error: "The report layout is missing its sections." };
  if (r.sections.length > MAX_SECTIONS) return { ok: false, error: `A report can have up to ${MAX_SECTIONS} sections.` };
  const sections: ReportSection[] = [];
  const ids = new Set<string>();
  const widgetIds = new Set<string>();
  let total = 0;
  for (const s of r.sections as unknown[]) {
    if (!s || typeof s !== "object") return { ok: false, error: "A section is malformed." };
    const x = s as Record<string, unknown>;
    if (typeof x.id !== "string" || !ID_RE.test(x.id) || ids.has(x.id)) return { ok: false, error: "A section has a missing or duplicate id." };
    if (!isSectionType(x.type)) return { ok: false, error: "A section has an unknown type." };
    const title = typeof x.title === "string" && x.title.trim() ? x.title.trim().slice(0, 80) : SECTION_TYPE[x.type].title;
    const parsed = parseWidgets(x.widgets ?? []);
    if (!parsed.ok) return { ok: false, error: `${title}: ${parsed.error}` };
    for (const w of parsed.widgets) {
      if (widgetIds.has(w.id)) return { ok: false, error: "Two widgets share an id." };
      widgetIds.add(w.id);
    }
    total += parsed.widgets.length;
    if (total > MAX_WIDGETS) return { ok: false, error: `A report can have up to ${MAX_WIDGETS} widgets.` };
    ids.add(x.id);
    sections.push({ id: x.id, type: x.type, title, ...(x.collapsed === true ? { collapsed: true } : {}), widgets: parsed.widgets });
  }
  const types = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).filter(isSectionType))];
  return { ok: true, layout: { version: REPORT_SECTIONS_VERSION, sections, removed: types(r.removed), known: types(r.known) } };
}

/**
 * Reads a saved Report: version 2 as stored (invalid parts dropped rather than
 * breaking the page), version 1 converted to sections.
 */
export function readReportLayout(widgetsJson: unknown, layoutVersion: number): ReportLayout {
  if (layoutVersion >= REPORT_SECTIONS_VERSION && widgetsJson && typeof widgetsJson === "object" && !Array.isArray(widgetsJson)) {
    const parsed = parseReportLayout(widgetsJson);
    if (parsed.ok) return parsed.layout;
    // Salvage section by section.
    const raw = widgetsJson as { sections?: unknown[]; removed?: unknown; known?: unknown };
    const sections = (Array.isArray(raw.sections) ? raw.sections : []).flatMap((s) => {
      const one = parseReportLayout({ sections: [s] });
      return one.ok ? one.layout.sections : [];
    });
    const types = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).filter(isSectionType))];
    return { version: REPORT_SECTIONS_VERSION, sections, removed: types(raw.removed), known: types(raw.known) };
  }
  return migrateFlatReport(readWidgets(widgetsJson));
}

/**
 * Integrations connected since the layout was customized: their section isn't
 * in the report, wasn't removed on purpose and hasn't been offered before.
 */
export function newlyAvailableSections(layout: ReportLayout, linked: MetricSource[], platforms?: PlatformKey[]): SectionType[] {
  const present = new Set(layout.sections.map((s) => s.type));
  // Platform sections are new only if the report doesn't already cover ads with Paid Media.
  const coversAds = present.has("ads") || layout.known.includes("ads");
  return defaultTypes(linked, platforms).filter((t) => !(coversAds && SECTION_TYPE[t].platform)).filter((t) => !present.has(t) && !layout.removed.includes(t) && !layout.known.includes(t));
}

/** Data sources the report's sections cover (for the AI summary). */
export function reportSources(layout: Pick<ReportLayout, "sections">): Set<MetricSource> {
  const out = new Set<MetricSource>();
  for (const s of layout.sections) for (const src of SECTION_TYPE[s.type].sources) out.add(src);
  return out;
}

/** Every widget of the report, for resolving data in one pass (ids are unique across sections). */
export const allWidgets = (layout: Pick<ReportLayout, "sections">): DashboardWidget[] => layout.sections.flatMap((s) => s.widgets);
