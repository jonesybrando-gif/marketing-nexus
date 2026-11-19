import { describe, expect, it } from "vitest";
import { recommendAction, type ActionInput } from "../action-center";

const base: ActionInput = {
  status: "ON_TARGET",
  currency: "USD",
  budgetMinor: 500000,
  actualToDateMinor: 250000,
  projectedVarianceMinor: 0,
  requiredDailyMinor: 16667,
  currentDailyRateMinor: 16667,
  remainingActiveDays: 15,
  phase: "ACTIVE",
  stale: false,
  disconnected: false,
};

describe("recommendAction", () => {
  it("ABC Plumbing: reduce to ≈$120/day", () => {
    const a = recommendAction({
      ...base,
      status: "OVERSPENDING",
      actualToDateMinor: 320000,
      projectedVarianceMinor: 140000,
      requiredDailyMinor: 12000,
      currentDailyRateMinor: 21333,
    });
    expect(a.severity).toBe("critical");
    expect(a.headline).toBe("Projected to overspend by $1,400");
    expect(a.detail).toContain("to ≈$120 for the remaining 15 days");
  });

  it("Dental Group: increase to ≈$340/day", () => {
    const a = recommendAction({
      ...base,
      status: "UNDERSPENDING",
      budgetMinor: 800000,
      actualToDateMinor: 290000,
      projectedVarianceMinor: -220000,
      requiredDailyMinor: 34000,
      currentDailyRateMinor: 19333,
    });
    expect(a.headline).toBe("Projected to underspend by $2,200");
    expect(a.detail).toContain("to ≈$340 to reach the monthly budget");
  });

  it("On target: no action required", () => {
    expect(recommendAction(base)).toEqual({ severity: "ok", headline: "On target", detail: "No action required." });
  });

  it("flags stale and disconnected data", () => {
    expect(recommendAction({ ...base, stale: true }).detail).toContain("stale");
    expect(recommendAction({ ...base, disconnected: true }).severity).toBe("critical");
  });

  it("budget exhausted", () => {
    const a = recommendAction({ ...base, status: "OVERSPENDING", actualToDateMinor: 510000, requiredDailyMinor: 0 });
    expect(a.headline).toContain("Budget exhausted");
  });
});

describe("forecast-driven recommendations", () => {
  it("on plan so far but a mid-month increase will be missed → increase spend", () => {
    const a = recommendAction({
      ...base,
      status: "ON_TARGET",
      forecastStatus: "UNDERSPENDING",
      budgetMinor: 600000,
      actualToDateMinor: 209300,
      projectedVarianceMinor: -194500,
      requiredDailyMinor: 26000,
      currentDailyRateMinor: 13300,
    });
    expect(a.severity).toBe("critical");
    expect(a.headline).toBe("Projected to underspend by $1,945");
    expect(a.detail).toContain("current daily rate will not land on the budget");
  });

  it("a milder forecast does not override a worse pacing status", () => {
    const a = recommendAction({ ...base, status: "OVERSPENDING", forecastStatus: "SLIGHTLY_OVER", projectedVarianceMinor: 50000, requiredDailyMinor: 10000 });
    expect(a.severity).toBe("critical");
    expect(a.detail).not.toContain("current daily rate");
  });
});

describe("underspend advice is not pure arithmetic (H6)", () => {
  const under = { ...base, status: "UNDERSPENDING" as const, projectedVarianceMinor: -1_000_000 };
  it("a huge jump in daily spend asks to check the budget first", () => {
    const a = recommendAction({ ...under, currentDailyRateMinor: 500, requiredDailyMinor: 153_200 });
    expect(a.detail).toContain("Spending is far below plan (≈$5/day vs ≈$1,532 needed). Check whether this budget is still right before raising spend.");
    expect(a.detail).not.toContain("Increase average daily spend");
  });
  it("up to 3× the current rate is ordinary advice", () => {
    const a = recommendAction({ ...under, currentDailyRateMinor: 10000, requiredDailyMinor: 30000 });
    expect(a.detail).toContain("Increase average daily spend from ≈$100 to ≈$300");
  });
  it("a high cost per result says to fix efficiency before spending more", () => {
    const a = recommendAction({ ...under, currentDailyRateMinor: 10000, requiredDailyMinor: 15000, costPerResultHigh: true });
    expect(a.detail.startsWith("Underspending, but cost per result is high — improve that before spending more.")).toBe(true);
    expect(a.detail).not.toContain("Increase average daily spend");
  });
  it("overspend advice is unaffected by cost per result", () => {
    const a = recommendAction({ ...base, status: "OVERSPENDING", projectedVarianceMinor: 50000, requiredDailyMinor: 10000, costPerResultHigh: true });
    expect(a.detail).toContain("Reduce average daily spend");
  });
});

describe("recommendation verb follows the sign of the change", () => {
  it("says Reduce, not Increase, when an under forecast needs less daily spend (Shouhed, Nov 18)", () => {
    const a = recommendAction({
      ...base,
      status: "SLIGHTLY_UNDER",
      forecastStatus: "UNDERSPENDING",
      projectedVarianceMinor: -100000,
      currentDailyRateMinor: 50442,
      requiredDailyMinor: 44913,
      remainingActiveDays: 12,
    });
    expect(a.detail).toContain("Reduce average daily spend from ≈$504 to ≈$449");
    expect(a.detail).not.toContain("Increase");
    expect(a.detail).toContain("the recent daily rate is already above what is needed");
  });
  it("says Increase and notes the disagreement when an over line has slowed below the needed rate", () => {
    const a = recommendAction({
      ...base,
      status: "SLIGHTLY_OVER",
      projectedVarianceMinor: 20000,
      currentDailyRateMinor: 10000,
      requiredDailyMinor: 12000,
    });
    expect(a.detail).toContain("Increase average daily spend from ≈$100 to ≈$120");
    expect(a.detail).toContain("Spend so far is ahead of plan");
  });
});
