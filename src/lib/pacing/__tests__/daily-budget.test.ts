import { describe, expect, it } from "vitest";
import { combineDailyBudgets, compareAdjustments, currentDailyBudget, recommendAdjustment, type AdjustmentInput } from "../daily-budget";

const c = (status: string, daily: number | null, kind: string | null = "DAILY", id: string | null = null) => ({ status, platformDailyBudgetMinor: daily, platformBudgetKind: kind, platformBudgetId: id });

describe("currentDailyBudget", () => {
  it("adds enabled campaigns and counts a shared budget once", () => {
    expect(currentDailyBudget([c("ENABLED", 5000, "DAILY", "g:1"), c("ENABLED", 5000, "DAILY", "g:1"), c("ENABLED", 2500, "DAILY", "g:2"), c("PAUSED", 9999)])).toEqual({ minor: 7500, note: null });
  });
  it("is unknown when a lifetime budget or an unreported budget is active — never estimated", () => {
    expect(currentDailyBudget([c("ENABLED", 5000), c("ENABLED", null, "LIFETIME")]).minor).toBeNull();
    expect(currentDailyBudget([c("ENABLED", 5000), c("ENABLED", null, null)]).minor).toBeNull();
  });
  it("is zero with a note when nothing is running", () => {
    expect(currentDailyBudget([c("PAUSED", 5000)])).toEqual({ minor: 0, note: "No active campaigns." });
  });
  it("combines lines, unknown if any part is unknown", () => {
    expect(combineDailyBudgets([{ minor: 100, note: null }, { minor: 50, note: null }]).minor).toBe(150);
    expect(combineDailyBudgets([{ minor: 100, note: null }, { minor: null, note: "x" }])).toEqual({ minor: null, note: "x" });
  });
});

// $4,500 budget, $2,340 spent → $2,160 left over 18 days = $120/day needed.
const base: AdjustmentInput = { budgetMinor: 450000, spendToDateMinor: 234000, remainingDays: 18, currentDailyMinor: 15000, currentDailyNote: null, recentDailySpendMinor: 15000 };

describe("recommendAdjustment", () => {
  it("spending $150/day when $120/day is needed → Decrease 20%, new daily budget $120", () => {
    expect(recommendAdjustment(base)).toMatchObject({ kind: "DECREASE", tone: "amber", label: "Decrease 20%", pct: -20, remainingMinor: 216000, neededDailyMinor: 12000, recommendedDailyMinor: 12000 });
  });
  it("follows actual spend, not the budget setting: an underspending account is never told to cut", () => {
    // SCMC-like: $6,030/day of budgets but only ~$10/day spent, $9,880 left over 19 days.
    const a = recommendAdjustment({ budgetMinor: 1000000, spendToDateMinor: 12000, remainingDays: 19, currentDailyMinor: 603000, currentDailyNote: null, recentDailySpendMinor: 1000 });
    expect(a.kind).toBe("NEEDS_REVIEW");
    expect(a.note).toMatch(/under its daily budget/);
  });
  it("recommends an increase when spend is limited by the budget, scaling the current budget", () => {
    // Spending its full $100/day budget, needs $120/day.
    expect(recommendAdjustment({ ...base, currentDailyMinor: 10000, recentDailySpendMinor: 10000 })).toMatchObject({ kind: "INCREASE", label: "Increase 20%", pct: 20, recommendedDailyMinor: 12000 });
    // Over-delivering above its $80 budget at $90/day, needs $120/day: still budget-limited.
    expect(recommendAdjustment({ ...base, currentDailyMinor: 8000, recentDailySpendMinor: 9000 })).toMatchObject({ kind: "INCREASE", label: "Increase 33%" });
  });
  it("decreases scale the current budget even when the platform over-delivers", () => {
    // Budget $100/day but spending $200/day (e.g. Google's 2× days); needs $120 → -40% → $60 budget.
    expect(recommendAdjustment({ ...base, currentDailyMinor: 10000, recentDailySpendMinor: 20000 })).toMatchObject({ kind: "DECREASE", label: "Decrease 40%", recommendedDailyMinor: 6000 });
  });
  it("for Local Services (billed per lead) recommends the amount needed per day, not a scaled budget", () => {
    // $66/day budget but $227/day spent; $410 left over 19 days → $22/day.
    const a = recommendAdjustment({ budgetMinor: 200000, spendToDateMinor: 159000, remainingDays: 19, currentDailyMinor: 6600, currentDailyNote: null, recentDailySpendMinor: 22700, budgetTracksSpend: false });
    expect(a).toMatchObject({ kind: "DECREASE", neededDailyMinor: 2158, recommendedDailyMinor: 2158 });
    expect(a.note).toMatch(/per lead/);
    // An LSA account spending under its budget still gets an increase (no "not budget-limited" check).
    expect(recommendAdjustment({ ...base, currentDailyMinor: 20000, recentDailySpendMinor: 9000, budgetTracksSpend: false }).kind).toBe("INCREASE");
  });
  it("is No Change within ±10% of what is needed", () => {
    expect(recommendAdjustment({ ...base, recentDailySpendMinor: 12500 })).toMatchObject({ kind: "NO_CHANGE", tone: "green", label: "No Change" });
    expect(recommendAdjustment({ ...base, recentDailySpendMinor: 11000 }).kind).toBe("NO_CHANGE"); // +9.1%
  });
  it("says Pause / Review once the budget is used up and never recommends a negative budget", () => {
    expect(recommendAdjustment({ ...base, spendToDateMinor: 460000 })).toMatchObject({ kind: "PAUSE", tone: "red", label: "Pause / Review", recommendedDailyMinor: 0 });
    expect(recommendAdjustment({ ...base, spendToDateMinor: 450000 }).kind).toBe("PAUSE");
  });
  it("says Needs Review when the daily budget or spend is unknown, nothing is running, or nothing is spending", () => {
    const a = recommendAdjustment({ ...base, currentDailyMinor: null, currentDailyNote: "Lifetime budget" });
    expect(a).toMatchObject({ kind: "NEEDS_REVIEW", label: "Needs Review", neededDailyMinor: 12000, note: "Lifetime budget" });
    expect(recommendAdjustment({ ...base, currentDailyMinor: 0 }).kind).toBe("NEEDS_REVIEW");
    expect(recommendAdjustment({ ...base, spendToDateMinor: null }).kind).toBe("NEEDS_REVIEW");
    expect(recommendAdjustment({ ...base, recentDailySpendMinor: 0 }).kind).toBe("NEEDS_REVIEW");
    expect(recommendAdjustment({ ...base, recentDailySpendMinor: null }).kind).toBe("NEEDS_REVIEW");
  });
  it("shows nothing without a budget", () => {
    expect(recommendAdjustment({ ...base, budgetMinor: null }).kind).toBe("NONE");
  });
  it("shows how a past month finished instead of a recommendation", () => {
    expect(recommendAdjustment({ ...base, remainingDays: null, spendToDateMinor: 470000 })).toMatchObject({ kind: "ENDED_OVER", tone: "red" });
    expect(recommendAdjustment({ ...base, remainingDays: null, spendToDateMinor: 300000 })).toMatchObject({ kind: "ENDED_UNDER", label: "Ended 33% under" });
    expect(recommendAdjustment({ ...base, remainingDays: null, spendToDateMinor: 440000 }).kind).toBe("ENDED_ON_TARGET");
  });
  it("orders Pause / Review, largest decreases, largest increases, then No Change", () => {
    const b = (rate: number) => recommendAdjustment({ ...base, currentDailyMinor: rate, recentDailySpendMinor: rate });
    const list = [b(12500), b(10000), b(30000), recommendAdjustment({ ...base, spendToDateMinor: 500000 }), b(8000), b(15000)];
    expect(list.sort(compareAdjustments).map((a) => a.label)).toEqual(["Pause / Review", "Decrease 60%", "Decrease 20%", "Increase 50%", "Increase 20%", "No Change"]);
  });
});
