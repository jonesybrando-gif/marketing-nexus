import { describe, expect, it } from "vitest";
import { buildAiContext, type AiContextInput } from "../ai-context";
import { emptyTotals, type MetricTotals } from "../metrics";

const t = (o: Partial<MetricTotals>): MetricTotals => ({ ...emptyTotals(), ...o });

const base: AiContextInput = {
  clientName: "ABC Plumbing",
  currency: "USD",
  isDemo: false,
  rangeLabel: "Last month",
  range: { from: "2026-09-01", to: "2026-09-30" },
  comparison: { from: "2026-08-01", to: "2026-08-31" },
  kpis: ["spend", "clicks", "costPerLead", "roas"],
  totals: t({ costMinor: 575000, clicks: 880, conversions: 79.4 }),
  previous: t({ costMinor: 538600, clicks: 821, conversions: 75.5 }),
  accounts: [{ platform: "Google Ads", name: "Search", totals: t({ costMinor: 575000, clicks: 880 }), spendVerified: true, dataNote: null }],
  campaigns: [],
  pacing: null,
  notes: [],
};

describe("AI grounding context", () => {
  it("formats money in currency, never minor units, with changes and direction", () => {
    const text = buildAiContext(base);
    expect(text).toContain("- Ad spend: $5,750; comparison $5,386; change +6.8%");
    expect(text).toContain("- Clicks: 880; comparison 821; change +7.2% (favourable)");
    expect(text).not.toContain("575000");
  });

  it("says 'not reported' rather than zero for metrics nobody reported", () => {
    const text = buildAiContext(base);
    expect(text).toContain("- Cost per lead: not reported");
    expect(text).toContain("- Return on ad spend: not reported");
  });

  it("flags demo data, estimated spend, stale accounts and missing budgets", () => {
    const text = buildAiContext({
      ...base,
      isDemo: true,
      totals: { ...base.totals, hasEstimatedCost: true },
      accounts: [{ platform: "Google LSA", name: "LSA", totals: null, spendVerified: false, dataNote: "stale: last synced Sep 2" }],
    });
    expect(text).toContain("illustrative demo data");
    expect(text).toContain("estimated Local Services Ads cost");
    expect(text).toContain("Google LSA · LSA: no data in this period [spend estimated or incomplete] [stale: last synced Sep 2]");
    expect(text).toContain("No budget is set for the current month.");
  });

  it("adds campaign budget pacing and warns about placeholder conversion values", () => {
    const text = buildAiContext({
      ...base,
      totals: t({ costMinor: 100000, conversions: 50, conversionValueMinor: 5000 }),
      campaigns: [{ name: "Summer", platform: "Google Ads", status: "ENABLED", totals: t({ costMinor: 100000, conversions: 50 }), previous: null, budget: { status: "UNDERSPENDING", currentDailyRateMinor: 6200, requiredDailyMinor: 7900 } }],
    });
    expect(text).toContain("own budget this month: underspending, spending $62 a day against $79 a day needed to land on budget");
    expect(text).toContain("conversion value is exactly 1 per conversion");
  });

  it("writes large differences as multiples", () => {
    const text = buildAiContext({
      ...base,
      totals: t({ costMinor: 100000, clicks: 400, conversions: 100 }),
      previous: t({ costMinor: 100000, clicks: 100, conversions: 100 }),
      campaigns: [
        { name: "Cheap", platform: "Google Ads", status: "ENABLED", totals: t({ costMinor: 10000, conversions: 50 }), previous: null },
        { name: "Costly", platform: "Google Ads", status: "ENABLED", totals: t({ costMinor: 90000, conversions: 2 }), previous: null },
      ],
    });
    expect(text).toContain("- Clicks: 400; comparison 100; change 4.0× (favourable)");
    expect(text).toContain("cost per conversion vs report average: 45.0× the average");
    expect(text).toContain("cost per conversion vs report average: 80% lower");
  });

  it("lists campaigns by spend, capped at 25, and describes pacing", () => {
    const campaigns = Array.from({ length: 30 }, (_, i) => ({ name: `C${i}`, platform: "Meta", status: "ENABLED", totals: t({ costMinor: (i + 1) * 1000 }), previous: null }));
    const text = buildAiContext({
      ...base,
      campaigns,
      pacing: {
        periodStart: "2026-10-01", periodEnd: "2026-10-31", asOf: "2026-10-16", status: "OVERSPENDING", forecastStatus: "OVERSPENDING",
        budgetMinor: 500000, actualToDateMinor: 322500, expectedToDateMinor: 258100, projectedMinor: 624900, requiredDailyMinor: 11800, currentDailyRateMinor: 20000, remainingActiveDays: 15, pacingPct: 125,
      },
    });
    expect(text).toContain("Campaigns by spend (top 25 of 30)");
    expect(text.indexOf("- C29 ")).toBeLessThan(text.indexOf("- C28 "));
    expect(text).not.toContain("- C4 ");
    expect(text).toContain("Budget $5,000; spent $3,225; expected by now $2,581; pacing 125");
    expect(text).toContain("projected $6,249 (+$1,249 vs budget)");
    expect(text).toContain("$118 over 15 remaining days");
  });
});

describe("AI grounding context: website and organic search", () => {
  const web = {
    analytics: [
      { label: "Website visits", value: "4,210", previous: "4,880", changePct: -13.7 },
      { label: "Website goals", value: "96", previous: "121", changePct: -20.7 },
    ],
    channels: [{ channel: "Organic Search", visits: { label: "Website visits", value: "1,940", previous: "2,610", changePct: -25.7 }, goals: { label: "Website goals", value: "38", previous: "57", changePct: -33.3 } }],
    search: [{ label: "Clicks from Google Search", value: "1,702", previous: "2,315", changePct: -26.5 }],
    rankings: { tracked: 24, inTop3: 4, inTop10: 11, improved: 3, declined: 7, changeDays: 30, movers: [{ keyword: "emergency plumber", position: 9, change: -6 }] },
  };

  it("adds website, channel, search and ranking lines with changes", () => {
    const text = buildAiContext({ ...base, web });
    expect(text).toContain("## Website and organic search");
    expect(text).toContain("- Website visits: 4,210; comparison 4,880; change -13.7%");
    expect(text).toContain("- Organic Search: visits 1,940 (-25.7%); website goals 38 (-33.3%)");
    expect(text).toContain("Tracked keyword rankings (24 keywords): 4 in the top 3, 11 in the top 10; over the last 30 days 3 moved up and 7 moved down.");
    expect(text).toContain('- "emergency plumber": now position 9 (down 6 positions)');
    expect(text).toContain("never add them together");
  });

  it("says a linked source with no figures yet is still importing, not that it isn't connected", () => {
    const text = buildAiContext({ ...base, web: { analytics: null, channels: [], search: null, rankings: null, awaitingData: ["ga4", "gsc"] } });
    expect(text).toContain("Google Analytics is linked, but has no figures for this period yet");
    expect(text).toContain("Search Console is linked, but has no figures for this period yet");
    expect(text).not.toContain("not connected");
  });

  it("says which sources aren't connected, and leaves the section out when none are", () => {
    const text = buildAiContext({ ...base, web: { analytics: null, channels: [], search: null, rankings: null } });
    expect(text).toContain("Google Analytics is not connected");
    expect(text).toContain("No keyword rankings are tracked");
    expect(buildAiContext(base)).not.toContain("## Website and organic search");
  });
});
