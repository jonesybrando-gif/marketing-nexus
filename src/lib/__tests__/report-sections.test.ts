import { describe, expect, it } from "vitest";
import { allWidgets, availableSectionTypes, defaultReportLayout, migrateFlatReport, newlyAvailableSections, newSection, parseReportLayout, readReportLayout, reportSources, SECTION_TYPES, sectionTemplate } from "../dashboards/report-sections";
import { parseWidgets } from "../dashboards/parse";
import type { DashboardWidget } from "../dashboards/types";

describe("report section templates", () => {
  it("every template is valid widgets", () => {
    for (const d of SECTION_TYPES) {
      const ws = sectionTemplate(d.type, `s-${d.type}`);
      const parsed = parseWidgets(ws);
      expect(parsed.ok, `${d.type}: ${!parsed.ok ? parsed.error : ""}`).toBe(true);
      expect(new Set(ws.map((w) => w.id)).size).toBe(ws.length);
    }
  });

  it("builds one section per connected integration, in order", () => {
    expect(defaultReportLayout(["ads", "callrail", "ga4"]).sections.map((s) => s.type)).toEqual(["ads", "callrail", "ga4", "pacing"]);
    expect(defaultReportLayout(["ads", "gsc", "ga4"]).sections.map((s) => s.type)).toEqual(["ads", "seo", "ga4", "pacing"]);
    expect(defaultReportLayout(["callrail"]).sections.map((s) => s.type)).toEqual(["callrail"]);
    expect(availableSectionTypes(["rank"])).toEqual(["seo"]);
  });

  it("lays out SEO from what is connected", () => {
    const gscOnly = sectionTemplate("seo", "x", ["gsc"]);
    expect(gscOnly.some((w) => w.kind === "rankings")).toBe(false);
    const rankOnly = sectionTemplate("seo", "x", ["rank"]);
    expect(rankOnly.some((w) => (w.metrics ?? []).some((m) => m.startsWith("gsc.")))).toBe(false);
  });

  it("gives a second section of a type its own ids", () => {
    const a = newSection("ads");
    const b = newSection("ads", [a]);
    expect(b.id).not.toBe(a.id);
    expect(b.widgets.some((w) => a.widgets.some((x) => x.id === w.id))).toBe(false);
  });
});

describe("saved reports", () => {
  const flat: DashboardWidget[] = [
    { id: "a", kind: "kpi", metrics: ["ads.spend"], x: 0, y: 0, w: 3, h: 2 },
    { id: "t", kind: "text", text: "## Website", x: 0, y: 2, w: 12, h: 1 },
    { id: "g", kind: "kpi", metrics: ["ga4.sessions"], x: 0, y: 3, w: 3, h: 2 },
    { id: "c", kind: "kpi", metrics: ["callrail.calls"], x: 3, y: 3, w: 3, h: 2 },
  ];

  it("converts a version 1 report into sections without losing widgets", () => {
    const l = migrateFlatReport(flat);
    expect(l.sections.map((s) => s.type)).toEqual(["ads", "callrail", "ga4"]);
    expect(allWidgets(l).map((w) => w.id).sort()).toEqual(["a", "c", "g", "t"]);
    expect(l.sections.find((s) => s.type === "ga4")!.widgets.map((w) => w.id)).toEqual(["t", "g"]);
    expect(l.sections.find((s) => s.type === "ga4")!.widgets[0].y).toBe(0);
    expect(readReportLayout(flat, 1).sections).toHaveLength(3);
  });

  it("validates layouts and keeps removed and known types", () => {
    const l = defaultReportLayout(["ads", "callrail"]);
    const parsed = parseReportLayout({ ...l, removed: ["callrail", "nope"] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.layout.removed).toEqual(["callrail"]);
    const dup = { sections: [l.sections[0], { ...l.sections[1], widgets: l.sections[0].widgets }] };
    expect(parseReportLayout(dup).ok).toBe(false);
    expect(readReportLayout(l, 2).sections.length).toBe(l.sections.length);
  });

  it("offers newly connected integrations once and never brings back removed ones", () => {
    const l = { ...defaultReportLayout(["ads"]) };
    expect(newlyAvailableSections(l, ["ads", "callrail", "ga4"])).toEqual(["callrail", "ga4"]);
    expect(newlyAvailableSections({ ...l, removed: ["callrail"], known: [...l.known, "ga4"] }, ["ads", "callrail", "ga4"])).toEqual([]);
  });

  it("lists the sources the sections cover", () => {
    const l = defaultReportLayout(["ads", "gsc", "callrail"]);
    expect([...reportSources(l)].sort()).toEqual(["ads", "callrail", "gsc", "rank"]);
    expect(reportSources({ sections: l.sections.filter((s) => s.type !== "callrail") }).has("callrail")).toBe(false);
  });
});
