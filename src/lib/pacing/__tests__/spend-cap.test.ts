import { describe, expect, it } from "vitest";
import { computePacing } from "../engine";
import { eachDay } from "../dates";
import { googleAdsSpendCap } from "../spend-cap";

const usd = (dollars: number) => Math.round(dollars * 100);
const ads = { platform: "GOOGLE_ADS", monitored: true };
const lsa = { platform: "GOOGLE_LSA", monitored: true };
const enabled = (daily: number | null) => ({ status: "ENABLED", platformDailyBudgetMinor: daily === null ? null : usd(daily) });

describe("googleAdsSpendCap", () => {
  it("is 30.4 x the enabled campaigns' daily budgets for a calendar month", () => {
    // Dr. Shouhed, Nov 2026: MALS $394.74 + Gallbladder $82.24 = $476.98/day
    expect(googleAdsSpendCap("2026-11-01", "2026-11-30", [ads], [enabled(394.74), enabled(82.24)])).toBe(usd(14500.19));
  });

  it("ignores paused campaigns", () => {
    expect(googleAdsSpendCap("2026-11-01", "2026-11-30", [ads], [enabled(100), { status: "PAUSED", platformDailyBudgetMinor: usd(500) }])).toBe(usd(3040));
  });

  it("is unknown when an enabled campaign has no daily budget", () => {
    expect(googleAdsSpendCap("2026-11-01", "2026-11-30", [ads], [enabled(100), enabled(null)])).toBeUndefined();
  });

  it("is unknown when the line includes LSA or another platform", () => {
    expect(googleAdsSpendCap("2026-11-01", "2026-11-30", [ads, lsa], [enabled(100)])).toBeUndefined();
  });

  it("ignores retired accounts when deciding the platform mix", () => {
    expect(googleAdsSpendCap("2026-11-01", "2026-11-30", [ads, { ...lsa, monitored: false }], [enabled(100)])).toBe(usd(3040));
  });

  it("is unknown for a period that is not one whole calendar month", () => {
    expect(googleAdsSpendCap("2026-10-13", "2026-11-12", [ads], [enabled(100)])).toBeUndefined();
    expect(googleAdsSpendCap("2026-11-01", "2026-11-15", [ads], [enabled(100)])).toBeUndefined();
  });
});

describe("computePacing with a platform spend cap", () => {
  // Shouhed-like: $14,500 budget, over-delivering early in the month at ~$518/day.
  const input = {
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    asOf: "2026-11-04",
    revisions: [{ effectiveDate: "2026-11-01", amountMinor: usd(14500) }],
    dailySpend: Object.fromEntries(eachDay("2026-11-01", "2026-11-04").map((d) => [d, usd(518)])),
  };

  it("projects a straight line without a cap", () => {
    const r = computePacing(input);
    expect(r.projectedMinor).toBe(usd(518 * 30));
    expect(r.platformSpendCapMinor).toBeNull();
  });

  it("reports the cap but never applies it to a STRAIGHT_LINE forecast", () => {
    const r = computePacing({ ...input, spendCapMinor: usd(14500) });
    expect(r.forecastModel).toBe("STRAIGHT_LINE");
    expect(r.projectedMinor).toBe(usd(518 * 30));
    expect(r.platformSpendCapMinor).toBe(usd(14500));
    expect(r.series[r.series.length - 1].projectedCumulative).toBe(usd(518 * 30));
  });

  it("does not move the forecast when only the platform daily budget changes", () => {
    const before = computePacing({ ...input, spendCapMinor: Math.round(usd(444.24) * 30.4) });
    const after = computePacing({ ...input, spendCapMinor: Math.round(usd(405) * 30.4) });
    expect(after.projectedMinor).toBe(before.projectedMinor);
    expect(after.forecastStatus).toBe(before.forecastStatus);
  });
});

describe("Dr. Shouhed, Nov 2026 as of Nov 18 (campaign-level lines)", () => {
  // Spend through Nov 18; budgets set so the required daily matches what Nexus reported.
  const line = (spent: number, requiredDaily: number, dailyBudget: number) =>
    computePacing({
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      asOf: "2026-11-18",
      revisions: [{ effectiveDate: "2026-11-01", amountMinor: usd(spent + requiredDaily * 12) }],
      dailySpend: { "2026-11-18": usd(spent) },
      spendCapMinor: Math.round(usd(dailyBudget) * 30.4),
    });

  it("projects spentToDate / 18 x 30 for each campaign line, whatever the daily budget", () => {
    expect(line(7500.51, 50, 340).projectedMinor).toBe(usd(12500.85));
    const gb = line(1609.93, 74.17, 65);
    expect(gb.projectedMinor).toBe(usd(2683.22));
    expect(gb.status).toBe("SLIGHTLY_OVER");
    expect(gb.forecastStatus).toBe("SLIGHTLY_OVER");
  });
});
