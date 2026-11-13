import { describe, expect, it } from "vitest";
import type { MetricSource } from "@/lib/metrics-registry";
import { overlaps } from "@/lib/dashboards/layout";
import { parseWidgets } from "@/lib/dashboards/parse";
import { buildReportWidgets, DEFAULT_REPORT_TEMPLATE, REPORT_TEMPLATES, reportTemplate } from "@/lib/dashboards/report-templates";

const COMBOS: MetricSource[][] = [[], ["ads"], ["ga4"], ["gsc"], ["ads", "ga4"], ["ads", "gsc"], ["ga4", "gsc"], ["ads", "ga4", "gsc"], ["ads", "ga4", "gsc", "callrail", "gbp"]];

describe("report templates", () => {
  for (const t of REPORT_TEMPLATES) {
    for (const linked of COMBOS) {
      it(`${t.key} with [${linked.join(", ")}] is a valid, non-overlapping layout`, () => {
        const ws = buildReportWidgets(t, linked);
        expect(ws.length).toBeGreaterThan(0);
        expect(parseWidgets(ws).ok).toBe(true);
        for (const a of ws) for (const b of ws) expect(overlaps(a, b)).toBe(false);
      });
    }
  }

  it("only uses the sources a client has, falling back to connect prompts when it has none", () => {
    const std = reportTemplate(DEFAULT_REPORT_TEMPLATE);
    expect(buildReportWidgets(std, ["ga4"]).every((w) => w.metrics?.every((m) => m.startsWith("ga4.")))).toBe(true);
    expect(buildReportWidgets(std, []).every((w) => w.metrics?.every((m) => m.startsWith("ads.")))).toBe(true);
  });

  it("stacks blocks top to bottom in template order", () => {
    const ws = buildReportWidgets(reportTemplate("standard"), ["ads", "ga4"]);
    const adsBottom = Math.max(...ws.filter((w) => w.metrics?.[0].startsWith("ads.")).map((w) => w.y + w.h));
    const ga4Top = Math.min(...ws.filter((w) => w.metrics?.[0].startsWith("ga4.")).map((w) => w.y));
    expect(ga4Top).toBe(adsBottom);
  });

  it("falls back to the default template for an unknown key and never shares arrays between builds", () => {
    expect(reportTemplate("nope").key).toBe(DEFAULT_REPORT_TEMPLATE);
    const a = buildReportWidgets(reportTemplate("standard"), ["ads"]);
    a[0].metrics!.push("ads.clicks");
    expect(buildReportWidgets(reportTemplate("standard"), ["ads"])[0].metrics).toEqual(["ads.spend"]);
  });
});

describe("widget options", () => {
  it("accepts area charts and the Number tile's hide-change option (kpi only)", () => {
    const r = parseWidgets([
      { id: "a", kind: "area", metrics: ["ads.spend"], x: 0, y: 0, w: 6, h: 4 },
      { id: "k", kind: "kpi", metrics: ["ads.clicks"], hideChange: true, x: 6, y: 0, w: 2, h: 2 },
      { id: "l", kind: "line", metrics: ["ads.clicks"], hideChange: true, x: 0, y: 4, w: 6, h: 4 },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widgets[1].hideChange).toBe(true);
    expect(r.widgets[2].hideChange).toBeUndefined();
  });
});
