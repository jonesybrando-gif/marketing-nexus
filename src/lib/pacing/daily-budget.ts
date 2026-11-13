// Current daily budget behind a budget line, and the daily budget adjustment
// needed to finish the month on budget (Budget Pacing "Adjustment Needed").
// Pure functions: advisory only, nothing here changes a platform budget.

/** Within ±this percent of the current daily budget is "No change". Change it here. */
export const ADJUSTMENT_THRESHOLD_PCT = 10;

export interface CampaignBudgetInfo {
  status: string;
  platformDailyBudgetMinor: bigint | number | null;
  platformBudgetId?: string | null;
  platformBudgetKind?: string | null;
}

export interface CurrentDailyBudget {
  /** Sum of the active campaigns' daily budgets (shared budgets once); null = not known. */
  minor: number | null;
  /** Why it is null or zero, for the tooltip. */
  note: string | null;
}

/**
 * The platform's current daily budget for a set of campaigns: enabled campaigns
 * only, each shared budget counted once. Unknown (null) when any enabled
 * campaign's budget isn't reported or is a lifetime/total budget — never
 * estimated from the monthly budget.
 */
export function currentDailyBudget(campaigns: CampaignBudgetInfo[]): CurrentDailyBudget {
  const enabled = campaigns.filter((c) => c.status === "ENABLED");
  if (enabled.length === 0) return { minor: 0, note: "No active campaigns." };
  if (enabled.some((c) => c.platformBudgetKind === "LIFETIME")) return { minor: null, note: "A campaign uses a lifetime or total budget, so there is no fixed daily budget." };
  if (enabled.some((c) => c.platformBudgetKind !== "DAILY" || c.platformDailyBudgetMinor === null)) return { minor: null, note: "The platform hasn't reported a daily budget for every active campaign." };
  const seen = new Set<string>();
  let total = 0;
  for (const c of enabled) {
    if (c.platformBudgetId) {
      if (seen.has(c.platformBudgetId)) continue;
      seen.add(c.platformBudgetId);
    }
    total += Number(c.platformDailyBudgetMinor);
  }
  return { minor: total, note: null };
}

/** Adds the daily budgets of several lines; unknown if any is unknown. */
export function combineDailyBudgets(parts: CurrentDailyBudget[]): CurrentDailyBudget {
  if (parts.length === 0) return { minor: null, note: "No campaigns linked." };
  const unknown = parts.find((p) => p.minor === null);
  if (unknown) return unknown;
  const minor = parts.reduce((s, p) => s + p.minor!, 0);
  return { minor, note: minor === 0 ? "No active campaigns." : null };
}

export type AdjustmentKind = "PAUSE" | "DECREASE" | "INCREASE" | "NO_CHANGE" | "NEEDS_REVIEW" | "NONE" | "ENDED_OVER" | "ENDED_UNDER" | "ENDED_ON_TARGET";

export interface AdjustmentInput {
  budgetMinor: number | null;
  /** Month-to-date spend including what is already spent today. null = unknown. */
  spendToDateMinor: number | null;
  /** Days left in the month including today; null for past months. */
  remainingDays: number | null;
  currentDailyMinor: number | null;
  currentDailyNote: string | null;
  /** What the account actually spends per day lately (7-day average through the last complete day). null = unknown. */
  recentDailySpendMinor?: number | null;
}

export interface Adjustment {
  kind: AdjustmentKind;
  tone: "red" | "amber" | "green" | "gray";
  /** Short label for the cell: "Increase 15%", "Decrease 20%", "No Change"… */
  label: string;
  /** Rounded percentage change to daily spend (signed), when computed. */
  pct: number | null;
  remainingMinor: number | null;
  /** Spend needed per day, from today, to finish on budget. */
  neededDailyMinor: number | null;
  /** Suggested daily budget setting (current budget scaled by pct), when it makes sense. */
  recommendedDailyMinor: number | null;
  /** Extra explanation for the tooltip. */
  note: string | null;
}

/** Below this share of its daily budget, an account isn't limited by budget, so raising it may not raise spend. */
export const BUDGET_LIMITED_SHARE = 0.8;

/**
 * Direction follows what the account actually spends, not what its daily
 * budgets allow: platforms often spend well below the daily budget, and
 * comparing with the budget alone would tell an underspending account to cut.
 *
 *   needed per day = (monthly budget − spend so far, incl. today) ÷ days left incl. today
 *   adjustment %   = (needed per day − recent daily spend) ÷ recent daily spend × 100
 *   new daily budget = current daily budget × (1 + adjustment %)
 *
 * An increase for an account spending well under its daily budget is "Needs
 * Review": a higher budget won't help; bids, targeting or limits are holding it back.
 */
export function recommendAdjustment(i: AdjustmentInput, thresholdPct = ADJUSTMENT_THRESHOLD_PCT): Adjustment {
  const out = (kind: AdjustmentKind, label: string, extra: Partial<Adjustment> = {}): Adjustment => ({
    kind,
    tone: kind === "PAUSE" || kind === "ENDED_OVER" ? "red" : kind === "INCREASE" || kind === "DECREASE" || kind === "ENDED_UNDER" ? "amber" : kind === "NO_CHANGE" || kind === "ENDED_ON_TARGET" ? "green" : "gray",
    label,
    pct: null,
    remainingMinor: null,
    neededDailyMinor: null,
    recommendedDailyMinor: null,
    note: null,
    ...extra,
  });
  if (i.budgetMinor === null) return out("NONE", "—", { note: "No monthly budget set." });
  if (i.remainingDays === null || i.remainingDays <= 0) {
    // Past month: how it finished, not a recommendation for today.
    if (i.spendToDateMinor === null) return out("NONE", "—", { note: "No spend data for this month." });
    const remainingMinor = i.budgetMinor - i.spendToDateMinor;
    const note = "Past month: how the month finished. Daily budget recommendations are for the current month only.";
    if (remainingMinor < 0) return out("ENDED_OVER", "Ended over budget", { remainingMinor, note });
    const pct = i.budgetMinor > 0 ? Math.round((i.spendToDateMinor / i.budgetMinor - 1) * 100) : 0;
    if (pct < -thresholdPct) return out("ENDED_UNDER", `Ended ${Math.abs(pct)}% under`, { remainingMinor, pct, note });
    return out("ENDED_ON_TARGET", "Ended on target", { remainingMinor, pct, note });
  }
  if (i.spendToDateMinor === null) return out("NEEDS_REVIEW", "Needs Review", { note: "No spend data yet." });

  const remainingMinor = i.budgetMinor - i.spendToDateMinor;
  if (remainingMinor <= 0) return out("PAUSE", "Pause / Review", { remainingMinor, neededDailyMinor: 0, recommendedDailyMinor: 0, note: "The monthly budget is used up." });
  const neededDailyMinor = Math.round(remainingMinor / i.remainingDays);
  const base = { remainingMinor, neededDailyMinor };
  if (i.currentDailyMinor === null) return out("NEEDS_REVIEW", "Needs Review", { ...base, note: i.currentDailyNote ?? "Current daily budget unavailable." });
  if (i.currentDailyMinor === 0) return out("NEEDS_REVIEW", "Needs Review", { ...base, note: i.currentDailyNote ?? "No active campaigns." });
  const rate = i.recentDailySpendMinor ?? null;
  if (rate === null) return out("NEEDS_REVIEW", "Needs Review", { ...base, note: "Recent daily spend unavailable." });
  if (rate <= 0) return out("NEEDS_REVIEW", "Needs Review", { ...base, note: "No spend in the last 7 days although campaigns are active. Check the campaigns." });

  const raw = ((neededDailyMinor - rate) / rate) * 100;
  const pct = Math.round(raw);
  const scaled = Math.max(0, Math.round(i.currentDailyMinor * (neededDailyMinor / rate)));
  if (raw > thresholdPct) {
    if (rate < i.currentDailyMinor * BUDGET_LIMITED_SHARE) {
      return out("NEEDS_REVIEW", "Needs Review", {
        ...base,
        pct,
        note: "Spending well under its daily budget, so raising the budget may not raise spend. Check bids, targeting or campaign limits.",
      });
    }
    return out("INCREASE", `Increase ${pct}%`, { ...base, pct, recommendedDailyMinor: scaled });
  }
  if (raw < -thresholdPct) return out("DECREASE", `Decrease ${Math.abs(pct)}%`, { ...base, pct, recommendedDailyMinor: scaled });
  return out("NO_CHANGE", "No Change", { ...base, pct, recommendedDailyMinor: i.currentDailyMinor });
}

const RANK: Record<AdjustmentKind, number> = { PAUSE: 5, ENDED_OVER: 5, DECREASE: 4, INCREASE: 3, ENDED_UNDER: 3, NEEDS_REVIEW: 2, NO_CHANGE: 1, ENDED_ON_TARGET: 1, NONE: 0 };

/** Most urgent first: Pause / Review, biggest decreases, biggest increases, Needs Review, No Change, none. */
export function compareAdjustments(a: Adjustment, b: Adjustment): number {
  return RANK[b.kind] - RANK[a.kind] || Math.abs(b.pct ?? 0) - Math.abs(a.pct ?? 0) || (a.remainingMinor ?? 0) - (b.remainingMinor ?? 0);
}
