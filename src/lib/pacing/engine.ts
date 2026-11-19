import { addDays, assertIsoDate, diffDays, eachDay, maxDate, minDate, type IsoDate } from "./dates";
import { dayWeights, type DateRange, type DistributionConfig } from "./distribution";
import { classifyPacing, DEFAULT_THRESHOLDS, type PacingStatus, type PacingThresholds } from "./status";

/**
 * Budget pacing engine.
 *
 * All money values are integer minor units (cents). Intermediate planned
 * amounts may be fractional; every value returned to callers is rounded to a
 * whole minor unit.
 *
 * Time model: pacing is measured through `asOf`, the last *complete* local day
 * of reporting data (normally yesterday in the client's timezone). Spend on
 * days after asOf is ignored, so a partially reported "today" never distorts
 * pacing. Elapsed days = days from periodStart through asOf, inclusive.
 *
 * With an EVEN distribution and a single budget revision this reduces exactly
 * to the basic formulas:
 *   expected   = budget × elapsedDays / totalDays
 *   pacing %   = actual / expected × 100
 *   projected  = actual / elapsedDays × totalDays
 *   variance   = projected − budget
 */

export type ForecastModel = "STRAIGHT_LINE" | "TRAILING_7_DAY";

export interface BudgetRevisionInput {
  effectiveDate: IsoDate;
  amountMinor: number;
}

export interface PacingInput {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /** Last complete local day of data. May be before periodStart or after periodEnd. */
  asOf: IsoDate;
  /** Budget amount for the whole period, with any mid-period changes. At least one. */
  revisions: BudgetRevisionInput[];
  /** Actual spend per local date, minor units. Missing dates count as zero. */
  dailySpend: Record<IsoDate, number>;
  distribution?: DistributionConfig;
  pauses?: DateRange[];
  forecastModel?: ForecastModel;
  thresholds?: PacingThresholds;
  /**
   * Current combined daily budget on the ad platform, when known. Used only to
   * report the most the platform can still bill this period
   * (`platformSpendCapMinor` = spend to date + this × remaining days); it never
   * changes the forecast. STRAIGHT_LINE stays spentToDate ÷ elapsed × total, so
   * a daily-budget change with no new spend data cannot move it.
   */
  platformDailyBudgetMinor?: number;
}

export interface PacingSeriesPoint {
  date: IsoDate;
  plannedDaily: number;
  plannedCumulative: number;
  /** null for days after asOf */
  actualDaily: number | null;
  actualCumulative: number | null;
  /** null for days before asOf; equals actualCumulative on asOf */
  projectedCumulative: number | null;
}

export type PeriodPhase = "NOT_STARTED" | "ACTIVE" | "ENDED";

export interface PacingResult {
  phase: PeriodPhase;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /** Effective asOf after clamping to the period (null if not started). */
  asOf: IsoDate | null;
  budgetMinor: number;
  actualToDateMinor: number;
  expectedToDateMinor: number;
  remainingBudgetMinor: number;
  /** actual ÷ budget × 100 — share of the monthly budget already spent */
  pctBudgetConsumed: number | null;
  /** elapsed calendar days ÷ total days × 100 */
  pctPeriodElapsed: number;
  /** actual ÷ expected × 100 — this is "pacing", not budget consumed */
  pacingPct: number | null;
  status: PacingStatus;
  /** projected month-end ÷ budget × 100 */
  forecastPct: number | null;
  /**
   * Status of the month-end forecast, using the same thresholds. Can differ
   * from `status`, e.g. after a mid-month budget increase an account can be on
   * plan so far yet projected to fall well short.
   */
  forecastStatus: PacingStatus;
  projectedMinor: number;
  projectedVarianceMinor: number;
  forecastModel: ForecastModel;
  /**
   * Most the platform can still bill this period: spend to date + current daily
   * budget × remaining days, when the daily budget is known. Never applied to the forecast.
   */
  platformSpendCapMinor: number | null;
  totalDays: number;
  elapsedDays: number;
  remainingDays: number;
  /** remaining days with planned spend (weight > 0) */
  remainingActiveDays: number;
  /** Average daily spend needed on remaining active days to land on budget. null if no active days remain. */
  requiredDailyMinor: number | null;
  /** Trailing average daily spend (last up-to-7 elapsed days). */
  currentDailyRateMinor: number;
  /** requiredDaily − currentDailyRate (negative = reduce spend) */
  recommendedDailyChangeMinor: number | null;
  recommendedDailyChangePct: number | null;
  series: PacingSeriesPoint[];
}

const round = (n: number) => Math.round(n);

function forecastClassification(projectedMinor: number, budgetMinor: number, phase: PeriodPhase, status: PacingStatus, t: PacingThresholds) {
  if (phase === "NOT_STARTED") return { forecastPct: null, forecastStatus: status };
  if (budgetMinor === 0) return { forecastPct: null, forecastStatus: projectedMinor > 0 ? ("OVERSPENDING" as const) : status };
  const forecastPct = (projectedMinor / budgetMinor) * 100;
  return { forecastPct, forecastStatus: classifyPacing(forecastPct, t) };
}

export function computePacing(input: PacingInput): PacingResult {
  const { periodStart, periodEnd } = input;
  assertIsoDate(periodStart);
  assertIsoDate(periodEnd);
  assertIsoDate(input.asOf);
  if (periodEnd < periodStart) throw new Error("periodEnd is before periodStart");
  if (input.revisions.length === 0) throw new Error("At least one budget revision is required");
  for (const r of input.revisions) {
    assertIsoDate(r.effectiveDate);
    if (!Number.isInteger(r.amountMinor) || r.amountMinor < 0) {
      throw new Error("Budget amounts must be non-negative integer minor units");
    }
  }

  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const forecastModel = input.forecastModel ?? "STRAIGHT_LINE";
  const days = eachDay(periodStart, periodEnd);
  const totalDays = days.length;
  const weights = dayWeights(periodStart, periodEnd, {
    distribution: input.distribution ?? { mode: "EVEN" },
    pauses: input.pauses,
  });

  const phase: PeriodPhase =
    input.asOf < periodStart ? "NOT_STARTED" : input.asOf >= periodEnd ? "ENDED" : "ACTIVE";
  const asOf = phase === "NOT_STARTED" ? null : minDate(input.asOf, periodEnd);
  const elapsedDays = asOf ? diffDays(periodStart, asOf) + 1 : 0;

  // --- Planned curve, with mid-period revisions -------------------------------
  // A revision effective on day d re-allocates (newBudget − plannedSoFar) over
  // the remaining weighted days, so the planned line is continuous and always
  // ends exactly at the latest budget.
  const revisions = [...input.revisions].sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : 1));
  const initial = [...revisions].reverse().find((r) => r.effectiveDate <= periodStart) ?? revisions[0];
  const laterRevisions = revisions.filter((r) => r.effectiveDate > periodStart && r.effectiveDate <= periodEnd);
  const budgetMinor = laterRevisions.length ? laterRevisions[laterRevisions.length - 1].amountMinor : initial.amountMinor;

  const suffixWeight = new Map<IsoDate, number>();
  {
    let acc = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      acc += weights.get(days[i])!;
      suffixWeight.set(days[i], acc);
    }
  }

  let segmentBudgetRemaining = initial.amountMinor;
  let segmentWeightRemaining = suffixWeight.get(periodStart)!;
  let plannedCum = 0;
  const planned = new Map<IsoDate, { daily: number; cum: number }>();
  for (const d of days) {
    const rev = laterRevisions.filter((r) => r.effectiveDate === d).pop();
    if (rev) {
      segmentBudgetRemaining = Math.max(0, rev.amountMinor - plannedCum);
      segmentWeightRemaining = suffixWeight.get(d)!;
    }
    const w = weights.get(d)!;
    const daily = segmentWeightRemaining > 0 ? (segmentBudgetRemaining * w) / segmentWeightRemaining : 0;
    segmentBudgetRemaining -= daily;
    segmentWeightRemaining -= w;
    plannedCum += daily;
    planned.set(d, { daily, cum: plannedCum });
  }

  // --- Actuals -------------------------------------------------------------
  let actualToDate = 0;
  const actualDaily = new Map<IsoDate, number>();
  for (const d of days) {
    if (asOf && d <= asOf) {
      const v = input.dailySpend[d] ?? 0;
      actualDaily.set(d, v);
      actualToDate += v;
    }
  }
  const expectedToDate = asOf ? planned.get(asOf)!.cum : 0;

  // --- Forecast ------------------------------------------------------------
  const elapsedWeight = asOf ? suffixWeight.get(periodStart)! - (suffixWeight.get(asOf)! - weights.get(asOf)!) : 0;
  const remainingWeight = asOf ? suffixWeight.get(periodStart)! - elapsedWeight : suffixWeight.get(periodStart)!;
  const remainingDaysList = asOf ? days.filter((d) => d > asOf) : days;
  const remainingDays = remainingDaysList.length;
  const remainingActiveDays = remainingDaysList.filter((d) => weights.get(d)! > 0).length;

  // Spend per unit of planned weight, used to project remaining days.
  let ratePerWeight: number | null = null;
  if (asOf) {
    if (forecastModel === "TRAILING_7_DAY") {
      const windowStart = maxDate(periodStart, addDays(asOf, -6));
      let s = 0;
      let w = 0;
      for (const d of eachDay(windowStart, asOf)) {
        s += actualDaily.get(d) ?? 0;
        w += weights.get(d)!;
      }
      if (w > 0) ratePerWeight = s / w;
    }
    if (ratePerWeight === null && elapsedWeight > 0) ratePerWeight = actualToDate / elapsedWeight;
  }

  let projected: number;
  if (!asOf) {
    projected = budgetMinor; // nothing to extrapolate from: assume plan
  } else if (ratePerWeight !== null) {
    projected = actualToDate + ratePerWeight * remainingWeight;
  } else {
    // Spend happened only on zero-weight days: fall back to calendar straight-line.
    projected = elapsedDays > 0 ? (actualToDate / elapsedDays) * totalDays : actualToDate;
  }

  // The platform spend cap is reported, not applied: the forecast is labelled
  // with its model and must follow that model's formula exactly.
  const platformSpendCapMinor =
    input.platformDailyBudgetMinor !== undefined && input.platformDailyBudgetMinor >= 0
      ? round(actualToDate + input.platformDailyBudgetMinor * remainingDays)
      : null;

  // --- Status --------------------------------------------------------------
  let pacingPct: number | null = null;
  let status: PacingStatus;
  if (expectedToDate > 0) {
    pacingPct = (actualToDate / expectedToDate) * 100;
    status = classifyPacing(pacingPct, thresholds);
  } else if (actualToDate > 0) {
    status = "OVERSPENDING"; // spending when nothing was planned
  } else if (budgetMinor === 0) {
    status = "NO_BUDGET";
  } else {
    status = "NOT_STARTED";
  }

  const { forecastPct, forecastStatus } = forecastClassification(round(projected), budgetMinor, phase, status, thresholds);

  // --- Recommendations -----------------------------------------------------
  const remainingBudget = budgetMinor - actualToDate;
  const requiredDaily = remainingActiveDays > 0 ? Math.max(0, remainingBudget) / remainingActiveDays : null;
  let currentRate = 0;
  if (asOf) {
    const windowStart = maxDate(periodStart, addDays(asOf, -6));
    const windowDays = eachDay(windowStart, asOf);
    currentRate = windowDays.reduce((s, d) => s + (actualDaily.get(d) ?? 0), 0) / windowDays.length;
  }
  const change = requiredDaily === null || phase !== "ACTIVE" ? null : requiredDaily - currentRate;
  const changePct = change === null || currentRate === 0 ? null : (change / currentRate) * 100;

  // --- Series --------------------------------------------------------------
  const series: PacingSeriesPoint[] = [];
  let actualCum = 0;
  let projectedCum = actualToDate;
  for (const d of days) {
    const p = planned.get(d)!;
    const isElapsed = asOf !== null && d <= asOf;
    if (isElapsed) actualCum += actualDaily.get(d) ?? 0;
    let projectedPoint: number | null = null;
    if (asOf && d === asOf) projectedPoint = actualToDate;
    if (asOf && d > asOf) {
      projectedCum += ratePerWeight !== null
        ? ratePerWeight * weights.get(d)!
        : (projected - actualToDate) / remainingDays;
      projectedPoint = projectedCum;
    }
    series.push({
      date: d,
      plannedDaily: round(p.daily),
      plannedCumulative: round(p.cum),
      actualDaily: isElapsed ? actualDaily.get(d) ?? 0 : null,
      actualCumulative: isElapsed ? actualCum : null,
      projectedCumulative: projectedPoint === null ? null : round(projectedPoint),
    });
  }

  return {
    phase,
    periodStart,
    periodEnd,
    asOf,
    budgetMinor,
    actualToDateMinor: actualToDate,
    expectedToDateMinor: round(expectedToDate),
    remainingBudgetMinor: remainingBudget,
    pctBudgetConsumed: budgetMinor > 0 ? (actualToDate / budgetMinor) * 100 : null,
    pctPeriodElapsed: (elapsedDays / totalDays) * 100,
    pacingPct,
    status,
    forecastPct,
    forecastStatus,
    projectedMinor: round(projected),
    projectedVarianceMinor: round(projected) - budgetMinor,
    forecastModel,
    platformSpendCapMinor,
    totalDays,
    elapsedDays,
    remainingDays,
    remainingActiveDays,
    requiredDailyMinor: requiredDaily === null ? null : round(requiredDaily),
    currentDailyRateMinor: round(currentRate),
    recommendedDailyChangeMinor: change === null ? null : round(change),
    recommendedDailyChangePct: changePct,
    series,
  };
}

/**
 * Combine independently paced units (e.g. several account budgets of one client)
 * into one result. Units must share the same period. Budgets and spend are
 * summed once per unit, so callers must pass non-overlapping units.
 */
export function combinePacing(results: PacingResult[], thresholds: PacingThresholds = DEFAULT_THRESHOLDS): PacingResult | null {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];
  const first = results[0];
  for (const r of results) {
    if (r.periodStart !== first.periodStart || r.periodEnd !== first.periodEnd) {
      throw new Error("combinePacing requires units with the same budget period");
    }
  }
  const sum = (f: (r: PacingResult) => number) => results.reduce((s, r) => s + f(r), 0);
  const budgetMinor = sum((r) => r.budgetMinor);
  const actual = sum((r) => r.actualToDateMinor);
  const expected = sum((r) => r.expectedToDateMinor);
  const projected = sum((r) => r.projectedMinor);
  // Use the earliest asOf so stale units are never presented as current.
  const asOfs = results.map((r) => r.asOf).filter((d): d is IsoDate => d !== null);
  const asOf = asOfs.length ? asOfs.reduce((a, b) => minDate(a, b)) : null;

  let pacingPct: number | null = null;
  let status: PacingStatus;
  if (expected > 0) {
    pacingPct = (actual / expected) * 100;
    status = classifyPacing(pacingPct, thresholds);
  } else if (actual > 0) status = "OVERSPENDING";
  else if (budgetMinor === 0) status = "NO_BUDGET";
  else status = "NOT_STARTED";

  const phase = results.some((r) => r.phase === "ACTIVE") ? "ACTIVE" : first.phase;
  const { forecastPct, forecastStatus } = forecastClassification(projected, budgetMinor, phase, status, thresholds);
  const required = results.some((r) => r.requiredDailyMinor !== null)
    ? sum((r) => r.requiredDailyMinor ?? 0)
    : null;
  const currentRate = sum((r) => r.currentDailyRateMinor);
  const active = results.some((r) => r.phase === "ACTIVE");
  const change = required === null || !active ? null : required - currentRate;

  const series: PacingSeriesPoint[] = first.series.map((p, i) => {
    const pts = results.map((r) => r.series[i]);
    const nullableSum = (f: (x: PacingSeriesPoint) => number | null) =>
      pts.some((x) => f(x) === null) ? null : pts.reduce((s, x) => s + (f(x) ?? 0), 0);
    return {
      date: p.date,
      plannedDaily: pts.reduce((s, x) => s + x.plannedDaily, 0),
      plannedCumulative: pts.reduce((s, x) => s + x.plannedCumulative, 0),
      actualDaily: nullableSum((x) => x.actualDaily),
      actualCumulative: nullableSum((x) => x.actualCumulative),
      projectedCumulative: nullableSum((x) => x.projectedCumulative),
    };
  });

  return {
    ...first,
    phase,
    asOf,
    budgetMinor,
    actualToDateMinor: actual,
    expectedToDateMinor: expected,
    remainingBudgetMinor: budgetMinor - actual,
    pctBudgetConsumed: budgetMinor > 0 ? (actual / budgetMinor) * 100 : null,
    pacingPct,
    status,
    forecastPct,
    forecastStatus,
    projectedMinor: projected,
    projectedVarianceMinor: projected - budgetMinor,
    platformSpendCapMinor: results.every((r) => r.platformSpendCapMinor !== null)
      ? sum((r) => r.platformSpendCapMinor ?? 0)
      : null,
    elapsedDays: Math.min(...results.map((r) => r.elapsedDays)),
    remainingDays: Math.max(...results.map((r) => r.remainingDays)),
    remainingActiveDays: Math.max(...results.map((r) => r.remainingActiveDays)),
    pctPeriodElapsed: Math.min(...results.map((r) => r.pctPeriodElapsed)),
    requiredDailyMinor: required,
    currentDailyRateMinor: currentRate,
    recommendedDailyChangeMinor: change,
    recommendedDailyChangePct: change === null || currentRate === 0 ? null : (change / currentRate) * 100,
    series,
  };
}
