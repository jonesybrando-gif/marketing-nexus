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

const base: AdjustmentInput = { budgetMinor: 450000, spendToDateMinor: 234000, remainingDays: 18, currentDailyMinor: 15000, currentDailyNote: null };

describe("recommendAdjustment", () => {
  it("matches the spec example: $2,160 left over 18 days at $150/day → Decrease 20%", () => {
    const a = recommendAdjustment(base);
    expect(a).toMatchObject({ kind: "DECREASE", tone: "amber", label: "Decrease 20%", pct: -20, remainingMinor: 216000, recommendedDailyMinor: 12000 });
  });
  it("recommends increases with the real percentage", () => {
    expect(recommendAdjustment({ ...base, currentDailyMinor: 10000 })).toMatchObject({ kind: "INCREASE", label: "Increase 20%", pct: 20 });
    expect(recommendAdjustment({ ...base, currentDailyMinor: 8000 }).label).toBe("Increase 50%");
  });
  it("is No Change within ±10%", () => {
    expect(recommendAdjustment({ ...base, currentDailyMinor: 12500 })).toMatchObject({ kind: "NO_CHANGE", tone: "green", label: "No Change" });
    expect(recommendAdjustment({ ...base, currentDailyMinor: 11000 }).kind).toBe("NO_CHANGE"); // +9.1%
  });
  it("says Pause / Review once the budget is used up and never recommends a negative budget", () => {
    const a = recommendAdjustment({ ...base, spendToDateMinor: 460000 });
    expect(a).toMatchObject({ kind: "PAUSE", tone: "red", label: "Pause / Review", recommendedDailyMinor: 0 });
    expect(recommendAdjustment({ ...base, spendToDateMinor: 450000 }).kind).toBe("PAUSE");
  });
  it("says Needs Review when the current daily budget is unknown or zero, and still gives the recommended daily", () => {
    const a = recommendAdjustment({ ...base, currentDailyMinor: null, currentDailyNote: "Lifetime budget" });
    expect(a).toMatchObject({ kind: "NEEDS_REVIEW", label: "Needs Review", recommendedDailyMinor: 12000, note: "Lifetime budget" });
    expect(recommendAdjustment({ ...base, currentDailyMinor: 0 }).kind).toBe("NEEDS_REVIEW");
    expect(recommendAdjustment({ ...base, spendToDateMinor: null }).kind).toBe("NEEDS_REVIEW");
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
    const list = [
      recommendAdjustment({ ...base, currentDailyMinor: 12500 }), // no change
      recommendAdjustment({ ...base, currentDailyMinor: 10000 }), // +20
      recommendAdjustment({ ...base, currentDailyMinor: 30000 }), // -60
      recommendAdjustment({ ...base, spendToDateMinor: 500000 }), // pause
      recommendAdjustment({ ...base, currentDailyMinor: 8000 }), // +50
      recommendAdjustment(base), // -20
    ];
    expect(list.sort(compareAdjustments).map((a) => a.label)).toEqual(["Pause / Review", "Decrease 60%", "Decrease 20%", "Increase 50%", "Increase 20%", "No Change"]);
  });
});
