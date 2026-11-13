import { describe, expect, it } from "vitest";
import { budgetOverview } from "../pacing/overview";
import type { SimpleRow } from "../pacing/simple";

const fmt = (m: number) => `$${Math.round(m / 100)}`;
const row = (o: Partial<SimpleRow>): SimpleRow => ({
  key: Math.random().toString(36),
  clientId: "c",
  clientName: "C",
  platforms: ["GOOGLE_ADS"],
  currency: "USD",
  budgetMinor: 300000,
  spendMinor: 150000,
  elapsedFraction: 0.5,
  asOf: "2026-11-15",
  warning: null,
  edit: null,
  editNote: null,
  daily: null,
  spendToDateMinor: null,
  remainingDays: null,
  recentDailySpendMinor: null,
  ...o,
});

describe("budget overview", () => {
  it("adds budgeted rows, works out expected and projected spend, and calls an even pace on track", () => {
    const o = budgetOverview([row({}), row({ budgetMinor: 100000, spendMinor: 50000, asOf: "2026-11-14" })], "USD", fmt);
    expect(o.budgetMinor).toBe(400000);
    expect(o.spentMinor).toBe(200000);
    expect(o.remainingMinor).toBe(200000);
    expect(o.expectedMinor).toBe(200000);
    expect(o.projectedMinor).toBe(400000);
    expect(o.label).toBe("On track");
    expect(o.asOf).toBe("2026-11-14");
  });

  it("never calls a budget on track just because spend is under budget", () => {
    const o = budgetOverview([row({ spendMinor: 60000, elapsedFraction: 0.8 })], "USD", fmt);
    expect(o.label).toBe("Underpacing");
    expect(o.remainingMinor).toBeGreaterThan(0);
  });

  it("flags overpacing and over budget", () => {
    expect(budgetOverview([row({ spendMinor: 250000 })], "USD", fmt).label).toBe("Overpacing");
    expect(budgetOverview([row({ spendMinor: 310000 })], "USD", fmt).label).toBe("Over budget");
  });

  it("treats missing spend as unknown, never zero, and gives no status on partial data", () => {
    const o = budgetOverview([row({}), row({ spendMinor: null })], "USD", fmt);
    expect(o.incomplete).toBe(true);
    expect(o.label).toBe("Not enough data");
    expect(o.projectedMinor).toBeNull();
    const none = budgetOverview([row({ spendMinor: null })], "USD", fmt);
    expect(none.spentMinor).toBeNull();
    expect(none.remainingMinor).toBeNull();
  });

  it("keeps unbudgeted spend and other currencies out of the totals", () => {
    const o = budgetOverview([row({}), row({ budgetMinor: null, spendMinor: 70000 }), row({ currency: "CAD" })], "USD", fmt);
    expect(o.budgetMinor).toBe(300000);
    expect(o.spentMinor).toBe(150000);
    expect(o.unbudgetedSpendMinor).toBe(70000);
  });

  it("has no status before the first complete day", () => {
    expect(budgetOverview([row({ elapsedFraction: 0, spendMinor: 0 })], "USD", fmt).label).toBe("Not enough data");
  });
});
