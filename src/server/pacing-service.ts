import "server-only";
import { isAccountDisconnected } from "@/lib/account-health";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { INCLUDED_ROWS } from "./campaign-selection";
import { addDays, dateToIso, isoToDate, minDate, monthBounds, todayInTimeZone, type IsoDate } from "@/lib/pacing/dates";
import { combinePacing, computePacing, type PacingResult } from "@/lib/pacing/engine";
import type { DistributionConfig, DateRange } from "@/lib/pacing/distribution";
import { resolveBudgetHierarchy, spendForUnit, spendOutsideCampaignBudgets, type PacingUnit, type SpendRow } from "@/lib/pacing/rollup";
import { DEFAULT_THRESHOLDS, needsAttention, type PacingThresholds } from "@/lib/pacing/status";
import { recommendAction, type Action } from "@/lib/action-center";
import { isNotConnected } from "@/lib/pacing/connection";
import { googleAdsSpendCap } from "@/lib/pacing/spend-cap";
import { formatDate } from "@/lib/time";
import type { PlatformKey } from "@/lib/platforms";
import { rollForwardBudgets } from "./budget-rollover";

/** An account whose last successful sync is older than this is shown as stale. */
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

const clientInclude = {
  primaryManager: { select: { id: true, name: true } },
  // Removed campaigns are left out of pacing, reports and alerts entirely.
  accounts: { include: { campaigns: { where: { excludedAt: null }, select: { id: true, accountId: true, name: true, status: true, platformDailyBudgetMinor: true } } } },
  agency: { select: { thresholdUnder: true, thresholdSlightlyUnder: true, thresholdSlightlyOver: true, thresholdOver: true } },
} satisfies Prisma.ClientInclude;

type ClientWithAccounts = Prisma.ClientGetPayload<{ include: typeof clientInclude }>;
type BudgetWithRevisions = Prisma.BudgetGetPayload<{ include: { revisions: true } }>;

export interface AccountMeta {
  id: string;
  name: string;
  platform: PlatformKey;
  externalId: string;
  currency: string;
  isDemo: boolean;
  spendIsVerified: boolean;
  status: string;
  /** False for an account kept only for history (stopped tracking or replaced). */
  monitored: boolean;
  lastSuccessfulSyncAt: string | null;
  dataCompleteThrough: IsoDate | null;
  timezone: string | null;
  stale: boolean;
}

export type RowLevel = "CLIENT" | "ACCOUNT" | "CAMPAIGNS" | "UNBUDGETED";

/** One budget line on the agency dashboard. Result has no series (kept small). */
export interface PacingRow {
  key: string;
  clientId: string;
  clientName: string;
  managerName: string | null;
  level: RowLevel;
  label: string;
  platforms: PlatformKey[];
  accounts: AccountMeta[];
  currency: string;
  result: Omit<PacingResult, "series"> | null;
  /** UNBUDGETED rows: spend with no budget behind it */
  unbudgetedSpendMinor: number;
  lastSuccessfulSyncAt: string | null;
  stale: boolean;
  disconnected: boolean;
  /**
   * A budget line with no ad account linked, or whose accounts have never
   * synced. It has no data to pace, so it is shown as "Not connected" and kept
   * out of agency totals, the Daily Action Center and alerts.
   */
  notConnected: boolean;
  isDemo: boolean;
  hasEstimatedSpend: boolean;
  warnings: string[];
  action: Action;
  attention: boolean;
}

export interface ClientPacing {
  client: { id: string; name: string; timezone: string; currency: string; managerName: string | null };
  period: { start: IsoDate; end: IsoDate };
  today: IsoDate;
  thresholds: PacingThresholds;
  rows: PacingRow[];
  subRows: PacingRow[];
  /** Combined client result including series, or null if no budgets. */
  total: PacingResult | null;
  /** Combined result of the lines that have data (excludes not-connected lines); used for agency totals. */
  connectedTotal: PacingResult | null;
  /** Full series for every row and sub-row, keyed by row key. */
  seriesByKey: Record<string, PacingResult["series"]>;
  accounts: AccountMeta[];
}

function thresholdsFor(client: ClientWithAccounts): PacingThresholds {
  const n = (v: Prisma.Decimal | null | undefined, d: number) => (v == null ? d : Number(v));
  const a = client.agency;
  return {
    under: n(client.thresholdUnder, n(a.thresholdUnder, DEFAULT_THRESHOLDS.under)),
    slightlyUnder: n(client.thresholdSlightlyUnder, n(a.thresholdSlightlyUnder, DEFAULT_THRESHOLDS.slightlyUnder)),
    slightlyOver: n(client.thresholdSlightlyOver, n(a.thresholdSlightlyOver, DEFAULT_THRESHOLDS.slightlyOver)),
    over: n(client.thresholdOver, n(a.thresholdOver, DEFAULT_THRESHOLDS.over)),
  };
}

function distributionFor(b: BudgetWithRevisions): DistributionConfig {
  switch (b.distribution) {
    case "EVEN":
      return { mode: "EVEN" };
    case "BUSINESS_DAYS":
      return { mode: "BUSINESS_DAYS" };
    case "WEEKEND_WEIGHTED":
      return { mode: "WEEKEND_WEIGHTED", weekendWeight: Number(b.weekendWeight ?? 1) };
    case "CUSTOM_WEEKDAY":
      return { mode: "CUSTOM_WEEKDAY", weekdayWeights: (b.weekdayWeights as number[]) ?? [1, 1, 1, 1, 1, 1, 1] };
    case "CUSTOM_DAILY":
      return { mode: "CUSTOM_DAILY", dailyWeights: (b.dailyWeights as Record<string, number>) ?? {} };
  }
}

function accountMeta(a: ClientWithAccounts["accounts"][number], now: Date): AccountMeta {
  const last = a.lastSuccessfulSyncAt;
  return {
    id: a.id,
    name: a.name,
    platform: a.platform,
    externalId: a.externalId,
    currency: a.currency,
    isDemo: a.isDemo,
    spendIsVerified: a.spendIsVerified,
    status: a.status,
    monitored: a.isDemo || !!a.connectionId,
    lastSuccessfulSyncAt: last?.toISOString() ?? null,
    dataCompleteThrough: a.dataCompleteThrough ? dateToIso(a.dataCompleteThrough) : null,
    timezone: a.timezone,
    stale: !last || now.getTime() - last.getTime() > STALE_AFTER_MS,
  };
}

interface UnitContext {
  client: ClientWithAccounts;
  accounts: AccountMeta[];
  rows: (SpendRow & { costIsEstimated: boolean })[];
  yesterday: IsoDate;
  thresholds: PacingThresholds;
}

function paceUnit(unit: PacingUnit, budget: BudgetWithRevisions, ctx: UnitContext, campaignAccount: Map<string, string>) {
  const accountIds = unit.scope === "CAMPAIGN" ? unit.campaignIds.map((c) => campaignAccount.get(c)!) : unit.accountIds;
  const accts = ctx.accounts.filter((a) => accountIds.includes(a.id));
  const periodStart = dateToIso(budget.periodStart);
  const periodEnd = dateToIso(budget.periodEnd);
  const warnings: string[] = [];

  // Never pace past the last day every involved account has complete data for.
  // Retired accounts (replaced or stopped: no connection) never sync again, so
  // they must not hold the date back; their past spend still counts below.
  // If every account is retired, fall back to all of them.
  const live = accts.filter((a) => a.monitored);
  const dateAccts = live.length ? live : accts;
  let asOf = ctx.yesterday;
  for (const a of dateAccts) {
    if (!a.dataCompleteThrough) {
      warnings.push(`${a.name}: no reporting data received yet`);
      asOf = addDays(periodStart, -1);
    } else {
      if (a.dataCompleteThrough < ctx.yesterday && a.dataCompleteThrough >= periodStart) {
        warnings.push(`${a.name}: data complete only through ${formatDate(a.dataCompleteThrough)}`);
      }
      asOf = minDate(asOf, a.dataCompleteThrough);
    }
    if (a.currency !== budget.currency) {
      warnings.push(`${a.name} reports in ${a.currency} but the budget is in ${budget.currency}; currency conversion is not applied yet`);
    }
    if (a.timezone && a.timezone !== ctx.client.timezone) {
      warnings.push(`${a.name} reports in ${a.timezone} but the client uses ${ctx.client.timezone}; daily totals follow the ad platform's day boundaries`);
    }
    if (!a.spendIsVerified) {
      warnings.push(
        a.isDemo
          ? `${a.name}: spend is estimated — the platform API does not report verified daily cost`
          : `${a.name}: the platform reported charged leads but no cost, so spend is incomplete and pacing for this line is unreliable`,
      );
    }
  }

  const result = computePacing({
    periodStart,
    periodEnd,
    asOf,
    revisions: budget.revisions.map((r) => ({ effectiveDate: dateToIso(r.effectiveDate), amountMinor: Number(r.amountMinor) })),
    dailySpend: spendForUnit(unit, ctx.rows),
    distribution: distributionFor(budget),
    pauses: (budget.pauses as DateRange[] | null) ?? undefined,
    forecastModel: budget.forecastModel,
    thresholds: ctx.thresholds,
    spendCapMinor: googleAdsSpendCap(
      periodStart,
      periodEnd,
      accts,
      ctx.client.accounts
        .flatMap((a) => a.campaigns)
        .filter((c) => (unit.scope === "CAMPAIGN" ? unit.campaignIds.includes(c.id) : live.some((a) => a.id === c.accountId))),
    ),
  });
  const hasEstimatedSpend = ctx.rows.some(
    (r) => r.costIsEstimated && (unit.scope === "CAMPAIGN" ? unit.campaignIds.includes(r.campaignId ?? "") : unit.accountIds.includes(r.accountId)),
  );
  return { result, accts, warnings, hasEstimatedSpend };
}

function makeRow(
  ctx: UnitContext,
  key: string,
  level: RowLevel,
  label: string,
  accts: AccountMeta[],
  currency: string,
  result: PacingResult | null,
  warnings: string[],
  hasEstimatedSpend: boolean,
  unbudgetedSpendMinor = 0,
): PacingRow {
  // Retired accounts (no connection) are history, not a sync problem: freshness
  // follows the accounts still being tracked, unless none are.
  const live = accts.filter((a) => a.monitored);
  const freshness = live.length ? live : accts;
  const stale = freshness.some((a) => a.stale);
  const disconnected = accts.some(isAccountDisconnected);
  const syncs = freshness.map((a) => a.lastSuccessfulSyncAt).filter((s): s is string => !!s);
  const notConnected = isNotConnected(level, accts);
  const action = notConnected
    ? accts.length === 0
      ? { severity: "info" as const, headline: "Not connected", detail: "No ad account is linked to this budget yet. Link one to start pacing." }
      : { severity: "info" as const, headline: "Awaiting first sync", detail: "The linked ad account hasn't synced yet. Pacing starts once data arrives." }
    : result
      ? recommendAction({ ...result, currency, stale, disconnected })
      : { severity: "info" as const, headline: "No budget set", detail: "Spend is not covered by any budget. Add a budget to pace this account." };
  let series: PacingResult["series"] | undefined;
  let lean: Omit<PacingResult, "series"> | null = null;
  if (result) ({ series, ...lean } = result);
  void series;
  return {
    key,
    clientId: ctx.client.id,
    clientName: ctx.client.name,
    managerName: ctx.client.primaryManager?.name ?? null,
    level,
    label,
    platforms: [...new Set(accts.map((a) => a.platform))],
    accounts: accts,
    currency,
    result: lean,
    unbudgetedSpendMinor,
    lastSuccessfulSyncAt: syncs.length ? syncs.sort()[0] : null, // oldest = what the row is limited by
    stale: stale && !notConnected,
    disconnected,
    notConnected,
    isDemo: accts.some((a) => a.isDemo),
    hasEstimatedSpend,
    warnings: notConnected ? [] : [...new Set(warnings)],
    action,
    attention: !notConnected && (disconnected || (result ? needsAttention(result.status) || needsAttention(result.forecastStatus) : false)),
  };
}


function buildClientPacing(
  client: ClientWithAccounts,
  budgets: BudgetWithRevisions[],
  perf: { accountId: string; campaignId: string | null; date: Date; costMinor: bigint; costIsEstimated: boolean }[],
  now: Date,
  periodDate?: IsoDate,
): ClientPacing {
  const today = todayInTimeZone(client.timezone, now);
  const periodRef = periodDate ?? today;
  const yesterday = addDays(today, -1);
  const thresholds = thresholdsFor(client);
  const accounts = client.accounts.map((a) => accountMeta(a, now));
  const campaigns = client.accounts.flatMap((a) => a.campaigns);
  const campaignAccount = new Map(campaigns.map((c) => [c.id, c.accountId]));
  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));
  const rows = perf.map((p) => ({
    accountId: p.accountId,
    campaignId: p.campaignId,
    date: dateToIso(p.date),
    costMinor: Number(p.costMinor),
    costIsEstimated: p.costIsEstimated,
  }));
  const ctx: UnitContext = { client, accounts, rows, yesterday, thresholds };

  // All budgets for one client and date must share a period; extra periods are ignored with a warning.
  const current = budgets[0];
  const period = current
    ? { start: dateToIso(current.periodStart), end: dateToIso(current.periodEnd) }
    : monthBounds(periodRef);
  const inPeriod = budgets.filter((b) => dateToIso(b.periodStart) === period.start && dateToIso(b.periodEnd) === period.end);
  const periodWarnings = inPeriod.length < budgets.length ? ["Some budgets use a different billing period and are not shown"] : [];

  const resolution = resolveBudgetHierarchy(
    accounts.map((a) => a.id),
    campaigns.map((c) => ({ id: c.id, accountId: c.accountId })),
    inPeriod.map((b) => ({ id: b.id, scope: b.scope, accountId: b.accountId, campaignId: b.campaignId })),
  );
  const budgetById = new Map(inPeriod.map((b) => [b.id, b]));

  const paced = (units: PacingUnit[]) => units.map((u) => ({ unit: u, ...paceUnit(u, budgetById.get(u.budgetId)!, ctx, campaignAccount) }));
  const rollup = paced(resolution.rollupUnits);
  const sub = paced(resolution.subAllocationUnits);
  const outRows: PacingRow[] = [];
  const allResults: PacingResult[] = [];
  const connectedResults: PacingResult[] = [];
  const seriesByKey: Record<string, PacingResult["series"]> = {};

  // CLIENT and ACCOUNT units are a row each; campaign-only units are grouped per account.
  for (const p of rollup.filter((p) => p.unit.scope !== "CAMPAIGN")) {
    const b = budgetById.get(p.unit.budgetId)!;
    const label = p.unit.scope === "CLIENT" ? "Combined client budget" : p.accts[0].name;
    const row = makeRow(ctx, b.id, p.unit.scope === "CLIENT" ? "CLIENT" : "ACCOUNT", label, p.accts, b.currency, p.result, [...periodWarnings, ...p.warnings], p.hasEstimatedSpend);
    outRows.push(row);
    allResults.push(p.result);
    if (!row.notConnected) connectedResults.push(p.result);
    seriesByKey[b.id] = p.result.series;
  }
  const campaignGroups = new Map<string, typeof rollup>();
  for (const p of rollup.filter((p) => p.unit.scope === "CAMPAIGN")) {
    const acc = campaignAccount.get(p.unit.campaignIds[0])!;
    campaignGroups.set(acc, [...(campaignGroups.get(acc) ?? []), p]);
  }
  const campaignAsOf = new Map<string, IsoDate>();
  for (const [accountId, group] of campaignGroups) {
    const combined = combinePacing(group.map((g) => g.result), thresholds)!;
    if (combined.asOf) campaignAsOf.set(accountId, combined.asOf);
    const acct = accounts.find((a) => a.id === accountId)!;
    const n = group.length;
    const row = makeRow(ctx, `campaigns:${accountId}`, "CAMPAIGNS", `${acct.name} (${n} campaign budget${n === 1 ? "" : "s"})`, [acct], budgetById.get(group[0].unit.budgetId)!.currency, combined, [...periodWarnings, ...group.flatMap((g) => g.warnings)], group.some((g) => g.hasEstimatedSpend));
    outRows.push(row);
    allResults.push(combined);
    if (!row.notConnected) connectedResults.push(combined);
    seriesByKey[`campaigns:${accountId}`] = combined.series;
  }
  for (const accountId of resolution.unbudgetedAccountIds) {
    const acct = accounts.find((a) => a.id === accountId)!;
    const spend = rows.filter((r) => r.accountId === accountId && r.date >= period.start && r.date <= minDate(period.end, yesterday)).reduce((s, r) => s + r.costMinor, 0);
    outRows.push(makeRow(ctx, `unbudgeted:${accountId}`, "UNBUDGETED", acct.name, [acct], acct.currency, null, [], false, spend));
  }
  // Accounts budgeted campaign by campaign: spend on their other campaigns (and account-level rows such as
  // Local Services) is outside every budget line. Report it so budget spend + unbudgeted spend = ad spend.
  // Counted through the same day as the account's campaign lines (their data-complete date), so the two add up.
  for (const accountId of campaignGroups.keys()) {
    const through = campaignAsOf.get(accountId) ?? minDate(period.end, yesterday);
    const spend = spendOutsideCampaignBudgets([accountId], resolution.rollupUnits, rows, period.start, through).get(accountId) ?? 0;
    if (spend <= 0) continue;
    const acct = accounts.find((a) => a.id === accountId)!;
    outRows.push(makeRow(ctx, `unbudgeted-campaigns:${accountId}`, "UNBUDGETED", `${acct.name} (campaigns without a budget)`, [acct], acct.currency, null, [], false, spend));
  }

  const subRows = sub.map((p) => {
    const b = budgetById.get(p.unit.budgetId)!;
    const label = p.unit.scope === "CAMPAIGN" ? campaignName.get(p.unit.campaignIds[0]) ?? "Campaign" : p.accts[0].name;
    seriesByKey[b.id] = p.result.series;
    return makeRow(ctx, b.id, p.unit.scope === "CAMPAIGN" ? "CAMPAIGNS" : "ACCOUNT", label, p.accts, b.currency, p.result, p.warnings, p.hasEstimatedSpend);
  });
  // Campaign budgets that roll up are also listed individually for drill-down.
  for (const p of rollup.filter((p) => p.unit.scope === "CAMPAIGN")) {
    const b = budgetById.get(p.unit.budgetId)!;
    subRows.push(makeRow(ctx, b.id, "CAMPAIGNS", campaignName.get(p.unit.campaignIds[0]) ?? "Campaign", p.accts, b.currency, p.result, p.warnings, p.hasEstimatedSpend));
    seriesByKey[b.id] = p.result.series;
  }

  return {
    client: { id: client.id, name: client.name, timezone: client.timezone, currency: client.currency, managerName: client.primaryManager?.name ?? null },
    period,
    today,
    thresholds,
    rows: outRows,
    subRows,
    total: combinePacing(allResults, thresholds),
    connectedTotal: combinePacing(connectedResults, thresholds),
    seriesByKey,
    accounts,
  };
}

/** Budgets whose period contains the client's local today (or periodDate). */
function budgetWhere(clients: { id: string; timezone: string }[], now: Date, periodDate?: IsoDate): Prisma.BudgetWhereInput {
  return {
    OR: clients.map((c) => {
      const ref = isoToDate(periodDate ?? todayInTimeZone(c.timezone, now));
      return { clientId: c.id, periodStart: { lte: ref }, periodEnd: { gte: ref } };
    }),
  };
}

/**
 * Pacing for every client matching `where`. By default the budget period
 * containing each client's local today; pass periodDate to pace a past period
 * (e.g. budget history), which is then reported as ENDED.
 */
export async function loadPacing(where: Prisma.ClientWhereInput, now: Date = new Date(), periodDate?: IsoDate): Promise<ClientPacing[]> {
  const clients = await prisma.client.findMany({ where, include: clientInclude, orderBy: { name: "asc" } });
  if (clients.length === 0) return [];
  const ids = clients.map((c) => c.id);
  // Lazily carry repeating budgets into a new month (normally the hourly job
  // already has). Cheap when there is nothing to do; never blocks pacing.
  if (!periodDate) {
    try {
      await rollForwardBudgets(now, { clientIds: ids });
    } catch (e) {
      console.error("[pacing] budget roll-forward failed", e);
    }
  }
  const budgets = await prisma.budget.findMany({
    where: budgetWhere(clients, now, periodDate),
    // Same-day revisions: the newest one wins (inline edits on the Budget Pacing page).
    include: { revisions: { orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }] } },
    orderBy: [{ periodStart: "asc" }, { createdAt: "asc" }],
  });
  // Load spend for the widest window any client needs.
  const starts = budgets.map((b) => b.periodStart.getTime());
  const ends = budgets.map((b) => b.periodEnd.getTime());
  const ref = periodDate ?? todayInTimeZone("UTC", now);
  const fallback = monthBounds(ref);
  const minStart = new Date(Math.min(isoToDate(addDays(fallback.start, -1)).getTime(), ...starts));
  const maxEnd = new Date(Math.max(isoToDate(addDays(fallback.end, 1)).getTime(), ...ends));
  const perf = await prisma.dailyPerformance.findMany({
    where: { account: { clientId: { in: ids } }, date: { gte: minStart, lte: maxEnd }, ...INCLUDED_ROWS },
    select: { accountId: true, campaignId: true, date: true, costMinor: true, costIsEstimated: true },
  });
  return clients.map((c) => {
    const accountIds = new Set(c.accounts.map((a) => a.id));
    return buildClientPacing(
      c,
      budgets.filter((b) => b.clientId === c.id),
      perf.filter((p) => accountIds.has(p.accountId)),
      now,
      periodDate,
    );
  });
}

export interface AgencySummary {
  currency: string;
  totalBudgetMinor: number;
  actualToDateMinor: number;
  projectedMinor: number;
  expectedToDateMinor: number;
  rowsTotal: number;
  rowsNeedingAttention: number;
  staleRows: number;
  /** Budget lines with no ad account linked (or never synced); excluded from every total above. */
  notConnectedRows: number;
  unbudgetedSpendMinor: number;
  /** Combined agency pacing for the dominant calendar period, with series. */
  combined: PacingResult | null;
  /** Most common data-through date across lines (stale lines are counted separately). */
  typicalAsOf: IsoDate | null;
  combinedRowCount: number;
}

export function summarize(clients: ClientPacing[]): AgencySummary {
  const all = clients.flatMap((c) => c.rows);
  // Lines with no data to pace would only read as 0% "underspending"; they are counted separately.
  const rows = all.filter((r) => !r.notConnected);
  const budgeted = rows.filter((r) => r.result);
  const sum = (f: (r: PacingRow) => number) => budgeted.reduce((s, r) => s + f(r), 0);

  // Chart only the units sharing the most common period, so different billing periods are not mixed.
  const totals = clients.map((c) => c.connectedTotal).filter((t): t is PacingResult => !!t);
  const periodKey = (t: PacingResult) => `${t.periodStart}..${t.periodEnd}`;
  const counts = new Map<string, number>();
  for (const t of totals) counts.set(periodKey(t), (counts.get(periodKey(t)) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const sameP = totals.filter((t) => periodKey(t) === dominant);

  return {
    currency: clients[0]?.client.currency ?? "USD",
    totalBudgetMinor: sum((r) => r.result!.budgetMinor),
    actualToDateMinor: sum((r) => r.result!.actualToDateMinor),
    projectedMinor: sum((r) => r.result!.projectedMinor),
    expectedToDateMinor: sum((r) => r.result!.expectedToDateMinor),
    rowsTotal: rows.length,
    rowsNeedingAttention: rows.filter((r) => r.attention).length,
    staleRows: rows.filter((r) => r.stale).length,
    notConnectedRows: all.length - rows.length,
    unbudgetedSpendMinor: rows.reduce((s, r) => s + r.unbudgetedSpendMinor, 0),
    combined: combinePacing(sameP),
    combinedRowCount: sameP.length,
    typicalAsOf: mode(budgeted.map((r) => r.result!.asOf).filter((d): d is IsoDate => !!d)),
  };
}

function mode<T>(xs: T[]): T | null {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
