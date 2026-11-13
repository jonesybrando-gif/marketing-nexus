import { describe, expect, it } from "vitest";
import { autoOverview as autoExecutiveSummary } from "../exec-summary";
import type { AiContextInput } from "../ai-context";
import { emptyTotals, type MetricTotals } from "../metrics";

const t = (o: Partial<MetricTotals>): MetricTotals => ({ ...emptyTotals(), ...o });
const base: AiContextInput = {
  clientName: "ABC Plumbing",
  currency: "USD",
  isDemo: false,
  rangeLabel: "Last 30 days",
  range: { from: "2026-09-17", to: "2026-10-16" },
  comparison: { from: "2026-08-18", to: "2026-09-16" },
  kpis: ["spend"],
  totals: t({ costMinor: 575000, impressions: 16000, clicks: 880, conversions: 79.4, conversionValueMinor: 3336100 }),
  previous: t({ costMinor: 538600, impressions: 14926, clicks: 821, conversions: 75.5, conversionValueMinor: 3170200 }),
  accounts: [],
  campaigns: [
    { name: "Emergency", platform: "Google Ads", status: "ENABLED", totals: t({ costMinor: 287500, conversions: 40.3 }), previous: null },
    { name: "Heaters", platform: "Google Ads", status: "ENABLED", totals: t({ costMinor: 172500, conversions: 23.3 }), previous: null },
  ],
  pacing: {
    periodStart: "2026-10-01", periodEnd: "2026-10-31", asOf: "2026-10-16", status: "OVERSPENDING", forecastStatus: "OVERSPENDING",
    budgetMinor: 500000, actualToDateMinor: 322500, expectedToDateMinor: 258100, projectedMinor: 624900, requiredDailyMinor: 11800, currentDailyRateMinor: 20000, remainingActiveDays: 15, pacingPct: 125,
  },
  notes: [],
};

describe("automatic executive summary", () => {
  it("describes the selected range with changes, results, top campaign and budget", () => {
    const s = autoExecutiveSummary(base);
    const [p1, p2] = s.split("\n\n");
    // Results first, with the cost per result compared in words (a 1.5% change is normal variation).
    expect(p1).toMatch(/^From Sep 17 to Oct 16 you spent \$5,750 and got 79 results at about \$72\.42 each, worth \$33,361 by the ad platforms' count — about the same per result as the previous period\./);
    expect(p1).toContain("ABC Plumbing's ads were shown 16,000 times and clicked 880 times (up 7%).");
    expect(p1).toContain("That is $5.80 in sales for every $1 spent, as credited by the ad platforms (this is not profit).");
    expect(p2).toContain("The largest campaign was Emergency on Google Ads, with $2,875 (50% of spend) and 40.3 conversions.");
    expect(p2).toContain("For October, $3,225 of the $5,000 budget has been spent through Oct 16, ahead of plan; at the current pace the month would end around $6,249 (estimate).");
  });

  it("uses the final budget result for a past month and skips current pacing", () => {
    const s = autoExecutiveSummary({ ...base, rangeLabel: "Last month", range: { from: "2026-09-01", to: "2026-09-30" }, pastBudget: { month: "September 2026", budgetMinor: 500000, spentMinor: 547600, status: "OVERSPENDING" } });
    expect(s).toContain("September 2026 finished at $5,476 against a $5,000 budget (110%).");
    expect(s).not.toContain("For October");
  });

  it("handles no comparison, no results, no activity and demo data", () => {
    const noCmp = autoExecutiveSummary({ ...base, previous: null, totals: t({ costMinor: 10000, clicks: 20 }), campaigns: [], pacing: null });
    expect(noCmp).not.toMatch(/up|down/);
    expect(noCmp).toContain("No conversions or leads were reported, so for now the ads can only be judged on clicks.");
    expect(noCmp).toContain("people clicked your ads 20 times, at about $5.00 per click");
    expect(autoExecutiveSummary({ ...base, totals: emptyTotals(), isDemo: true })).toBe("These figures are illustrative demo data. No advertising activity was recorded for ABC Plumbing from Sep 17 – Oct 16, 2026.");
  });
});

describe("three-question summary", () => {
  const s = { takeaway: "You got 42 leads, 8 more than last month.", happened: "Spend was $5,750 <about the same> & leads rose.", meaning: "Leads are getting cheaper.", recommendations: ["Move budget.", "Fix tracking.", "Test a new ad.", "Fourth."], nextSteps: ["We'll move budget."] };

  it("outlines What happened?, What does this mean? and at most three next steps, without the takeaway", async () => {
    const { summaryOutline } = await import("../exec-summary");
    const out = summaryOutline(s, false);
    expect(out.map((x) => x.title)).toEqual(["What happened?", "What does this mean?", "What should we do next?"]);
    expect(out[2].items).toEqual(["Move budget.", "Fix tracking.", "Test a new ad."]);
    expect(JSON.stringify(out)).not.toContain("42 leads");
    // Clients see the agency's approved steps, or no steps section at all.
    expect(summaryOutline(s, true)[2].items).toEqual(["We'll move budget."]);
    expect(summaryOutline({ ...s, nextSteps: [] }, true).map((x) => x.title)).not.toContain("What should we do next?");
  });

  it("formats text and HTML for email with the takeaway once", async () => {
    const { summaryAsText, summaryAsHtml } = await import("../exec-summary");
    const text = summaryAsText(s, "ABC: summary");
    expect(text.startsWith("ABC: summary\n\nYou got 42 leads, 8 more than last month.\n\nWhat happened?")).toBe(true);
    expect(text.match(/42 leads/g)).toHaveLength(1);
    const html = summaryAsHtml(s, "ABC: summary");
    expect(html).toContain("&lt;about the same&gt; &amp;");
    expect(html).toContain("<ol ");
    expect(html).toMatch(/style="[^"]*font-family:Arial/);
  });

  it("reads an approved summary in the earlier format as the three questions", async () => {
    const { fromLegacySummary } = await import("../exec-summary");
    const out = fromLegacySummary({ overview: "Leads rose 20%. Spend held steady.\n\nBudget is on plan.", working: ["Search did well."], notWorking: ["Display is costly."], recommendations: ["A", "B", "C", "D"], nextSteps: ["We'll do A."] });
    expect(out.takeaway).toBe("Leads rose 20%.");
    expect(out.happened).toBe("Spend held steady. Budget is on plan.");
    expect(out.meaning).toBe("Search did well. Display is costly.");
    expect(out.recommendations).toHaveLength(3);
  });
});
