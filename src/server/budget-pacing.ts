import "server-only";
import type { Prisma } from "@prisma/client";
import { loadPacing, type PacingRow } from "./pacing-service";
import { addDays, diffDays, monthBounds, todayInTimeZone, type IsoDate } from "@/lib/pacing/dates";
import { isNotConnected } from "@/lib/pacing/connection";
import { buildSimpleRows, type LineInput, type SimpleRow } from "@/lib/pacing/simple";

/** "2026-11" for the month containing `d`. */
export const monthKey = (d: IsoDate) => d.slice(0, 7);

/** Parses ?month=YYYY-MM; falls back to the current month and never goes past it. */
export function resolveMonth(param: string | undefined, today: IsoDate): { key: string; start: IsoDate; end: IsoDate; isCurrent: boolean } {
  const current = monthKey(today);
  const key = param && /^\d{4}-(0[1-9]|1[0-2])$/.test(param) && param <= current && param >= "2000-01" ? param : current;
  const { start, end } = monthBounds(`${key}-01`);
  return { key, start, end, isCurrent: key === current };
}

function toLine(r: PacingRow): LineInput {
  const notConnected = r.level === "UNBUDGETED" ? isNotConnected("ACCOUNT", r.accounts) : r.notConnected;
  return {
    key: r.key,
    clientId: r.clientId,
    clientName: r.clientName,
    level: r.level,
    platforms: r.platforms,
    accountIds: r.accounts.map((a) => a.id),
    currency: r.currency,
    budgetMinor: r.result ? r.result.budgetMinor : null,
    spendMinor: r.result ? r.result.actualToDateMinor : r.unbudgetedSpendMinor,
    elapsedDays: r.result ? r.result.elapsedDays : null,
    totalDays: r.result ? r.result.totalDays : null,
    asOf: r.result?.asOf ?? null,
    notConnected,
    hasAccounts: r.accounts.length > 0,
    stale: r.stale,
    disconnected: r.disconnected,
    spendUnverified: r.accounts.some((a) => !a.spendIsVerified && !a.isDemo),
    currentDaily: r.currentDaily,
    latestSpendMinor: r.latestSpendMinor,
    recentDailySpendMinor: r.result && !r.notConnected ? r.result.currentDailyRateMinor : null,
  };
}

/**
 * Rows for the Budget Pacing page: one per client and platform, for one
 * calendar month. Reuses the pacing service (budgets, revisions, synced spend,
 * client timezones, account mappings) so the numbers match the rest of the app.
 * Past months use the budgets saved for that month, never the current ones.
 */
export async function loadBudgetPacingRows(where: Prisma.ClientWhereInput, month: { start: IsoDate; end: IsoDate; isCurrent: boolean }, now = new Date()): Promise<SimpleRow[]> {
  const clients = await loadPacing(where, now, month.isCurrent ? undefined : month.start);
  const lines = clients.flatMap((c) => c.rows).map(toLine);
  const tzById = new Map(clients.map((c) => [c.client.id, c.client.timezone]));
  const totalDays = diffDays(month.start, month.end) + 1;
  // Rows with no budget line: elapsed share from the client's last complete day.
  const fraction = (clientId: string) => {
    if (!month.isCurrent) return 1;
    const yesterday = addDays(todayInTimeZone(tzById.get(clientId) ?? "UTC", now), -1);
    if (yesterday < month.start) return 0;
    return Math.min(totalDays, diffDays(month.start, yesterday) + 1) / totalDays;
  };
  // Days left including today, in each client's own time zone (current month only).
  const remaining = (clientId: string) => {
    if (!month.isCurrent) return null;
    const today = todayInTimeZone(tzById.get(clientId) ?? "UTC", now);
    if (today < month.start || today > month.end) return null;
    return diffDays(today, month.end) + 1;
  };
  return buildSimpleRows(lines, fraction, remaining);
}
