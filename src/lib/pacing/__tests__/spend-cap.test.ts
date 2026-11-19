import { describe, expect, it } from "vitest";
import { computePacing } from "../engine";
import { eachDay } from "../dates";
import { googleAdsDailyBudget } from "../spend-cap";

const usd = (dollars: number) => Math.round(dollars * 100);
const ads = { platform: "GOOGLE_ADS", monitored: true };
const lsa = { platform: "GOOGLE_LSA", monitored: true };
const enabled = (daily: number | null) => ({ status: "ENABLED", platformDailyBudgetMinor: daily === null ? null : usd(daily) });

describe("googleAdsDailyBudget", () => {
  it("is the enabled campaigns' combined daily budget for a calendar month", () => {
    // Dr. Shouhed, Nov 19 2026: MALS $340 + Gallbladder $65 = $405/day
    expect(googleAdsDailyBudget("2026-11-01", "2026-11-30", [ads], [enabled(340), enabled(65)])).toBe(usd(405));
  });

  it("ignores paused campaigns", () => {
    expect(googleAdsDailyBudget("2026-11-01", "2026-11-30", [ads], [enabled(100), { status: "PAUSED", platformDailyBudgetMinor: usd(500) }])).toBe(usd(100));
  });

  it("is unknown when an enabled campaign has no daily budget", () => {
    expect(googleAdsDailyBudget("2026-11-01", "2026-11-30", [ads], [enabled(100), enabled(null)])).toBeUndefined();
  });

  it("is unknown when the line includes LSA or another platform", () => {
    expect(googleAdsDailyBudget("2026-11-01", "2026-11-30", [ads, lsa], [enabled(100)])).toBeUndefined();
  });

  it("ignores retired accounts when deciding the platform mix", () => {
    expect(googleAdsDailyBudget("2026-11-01", "2026-11-30", [ads, { ...lsa, monitored: false }], [enabled(100)])).toBe(usd(100));
  });

  it("is unknown for a period that is not one whole calendar month", () => {
    expect(googleAdsDailyBudget("2026-10-13", "2026-11-12", [ads], [enabled(100)])).toBeUndefined();
    expect(googleAdsDailyBudget("2026-11-01", "2026-11-15", [ads], [enabled(100)])).toBeUndefined();
  });
});

describe("computePacing with a platform daily budget", () => {
  // $14,500 budget, $518/day for the first 4 days.
  const input = {
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    asOf: "2026-11-04",
    revisions: [{ effectiveDate: "2026-11-01", amountMinor: usd(14500) }],
    dailySpend: Object.fromEntries(eachDay("2026-11-01", "2026-11-04").map((d) => [d, usd(518)])),
  };

  it("reports no cap when the daily budget is unknown", () => {
    const r = computePacing(input);
    expect(r.projectedMinor).toBe(usd(518 * 30));
    expect(r.platformSpendCapMinor).toBeNull();
  });

  it("caps at spend so far plus the daily budget for the days left, and never applies it to the forecast", () => {
    const r = computePacing({ ...input, platformDailyBudgetMinor: usd(450) });
    expect(r.forecastModel).toBe("STRAIGHT_LINE");
    expect(r.platformSpendCapMinor).toBe(usd(518 * 4 + 450 * 26));
    expect(r.projectedMinor).toBe(usd(518 * 30));
    expect(r.series[r.series.length - 1].projectedCumulative).toBe(usd(518 * 30));
  });

  it("does not move the forecast when only the platform daily budget changes", () => {
    const before = computePacing({ ...input, platformDailyBudgetMinor: usd(444.24) });
    const after = computePacing({ ...input, platformDailyBudgetMinor: usd(405) });
    expect(after.projectedMinor).toBe(before.projectedMinor);
    expect(after.forecastStatus).toBe(before.forecastStatus);
    expect(after.platformSpendCapMinor).toBeLessThan(before.platformSpendCapMinor!);
  });
});

describe("Dr. Shouhed, Nov 2026 as of Nov 18 (campaign-level lines)", () => {
  // Budgets set so the required daily matches what Nexus reported.
  const line = (spent: number, requiredDaily: number, dailyBudget: number) =>
    computePacing({
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      asOf: "2026-11-18",
      revisions: [{ effectiveDate: "2026-11-01", amountMinor: usd(spent + requiredDaily * 12) }],
      dailySpend: { "2026-11-18": usd(spent) },
      platformDailyBudgetMinor: usd(dailyBudget),
    });

  it("projects spentToDate / 18 x 30 for each campaign line, whatever the daily budget", () => {
    expect(line(7500.51, 50, 340).projectedMinor).toBe(usd(12500.85));
    const gb = line(1609.93, 74.17, 65);
    expect(gb.projectedMinor).toBe(usd(2683.22));
    expect(gb.status).toBe("SLIGHTLY_OVER");
    expect(gb.forecastStatus).toBe("SLIGHTLY_OVER");
  });

  it("caps each line at spend so far plus the new daily budget for the 12 days left", () => {
    expect(line(7500.51, 50, 340).platformSpendCapMinor).toBe(usd(7500.51 + 340 * 12));
    expect(line(1609.93, 74.17, 65).platformSpendCapMinor).toBe(usd(1609.93 + 65 * 12));
  });
});
