// Budget Pacing page: one simple row per client and platform, and a three-colour
// status dot. Pure functions so the rules can be unit-tested and reused on the
// client after an inline budget edit.
//
//   Expected spend  = Monthly budget × (elapsed days ÷ days in month)
//   Pacing variance = (Actual − Expected) ÷ Expected × 100
//
// "Elapsed days" are the days with complete reporting data (normally through
// yesterday), so a partly reported today never makes an account look behind.

import type { PlatformKey } from "../platforms";
import { combineDailyBudgets, type CurrentDailyBudget } from "./daily-budget";

/** Status thresholds. Change them here; nothing else needs to move. */
export const SIMPLE_PACING_THRESHOLDS = {
  /** Within ±this percent of expected spend is "on pace". */
  onPacePct: 10,
} as const;

export type SimpleStatus = "OVER_BUDGET" | "OVERSPENDING" | "UNDERSPENDING" | "ON_PACE" | "UNKNOWN";
export type SimpleTone = "red" | "amber" | "green" | "gray";

export const SIMPLE_TONE: Record<SimpleStatus, SimpleTone> = {
  OVER_BUDGET: "red",
  OVERSPENDING: "amber",
  UNDERSPENDING: "amber",
  ON_PACE: "green",
  UNKNOWN: "gray",
};

/** Default sort: worst problems first. */
const SEVERITY: Record<SimpleStatus, number> = { OVER_BUDGET: 4, OVERSPENDING: 3, UNDERSPENDING: 2, ON_PACE: 1, UNKNOWN: 0 };

export interface SimpleRow {
  key: string;
  clientId: string;
  clientName: string;
  /** Platforms behind the row. More than one only for a combined client budget. */
  platforms: PlatformKey[];
  currency: string;
  /** null = no budget set for this client/platform and month. */
  budgetMinor: number | null;
  /** null = no spend data (not connected / never synced). Never shown as $0. */
  spendMinor: number | null;
  /** Share of the month elapsed with complete data, 0..1. null = unknown. */
  elapsedFraction: number | null;
  /** Last day of data counted, for the tooltip. */
  asOf: string | null;
  /** Why the numbers may be incomplete or out of date, if they are. */
  warning: string | null;
  /** How the budget can be changed inline, or null (with editNote saying where). */
  edit: { kind: "revise"; budgetId: string } | { kind: "create"; accountId: string } | null;
  editNote: string | null;
  /** Platforms' current daily budget for the campaigns behind the budget; null when the row has no budget. */
  daily: CurrentDailyBudget | null;
  /** Month-to-date spend including today's spend so far (latest data); null = unknown. */
  spendToDateMinor: number | null;
  /** Days left in the month including today; null for past months. */
  remainingDays: number | null;
}

export interface SimpleStatusInfo {
  status: SimpleStatus;
  tone: SimpleTone;
  /** (actual − expected) ÷ expected × 100, when it can be computed. */
  variancePct: number | null;
  /** Short explanation for the dot's tooltip. */
  message: string;
}

const pct = (n: number) => `${Math.round(Math.abs(n))}%`;

export function classifySimplePacing(
  row: Pick<SimpleRow, "budgetMinor" | "spendMinor" | "elapsedFraction">,
  formatMoney: (minor: number) => string,
  thresholds: { onPacePct: number } = SIMPLE_PACING_THRESHOLDS,
): SimpleStatusInfo {
  const make = (status: SimpleStatus, message: string, variancePct: number | null = null): SimpleStatusInfo => ({ status, tone: SIMPLE_TONE[status], variancePct, message });
  const { budgetMinor: budget, spendMinor: spend, elapsedFraction: f } = row;

  // Missing spend data is never treated as zero spend.
  if (spend === null) return make("UNKNOWN", "No spend data yet — check the account connection.");
  if (budget === null) return make("UNKNOWN", "No budget set for this month.");
  if (spend > budget) return make("OVER_BUDGET", `Over budget — ${formatMoney(spend - budget)} over monthly budget.`);
  if (budget === 0) return make("UNKNOWN", "Budget is $0.");
  if (f === null || f <= 0) return make("UNKNOWN", "Month just started — no complete day of data yet.");

  const expected = budget * Math.min(1, f);
  const variancePct = ((spend - expected) / expected) * 100;
  if (variancePct > thresholds.onPacePct) return make("OVERSPENDING", `Overspending — ${pct(variancePct)} above expected pace.`, variancePct);
  if (variancePct < -thresholds.onPacePct) return make("UNDERSPENDING", `Underspending — ${pct(variancePct)} below expected pace.`, variancePct);
  const dir = Math.round(variancePct) === 0 ? "right at expected" : `${pct(variancePct)} ${variancePct > 0 ? "above" : "below"} expected`;
  return make("ON_PACE", `On pace — spending is ${dir}.`, variancePct);
}

/** Budget Left = Monthly Budget − Budget Used; null when either is unknown. */
export function budgetLeft(row: Pick<SimpleRow, "budgetMinor" | "spendMinor">): number | null {
  return row.budgetMinor === null || row.spendMinor === null ? null : row.budgetMinor - row.spendMinor;
}

/** "-$275" rather than "$-275" or "−$275". */
export function formatSignedMoney(minor: number, format: (absMinor: number) => string): string {
  return minor < 0 ? `-${format(-minor)}` : format(minor);
}

export function platformSortLabel(platforms: PlatformKey[], labels: Record<PlatformKey, string>): string {
  return platforms.map((p) => labels[p]).join(" + ");
}

/**
 * Default order: over budget, overspending, underspending, on pace, then rows
 * with no status. Within a group the largest absolute pacing variance comes
 * first (over-budget rows: largest overage). Ties fall back to client, then platform.
 */
export function prioritySort<R extends SimpleRow>(rows: R[], info: (r: R) => SimpleStatusInfo, platformLabel: (r: R) => string): R[] {
  const magnitude = (r: R, s: SimpleStatusInfo) =>
    s.status === "OVER_BUDGET" && r.budgetMinor !== null && r.spendMinor !== null
      ? r.budgetMinor > 0 ? ((r.spendMinor - r.budgetMinor) / r.budgetMinor) * 100 : Number.MAX_SAFE_INTEGER
      : Math.abs(s.variancePct ?? 0);
  return rows
    .map((r) => ({ r, s: info(r) }))
    .sort(
      (a, b) =>
        SEVERITY[b.s.status] - SEVERITY[a.s.status] ||
        magnitude(b.r, b.s) - magnitude(a.r, a.s) ||
        a.r.clientName.localeCompare(b.r.clientName) ||
        platformLabel(a.r).localeCompare(platformLabel(b.r)),
    )
    .map((x) => x.r);
}

// ---------------------------------------------------------------------------
// Building rows from the pacing engine's budget lines
// ---------------------------------------------------------------------------

/** The parts of a pacing-engine budget line this page needs. */
export interface LineInput {
  key: string;
  clientId: string;
  clientName: string;
  level: "CLIENT" | "ACCOUNT" | "CAMPAIGNS" | "UNBUDGETED";
  platforms: PlatformKey[];
  accountIds: string[];
  currency: string;
  budgetMinor: number | null;
  /** Spend counted against the budget (UNBUDGETED: all of the account's spend). */
  spendMinor: number;
  elapsedDays: number | null;
  totalDays: number | null;
  asOf: string | null;
  notConnected: boolean;
  /** Linked accounts that never synced (no data). */
  hasAccounts: boolean;
  stale: boolean;
  disconnected: boolean;
  spendUnverified: boolean;
  currentDaily?: CurrentDailyBudget | null;
  latestSpendMinor?: number | null;
}

/**
 * Groups budget lines into one row per client and platform:
 * - account and campaign budget lines on the same platform are added together
 *   (different accounts, so nothing is counted twice);
 * - spend with no budget behind it is never added to a budgeted row's Budget
 *   Used; a platform with only unbudgeted spend gets a row with no budget;
 * - a combined client budget can't be split by platform, so it stays one row
 *   listing its platforms.
 * `monthFraction` is the share of the month elapsed for rows with no budget line.
 */
export function buildSimpleRows(lines: LineInput[], monthFraction: (clientId: string) => number | null, remainingDays: (clientId: string) => number | null = () => null): SimpleRow[] {
  const groups = new Map<string, LineInput[]>();
  for (const l of lines) {
    const k = l.level === "CLIENT" || l.platforms.length !== 1 ? `${l.clientId}|${l.key}` : `${l.clientId}|${l.platforms[0]}|${l.currency}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const rows: SimpleRow[] = [];
  for (const [key, group] of groups) {
    const budgeted = group.filter((l) => l.level !== "UNBUDGETED");
    const unbudgeted = group.filter((l) => l.level === "UNBUDGETED");
    const first = group[0];
    const warnings: string[] = [];
    const counted = budgeted.length ? budgeted : unbudgeted;
    const missing = counted.filter((l) => l.notConnected);
    const withData = counted.filter((l) => !l.notConnected);

    if (missing.length) {
      warnings.push(missing.every((l) => !l.hasAccounts) ? "No ad account is linked to this budget." : "An ad account hasn't synced yet, so spend is incomplete.");
    }
    if (withData.some((l) => l.disconnected)) warnings.push("An ad account is disconnected — reconnect it to keep spend current.");
    else if (withData.some((l) => l.stale)) warnings.push("Spend data is out of date (last sync over a day ago).");
    if (withData.some((l) => l.spendUnverified)) warnings.push("The platform didn't report full cost, so spend may be understated.");
    const outside = budgeted.length ? unbudgeted.reduce((s, l) => s + l.spendMinor, 0) : 0;
    if (outside > 0) warnings.push(`Plus spend on campaigns or accounts with no budget, not counted here.`);

    const budgetMinor = budgeted.length ? budgeted.reduce((s, l) => s + (l.budgetMinor ?? 0), 0) : null;
    // No line has data at all → unknown, never $0. Some lines missing → known part, flagged above.
    const spendMinor = withData.length ? withData.reduce((s, l) => s + l.spendMinor, 0) : null;

    let elapsedFraction: number | null;
    const paced = budgeted.filter((l) => !l.notConnected && l.totalDays && l.elapsedDays !== null);
    if (paced.length) {
      const total = paced.reduce((s, l) => s + (l.budgetMinor ?? 0), 0);
      const frac = (l: LineInput) => l.elapsedDays! / l.totalDays!;
      elapsedFraction = total > 0 ? paced.reduce((s, l) => s + (l.budgetMinor ?? 0) * frac(l), 0) / total : paced.reduce((s, l) => s + frac(l), 0) / paced.length;
    } else {
      elapsedFraction = monthFraction(first.clientId);
    }
    const asOfs = withData.map((l) => l.asOf).filter((d): d is string => !!d).sort();

    let edit: SimpleRow["edit"] = null;
    let editNote: string | null = null;
    if (budgeted.length === 1 && (budgeted[0].level === "ACCOUNT" || budgeted[0].level === "CLIENT")) {
      edit = { kind: "revise", budgetId: budgeted[0].key };
    } else if (budgeted.length === 0 && unbudgeted.length === 1 && unbudgeted[0].accountIds.length === 1 && !unbudgeted[0].key.startsWith("unbudgeted-campaigns:")) {
      edit = { kind: "create", accountId: unbudgeted[0].accountIds[0] };
    } else {
      editNote = budgeted.some((l) => l.level === "CAMPAIGNS")
        ? "Set as campaign budgets. Edit them in the client's budgets."
        : "Made up of more than one budget. Edit them in the client's budgets.";
    }

    const latest = budgeted.filter((l) => !l.notConnected && l.latestSpendMinor != null);
    rows.push({
      key,
      daily: budgeted.length ? combineDailyBudgets(budgeted.map((l) => l.currentDaily ?? { minor: null, note: "Current daily budget unavailable." })) : null,
      spendToDateMinor: budgeted.length && latest.length === budgeted.filter((l) => !l.notConnected).length && latest.length ? latest.reduce((s, l) => s + l.latestSpendMinor!, 0) : null,
      remainingDays: remainingDays(first.clientId),
      clientId: first.clientId,
      clientName: first.clientName,
      platforms: [...new Set(group.flatMap((l) => l.platforms))],
      currency: first.currency,
      budgetMinor,
      spendMinor,
      elapsedFraction,
      asOf: asOfs[0] ?? null,
      warning: warnings.length ? warnings.join(" ") : null,
      edit,
      editNote,
    });
  }
  return rows;
}
