import { describe, expect, it, vi } from "vitest";

// The resolver gets every query through `deps`; no database is touched.
vi.mock("../db", () => ({ prisma: {} }));
vi.mock("@/lib/metrics-registry", async () => (await import("../../lib/__tests__/fixtures/dashboard-registry")).registryMock);

import { resolveWidgets, type AdData, type ResolveContext, type ResolverDeps } from "../dashboards/data";
import type { ClientPerformance } from "../reporting";
import { emptyTotals, type MetricTotals } from "@/lib/metrics";
import { eachDay } from "@/lib/pacing/dates";
import type { DashboardWidget } from "@/lib/dashboards/types";

const range = { from: "2026-10-01", to: "2026-10-03" };
const cmpRange = { from: "2026-09-28", to: "2026-09-30" };
const t = (p: Partial<MetricTotals>): MetricTotals => ({ ...emptyTotals(), ...p });

function perf(r: { from: string; to: string }, perDay: Partial<MetricTotals>): ClientPerformance {
  const days = eachDay(r.from, r.to);
  const day = t(perDay);
  const total = t(Object.fromEntries(Object.entries(perDay).map(([k, v]) => [k, typeof v === "number" ? v * days.length : v])));
  return {
    range: r,
    totals: total,
    byDate: days.map((date) => ({ date, ...day })),
    byAccount: { acc1: t({ costMinor: 6000, clicks: 30 }), acc2: t({ costMinor: 3000, clicks: 3 }) },
    byCampaign: { cmp1: t({ costMinor: 9000, clicks: 33, conversions: 3 }), cmp2: t({}) },
  };
}

const ads: AdData = {
  perf: perf(range, { costMinor: 3000, clicks: 11, conversions: 1 }),
  cmpPerf: perf(cmpRange, { costMinor: 1500, clicks: 11, conversions: 1 }),
  campaigns: [{ id: "cmp1", name: "Brand" }, { id: "cmp2", name: "Paused" }],
  accounts: [{ id: "acc1", name: "Main", platform: "GOOGLE_ADS" }, { id: "acc2", name: "Meta", platform: "META_ADS" }],
};

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({ clientId: "c1", today: "2026-10-04", range, cmpRange, compareMode: "previous_period", ads, linked: ["ads", "ga4", "gsc"], ...over });

function deps(over: Partial<ResolverDeps> = {}): ResolverDeps & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = { totals: [], series: [], breakdown: [], ranks: [], ads: [] };
  return {
    calls,
    metricTotals: vi.fn(async (...a: unknown[]) => {
      calls.totals.push(a);
      const [, keys, from] = a as [string, string[], string];
      return Object.fromEntries(keys.map((k) => [k, k === "ga4.sessions" ? (from === range.from ? 120 : 100) : null]));
    }),
    metricSeries: vi.fn(async (...a: unknown[]) => {
      calls.series.push(a);
      const [, keys, from] = a as [string, string[], string];
      return Object.fromEntries(keys.map((k) => [k, k === "ga4.sessions" ? [{ date: from, value: 50 }] : []]));
    }),
    metricBreakdown: vi.fn(async (...a: unknown[]) => {
      calls.breakdown.push(a);
      return [{ value: "dentist near me", metrics: { "gsc.clicks": 40 } }, { value: "", metrics: { "gsc.clicks": 2 } }];
    }) as unknown as ResolverDeps["metricBreakdown"],
    keywordRankTable: vi.fn(async (...a: unknown[]) => {
      calls.ranks.push(a);
      return [];
    }),
    callLog: vi.fn(async () => ({ rows: [], total: 0, timeZone: null })),
    formLog: vi.fn(async () => ({ rows: [], total: 0, timeZone: null })),
    adPerformance: vi.fn(async (_c: string, r: { from: string; to: string }) => {
      calls.ads.push([r]);
      return perf(r, { costMinor: 100 });
    }),
    ...over,
  };
}

const W = (w: Partial<DashboardWidget> & Pick<DashboardWidget, "id" | "kind">): DashboardWidget => ({ x: 0, y: 0, w: 6, h: 4, ...w });

describe("resolveWidgets", () => {
  it("reads ad KPIs from the loaded ad report, with change and sparkline", async () => {
    const d = deps();
    const out = await resolveWidgets([W({ id: "k", kind: "kpi", metrics: ["ads.spend"] })], ctx(), d);
    expect(out.k).toMatchObject({ kind: "kpi", value: 9000, previous: 4500, changePct: 100, tone: "neutral", spark: [3000, 3000, 3000], hasComparison: true });
    expect(d.calls.ads).toHaveLength(0); // no extra ad queries for the page range
    expect(d.calls.totals).toHaveLength(0);
  });

  it("batches registry metrics into one totals and one series query per period", async () => {
    const d = deps();
    const out = await resolveWidgets(
      [
        W({ id: "a", kind: "kpi", metrics: ["ga4.sessions"] }),
        W({ id: "b", kind: "kpi", metrics: ["gsc.clicks"] }),
        W({ id: "c", kind: "line", metrics: ["ga4.sessions", "ads.clicks"] }),
      ],
      ctx(),
      d,
    );
    // current + comparison
    expect(d.calls.totals).toHaveLength(2);
    expect(d.calls.series).toHaveLength(2);
    expect((d.calls.totals[0][1] as string[]).sort()).toEqual(["ga4.sessions", "gsc.clicks"]);
    expect(out.a).toMatchObject({ kind: "kpi", value: 120, previous: 100, changePct: 20, tone: "good", spark: [50, null, null] });
    // Linked, but nothing stored for the range.
    expect(out.b).toMatchObject({ kind: "empty", reason: "no_data", source: "gsc" });
    expect(out.c).toMatchObject({ kind: "series", dates: ["2026-10-01", "2026-10-02", "2026-10-03"], previousDates: ["2026-09-28", "2026-09-29", "2026-09-30"] });
    if (out.c.kind === "series") {
      expect(out.c.current["ga4.sessions"]).toEqual([50, null, null]);
      expect(out.c.current["ads.clicks"]).toEqual([11, 11, 11]);
      expect(out.c.previous?.["ga4.sessions"]).toEqual([50, null, null]);
    }
  });

  it("shows a 'Connect …' empty state for sources not linked to the client", async () => {
    const out = await resolveWidgets(
      [W({ id: "a", kind: "kpi", metrics: ["callrail.calls"] }), W({ id: "p", kind: "pacing" }), W({ id: "r", kind: "rankings" })],
      ctx({ ads: null, linked: [] }),
      deps(),
    );
    expect(out.a).toEqual({ kind: "empty", reason: "not_connected", source: "callrail", message: "Connect CallRail to see this" });
    expect(out.p).toMatchObject({ kind: "empty", reason: "not_connected", source: "ads", message: "Connect an ad account to see this" });
    expect(out.r).toMatchObject({ kind: "empty", reason: "not_connected", source: "rank" });
  });

  it("builds breakdowns from the metric store and from the ad report", async () => {
    const d = deps();
    const out = await resolveWidgets(
      [
        W({ id: "t", kind: "table", metrics: ["gsc.clicks"], dimension: "query" }),
        W({ id: "p", kind: "pie", metrics: ["ads.spend"], dimension: "platform" }),
        W({ id: "c", kind: "table", metrics: ["ads.clicks", "ads.costPerConversion"], dimension: "campaign" }),
      ],
      ctx(),
      d,
    );
    expect(d.calls.breakdown[0]).toEqual(["c1", "query", ["gsc.clicks"], "2026-10-01", "2026-10-03", 25]);
    expect(out.t).toMatchObject({ kind: "breakdown", dimensionLabel: "Query", rows: [{ label: "dentist near me" }, { label: "(not set)" }] });
    expect(out.p).toMatchObject({ kind: "breakdown", dimensionLabel: "Ad account", rows: [{ label: "Google Ads", values: { "ads.spend": 6000 } }, { label: "Meta Ads", values: { "ads.spend": 3000 } }] });
    // Campaigns with no activity are left out.
    expect(out.c).toMatchObject({ kind: "breakdown", rows: [{ label: "Brand", values: { "ads.clicks": 33, "ads.costPerConversion": 3000 } }] });
  });

  it("breaks ad figures down by platform, adding up accounts on the same platform", async () => {
    const twoGoogle = { ...ads, accounts: [...ads.accounts, { id: "acc3", name: "Second", platform: "GOOGLE_ADS" as const }], perf: { ...ads.perf, byAccount: { ...ads.perf.byAccount, acc3: { ...ads.perf.byAccount.acc1, costMinor: 1000, clicks: 10 } } } };
    const out = await resolveWidgets([W({ id: "n", kind: "bar", metrics: ["ads.spend", "ads.cpc"], dimension: "network" })], ctx({ ads: twoGoogle }), deps());
    // Google Ads: 6,000 + 1,000 spend over 30 + 10 clicks → CPC from the sums (175), not an average of CPCs.
    expect(out.n).toMatchObject({ kind: "breakdown", dimensionLabel: "Platform", rows: [{ label: "Google Ads", values: { "ads.spend": 7000, "ads.cpc": 175 } }, { label: "Meta Ads", values: { "ads.spend": 3000 } }] });
  });

  it("passes the report's account filter to extra ad queries", async () => {
    const d = deps();
    await resolveWidgets([W({ id: "k", kind: "kpi", metrics: ["ads.spend"], range: "last_7" })], ctx({ ads: { ...ads, accountIds: ["acc1"] } }), d);
    expect((d.adPerformance as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2]).toEqual(["acc1"]);
  });

  it("labels a Number tile's comparison by the page's comparison mode", async () => {
    const out = await resolveWidgets([W({ id: "k", kind: "kpi", metrics: ["ads.spend"] })], ctx({ compareMode: "previous_month" }), deps());
    expect(out.k).toMatchObject({ vsLabel: "previous month" });
  });

  it("honours a widget's own range with its own comparison", async () => {
    const d = deps();
    const out = await resolveWidgets([W({ id: "k", kind: "kpi", metrics: ["ads.spend"], range: "last_7" }), W({ id: "g", kind: "kpi", metrics: ["ga4.sessions"], range: "last_7" })], ctx(), d);
    expect(d.calls.ads.map((c) => c[0])).toEqual([{ from: "2026-09-27", to: "2026-10-03" }, { from: "2026-09-20", to: "2026-09-26" }]);
    expect(d.calls.totals.map((c) => c[2])).toEqual(["2026-09-27", "2026-09-20"]);
    expect(out.k).toMatchObject({ kind: "kpi", value: 700 });
  });

  it("passes rankings through the rankings interface, and handles text, pacing, campaigns and unknown metrics", async () => {
    const rows = [{ keyword: "dentist", position: 3, previous: 5 }];
    const d = deps({ keywordRankTable: vi.fn(async () => rows) });
    const out = await resolveWidgets(
      [W({ id: "r", kind: "rankings" }), W({ id: "x", kind: "text", text: "hi" }), W({ id: "p", kind: "pacing" }), W({ id: "c", kind: "campaigns" }), W({ id: "u", kind: "kpi", metrics: ["fb.nope"] })],
      ctx({ linked: ["ads", "rank"] }),
      d,
    );
    expect(d.keywordRankTable).toHaveBeenCalledWith("c1", { from: "2026-10-01", to: "2026-10-03", compareTo: "2026-09-30", limit: 50 });
    expect(out.r).toEqual({ kind: "rankings", rows, hasComparison: true });
    expect(out.x).toEqual({ kind: "text" });
    expect(out.p).toEqual({ kind: "pacing" });
    expect(out.c).toEqual({ kind: "campaigns" });
    expect(out.u).toMatchObject({ kind: "empty", reason: "unknown_metric" });
  });

  it("isolates a failing widget", async () => {
    const d = deps({ metricBreakdown: vi.fn(async () => { throw new Error("db down"); }) as unknown as ResolverDeps["metricBreakdown"] });
    const out = await resolveWidgets([W({ id: "t", kind: "table", metrics: ["gsc.clicks"], dimension: "query" }), W({ id: "k", kind: "kpi", metrics: ["ads.clicks"] })], ctx(), d);
    expect(out.t).toMatchObject({ kind: "empty" });
    expect(out.k).toMatchObject({ kind: "kpi", value: 33 });
  });
});
