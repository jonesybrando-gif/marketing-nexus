// Renders the client report PDF from an in-memory report (no database), so the
// At a glance page and the client/internal variants are exercised everywhere.
import { describe, expect, it } from "vitest";
import { renderClientReportPdf } from "../pdf/reports";
import type { ClientReport } from "../client-report";
import { computePacing } from "@/lib/pacing/engine";
import { DEFAULT_TEMPLATE } from "@/lib/report-template";
import { emptyTotals, type MetricTotals } from "@/lib/metrics";
import { eachDay } from "@/lib/pacing/dates";

const t = (o: Partial<MetricTotals>): MetricTotals => ({ ...emptyTotals(), ...o });

function report(): ClientReport {
  const days = eachDay("2026-10-01", "2026-10-25");
  const total = computePacing({ periodStart: "2026-10-01", periodEnd: "2026-10-31", asOf: "2026-10-25", revisions: [{ effectiveDate: "2026-10-01", amountMinor: 600_000 }], dailySpend: Object.fromEntries(days.map((d) => [d, 20_564])) });
  const cur = t({ costMinor: 514_100, impressions: 40_000, clicks: 1_200, conversions: 30, leads: 0 });
  const prev = t({ costMinor: 480_000, impressions: 38_000, clicks: 1_100, conversions: 22 });
  const account = { id: "a1", platform: "GOOGLE_ADS", name: "Search", externalId: "1234567890", spendIsVerified: true, isDemo: false, status: "ACTIVE", timezone: null, syncRuns: [], campaigns: [{ id: "c1", name: "Emergency", status: "ENABLED" }] };
  return {
    client: { id: "cl", name: "Café Plumbing", currency: "USD", timezone: "America/New_York", agencyId: "ag", goal: "LEADS", accounts: [account] },
    today: "2026-10-26",
    preset: "mtd",
    compareMode: "previous_period",
    range: { from: "2026-10-01", to: "2026-10-25" },
    cmpRange: { from: "2026-09-06", to: "2026-09-30" },
    template: DEFAULT_TEMPLATE,
    hasCustomTemplate: false,
    pacing: { client: { id: "cl", name: "Café Plumbing", timezone: "America/New_York", currency: "USD", managerName: null }, period: { start: "2026-10-01", end: "2026-10-31" }, today: "2026-10-26", thresholds: { under: 85, slightlyUnder: 95, slightlyOver: 105, over: 115 }, rows: [], subRows: [], total, connectedTotal: total, seriesByKey: {}, accounts: [] },
    history: [],
    perf: { totals: cur, byDate: days.map((date) => ({ ...t({ costMinor: 20_564, clicks: 48, conversions: 1 }), date })), byAccount: { a1: cur }, byCampaign: { c1: cur } },
    cmpPerf: { totals: prev, byDate: [], byAccount: { a1: prev }, byCampaign: { c1: prev } },
    notes: [],
    callsFromAds: { current: 14, previous: 11 },
  } as unknown as ClientReport;
}

const brand = { name: "Test Agency", color: "#4f46e5", header: null, footer: null } as never;
const summary = { takeaway: "Leads rose.", happened: "Para.", meaning: "Good and bad.", recommendations: ["Cut keywords."], nextSteps: ["We'll cut keywords."], source: "auto" as const };

describe("client report PDF", () => {
  it("renders the client and internal versions with At a glance first", async () => {
    for (const internal of [false, true]) {
      const pdf = await renderClientReportPdf(report(), brand, { internal, compress: false, executiveSummary: summary });
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(5_000);
      if (process.env.PDF_OUT) (await import("node:fs")).writeFileSync(`${process.env.PDF_OUT}/${internal ? "internal" : "client"}.pdf`, pdf);
    }
  });
});
