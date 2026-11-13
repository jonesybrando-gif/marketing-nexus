// The Budgets tab's month overview: one client's budgeted rows added up into
// Monthly Budget, Spent to Date, Remaining, where spend should be by now and
// where it is heading. Pure, so the rules can be unit-tested.
//
//   Expected by now     = Σ row budget × row's elapsed share of the month
//   Projected month-end = Spent ÷ elapsed share (today's average daily rate)
//
// The elapsed share comes from the days with complete data (the latest synced
// day), so month length and a half-reported today are already handled. Spend
// on accounts with no budget is never added to a budget's spend.

import { classifySimplePacing, type SimpleRow, type SimpleStatus } from "./simple";

export type PacingLabel = "On track" | "Underpacing" | "Overpacing" | "Over budget" | "Not enough data";

export const PACING_LABEL: Record<SimpleStatus, PacingLabel> = {
  ON_PACE: "On track",
  UNDERSPENDING: "Underpacing",
  OVERSPENDING: "Overpacing",
  OVER_BUDGET: "Over budget",
  UNKNOWN: "Not enough data",
};

export interface BudgetOverview {
  currency: string;
  /** Σ monthly budgets; null when no row has a budget. */
  budgetMinor: number | null;
  /** Σ spend on budgeted rows; null when none of them has spend data. */
  spentMinor: number | null;
  /** budget − spent; negative when over. null when either is unknown. */
  remainingMinor: number | null;
  /** Share of the month elapsed with complete data (budget-weighted), 0..1. */
  elapsedFraction: number | null;
  /** Where spend should be by now if it were spread evenly over the month. */
  expectedMinor: number | null;
  /** Spent ÷ elapsed share; null early in the month or without data. */
  projectedMinor: number | null;
  status: SimpleStatus;
  label: PacingLabel;
  message: string;
  /** Latest day of data counted (the earliest across rows, so nothing is overstated). */
  asOf: string | null;
  /** Some budgeted rows have no spend data, so totals are partial. */
  incomplete: boolean;
  /** Spend on accounts with no budget this month (not counted above). */
  unbudgetedSpendMinor: number;
}

/**
 * Adds up one client's rows. A status is given only when every budgeted row
 * has spend data; it compares spend with where it should be by now, so being
 * under budget alone never reads as "On track".
 */
export function budgetOverview(rows: SimpleRow[], currency: string, formatMoney: (minor: number) => string): BudgetOverview {
  const own = rows.filter((r) => r.currency === currency);
  const budgeted = own.filter((r) => r.budgetMinor !== null);
  const unbudgetedSpendMinor = own.filter((r) => r.budgetMinor === null).reduce((s, r) => s + (r.spendMinor ?? 0), 0);
  const budgetMinor = budgeted.length ? budgeted.reduce((s, r) => s + r.budgetMinor!, 0) : null;
  const withSpend = budgeted.filter((r) => r.spendMinor !== null);
  const spentMinor = withSpend.length ? withSpend.reduce((s, r) => s + r.spendMinor!, 0) : null;
  const incomplete = withSpend.length > 0 && withSpend.length < budgeted.length;

  const paced = budgeted.filter((r) => r.elapsedFraction !== null);
  const pacedBudget = paced.reduce((s, r) => s + r.budgetMinor!, 0);
  const elapsedFraction = paced.length ? (pacedBudget > 0 ? paced.reduce((s, r) => s + r.budgetMinor! * Math.min(1, r.elapsedFraction!), 0) / pacedBudget : paced.reduce((s, r) => s + Math.min(1, r.elapsedFraction!), 0) / paced.length) : null;
  const expectedMinor = budgetMinor !== null && paced.length === budgeted.length && elapsedFraction !== null ? Math.round(paced.reduce((s, r) => s + r.budgetMinor! * Math.min(1, r.elapsedFraction!), 0)) : null;
  const projectedMinor = spentMinor !== null && !incomplete && elapsedFraction !== null && elapsedFraction > 0 ? Math.round(spentMinor / elapsedFraction) : null;

  const info = incomplete
    ? { status: "UNKNOWN" as const, message: "Spend is missing for at least one budgeted account, so pacing can't be judged yet." }
    : budgetMinor === null
      ? { status: "UNKNOWN" as const, message: "No budget is set for this month." }
      : classifySimplePacing({ budgetMinor, spendMinor: spentMinor, elapsedFraction }, formatMoney);
  const asOfs = budgeted.map((r) => r.asOf).filter((d): d is string => !!d).sort();

  return {
    currency,
    budgetMinor,
    spentMinor,
    remainingMinor: budgetMinor !== null && spentMinor !== null ? budgetMinor - spentMinor : null,
    elapsedFraction,
    expectedMinor,
    projectedMinor,
    status: info.status,
    label: PACING_LABEL[info.status],
    message: info.message,
    asOf: asOfs[0] ?? null,
    incomplete,
    unbudgetedSpendMinor,
  };
}

/** One row's status label (the account table's Pacing Status). */
export function rowPacingLabel(row: Pick<SimpleRow, "budgetMinor" | "spendMinor" | "elapsedFraction">, formatMoney: (minor: number) => string): { label: PacingLabel; status: SimpleStatus; message: string } {
  const s = classifySimplePacing(row, formatMoney);
  return { label: PACING_LABEL[s.status], status: s.status, message: s.message };
}
