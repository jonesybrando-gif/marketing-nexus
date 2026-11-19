import { formatMoney } from "./money";
import type { PacingStatus } from "./pacing/status";

export type ActionSeverity = "critical" | "warning" | "info" | "ok";

export interface ActionInput {
  status: PacingStatus;
  /** Month-end forecast status; when worse than `status`, it drives the recommendation. */
  forecastStatus?: PacingStatus;
  currency: string;
  budgetMinor: number;
  actualToDateMinor: number;
  projectedVarianceMinor: number;
  requiredDailyMinor: number | null;
  currentDailyRateMinor: number;
  remainingActiveDays: number;
  phase: "NOT_STARTED" | "ACTIVE" | "ENDED";
  stale: boolean;
  disconnected: boolean;
  /**
   * The client's cost per result is high (≥1.3× its previous period or the
   * agency median, with enough results to judge). Underspend advice then says
   * to fix efficiency before spending more.
   */
  costPerResultHigh?: boolean;
}

/** Required daily spend above this multiple of the recent daily rate is "far below plan". */
export const FAR_BELOW_MULTIPLE = 3;

export interface Action {
  severity: ActionSeverity;
  headline: string;
  detail: string;
}

const money = (m: number, c: string) => formatMoney(Math.abs(m), c, { whole: true });

/** "Reduce" when the needed daily spend is below the current rate, "Increase" when above. */
const changeVerb = (requiredMinor: number, currentMinor: number) => (requiredMinor < currentMinor ? "Reduce" : "Increase");

/**
 * Turns a pacing result into a concrete recommendation. Recommendations are
 * advisory only — the application never changes platform budgets itself.
 */
export function recommendAction(a: ActionInput): Action {
  if (a.disconnected) {
    return { severity: "critical", headline: "Account disconnected", detail: "Reconnect the advertising account. Pacing below uses the last data received and may be out of date." };
  }
  const staleNote = a.stale ? " Data is stale — confirm in the ad platform before acting." : "";
  if (a.phase === "NOT_STARTED") {
    return { severity: "info", headline: "Budget period not started", detail: `No complete days of data yet.${staleNote}` };
  }
  if (a.phase === "ENDED") {
    const v = a.actualToDateMinor - a.budgetMinor;
    return {
      severity: Math.abs(v) <= a.budgetMinor * 0.05 ? "ok" : "warning",
      headline: "Budget period ended",
      detail: v > 0 ? `Finished ${money(v, a.currency)} over budget.` : `Finished ${money(v, a.currency)} under budget.`,
    };
  }
  const days = a.remainingActiveDays;
  // Act on whichever signal is further from target: pace so far, or the month-end forecast.
  const rank: Partial<Record<PacingStatus, number>> = { OVERSPENDING: 2, UNDERSPENDING: 2, SLIGHTLY_OVER: 1, SLIGHTLY_UNDER: 1 };
  const status = a.forecastStatus && (rank[a.forecastStatus] ?? 0) > (rank[a.status] ?? 0) ? a.forecastStatus : a.status;
  const forecastDriven = status !== a.status;
  const why = !forecastDriven
    ? ""
    : a.status === "ON_TARGET"
      ? " Spend so far is on plan, but the current daily rate will not land on the budget."
      : " The month-end forecast is further off than pacing to date suggests.";
  const dayWord = days === 1 ? "day" : "days";
  const req = a.requiredDailyMinor ?? 0;

  switch (status) {
    case "OVERSPENDING":
    case "SLIGHTLY_OVER": {
      const severity: ActionSeverity = status === "OVERSPENDING" ? "critical" : "warning";
      if (a.actualToDateMinor >= a.budgetMinor) {
        return {
          severity: "critical",
          headline: `Budget exhausted (${money(a.actualToDateMinor - a.budgetMinor, a.currency)} over)`,
          detail: `Pause or sharply reduce spend for the remaining ${days} ${dayWord}.${staleNote}`,
        };
      }
      // The verb follows the sign of (required − current), never the status alone.
      const conflict =
        req > a.currentDailyRateMinor
          ? " Spend so far is ahead of plan, but the recent daily rate is already below what the remaining budget allows."
          : "";
      return {
        severity,
        headline: `Projected to overspend by ${money(a.projectedVarianceMinor, a.currency)}`,
        detail: `${changeVerb(req, a.currentDailyRateMinor)} average daily spend from ≈${money(a.currentDailyRateMinor, a.currency)} to ≈${money(req, a.currency)} for the remaining ${days} ${dayWord}.${conflict}${why}${staleNote}`,
      };
    }
    case "UNDERSPENDING":
    case "SLIGHTLY_UNDER": {
      const severity: ActionSeverity = status === "UNDERSPENDING" ? "critical" : "warning";
      const headline = `Projected to underspend by ${money(a.projectedVarianceMinor, a.currency)}`;
      if (days <= 0) return { severity, headline, detail: `No planned days remain in this period.${staleNote}` };
      if (req < a.currentDailyRateMinor) {
        // Forecast says under, but the recent rate already exceeds what is needed: say so, and say Reduce.
        return {
          severity: "warning",
          headline,
          detail: `Reduce average daily spend from ≈${money(a.currentDailyRateMinor, a.currency)} to ≈${money(req, a.currency)} for the remaining ${days} ${dayWord}. The month-end forecast is under budget, but the recent daily rate is already above what is needed to land on it.${staleNote}`,
        };
      }
      return { severity, headline, detail: `${underspendAdvice(a.currentDailyRateMinor, req, a.currency, !!a.costPerResultHigh)}${why}${staleNote}` };
    }
    case "ON_TARGET":
      return { severity: a.stale ? "warning" : "ok", headline: "On target", detail: `No action required.${staleNote}` };
    case "NO_BUDGET":
      return { severity: "info", headline: "No budget set", detail: "Enter a monthly budget to enable pacing." };
    case "NOT_STARTED":
      return { severity: "info", headline: "No spend planned yet", detail: `Planned spend starts later in the period.${staleNote}` };
  }
}

/**
 * What to say about an underspending line. Never pure arithmetic: a huge jump
 * in daily spend usually means the budget itself is out of date, and spending
 * more is only good advice when results are coming in at a reasonable cost.
 */
export function underspendAdvice(currentDailyMinor: number, requiredDailyMinor: number, currency: string, costPerResultHigh: boolean): string {
  const now = money(currentDailyMinor, currency);
  const need = money(requiredDailyMinor, currency);
  const farBelow = requiredDailyMinor > currentDailyMinor * FAR_BELOW_MULTIPLE;
  const plan = farBelow
    ? `Spending is far below plan (≈${now}/day vs ≈${need} needed). Check whether this budget is still right before raising spend.`
    : `Increase average daily spend from ≈${now} to ≈${need} to reach the monthly budget.`;
  if (!costPerResultHigh) return plan;
  return `Underspending, but cost per result is high — improve that before spending more. ${farBelow ? plan : `Reaching the budget would take ≈${need}/day (now ≈${now}).`}`;
}
