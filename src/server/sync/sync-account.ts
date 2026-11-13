import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { addDays, isoToDate, minDate, dateToIso, todayInTimeZone, type IsoDate } from "@/lib/pacing/dates";
import { getAdapter } from "../integrations/registry";
import { IntegrationError, withRetry, type RetryOptions } from "../integrations/errors";
import { markConnectionNeedsReauth, withAccessToken } from "../integrations/tokens";
import type { PlatformAdapter, RemoteCampaign } from "../integrations/types";

/** A RUNNING sync younger than this blocks another sync of the same account. */
const LOCK_MS = 30 * 60 * 1000;
/** Days older than this with stored spend are never cleared by an empty response. */
const KEEP_AFTER_DAYS = 2;

function keptNote(days: IsoDate[]): string {
  const sorted = [...days].sort();
  const span = sorted.length === 1 ? sorted[0] : `${sorted[0]} to ${sorted[sorted.length - 1]}`;
  return `The platform returned no data for ${sorted.length} past day${sorted.length === 1 ? "" : "s"} with recorded spend (${span}); kept the existing figures.`;
}
/** Max days per API request when importing history. */
const CHUNK_DAYS = 92;
/** Scheduled syncs skip accounts attempted more recently than this. */
export const SYNC_INTERVAL_MS = 55 * 60 * 1000;

export type SyncKind = "scheduled" | "manual" | "backfill";

export interface SyncResult {
  accountId: string;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED" | "SKIPPED";
  rowsUpserted: number;
  range?: { from: IsoDate; to: IsoDate };
  error?: string;
}

export interface SyncDeps {
  adapter?: PlatformAdapter;
  /** Supplies an access token to `fn` (defaults to stored, auto-refreshed OAuth tokens). */
  withToken?: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
  retry?: RetryOptions;
  now?: Date;
}

export function chunkRange(from: IsoDate, to: IsoDate, maxDays = CHUNK_DAYS): { from: IsoDate; to: IsoDate }[] {
  const out: { from: IsoDate; to: IsoDate }[] = [];
  for (let start = from; start <= to; start = addDays(start, maxDays)) {
    out.push({ from: start, to: minDate(addDays(start, maxDays - 1), to) });
  }
  return out;
}

/** Once a day the re-fetch reaches this far back, to pick up conversions credited weeks after the click. */
export const DEEP_RESTATEMENT_DAYS = 35;

/**
 * Which dates to (re)fetch. First sync or backfill: the adapter's full history
 * window. Otherwise: from `restatementWindowDays` before the last complete
 * date, through today (today's partial numbers are stored but never paced on).
 * With `deep` (once a day) the window is at least DEEP_RESTATEMENT_DAYS, because
 * platforms keep adding conversions to older clicks after the normal window.
 */
export function syncRange(adapter: PlatformAdapter, today: IsoDate, kind: SyncKind, dataCompleteThrough: IsoDate | null, deep = false): { from: IsoDate; to: IsoDate } {
  if (kind === "backfill" || !dataCompleteThrough) return { from: addDays(today, -adapter.initialBackfillDays), to: today };
  const days = deep ? Math.max(adapter.restatementWindowDays, DEEP_RESTATEMENT_DAYS) : adapter.restatementWindowDays;
  return { from: addDays(minDate(dataCompleteThrough, today), -days), to: today };
}

/** Always overwritten, so a campaign moved to a lifetime budget never keeps an old daily amount. */
function budgetFields(c: RemoteCampaign) {
  const daily = c.budgetKind === "DAILY" && c.dailyBudgetMinor !== undefined;
  return {
    platformBudgetKind: c.budgetKind ?? null,
    platformBudgetId: c.budgetId ?? null,
    platformDailyBudgetMinor: daily ? BigInt(c.dailyBudgetMinor!) : null,
  };
}

async function upsertCampaigns(accountId: string, campaigns: RemoteCampaign[], includeNew = true): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const c of campaigns) {
    const row = await prisma.campaign.upsert({
      where: { accountId_externalId: { accountId, externalId: c.externalId } },
      create: { accountId, externalId: c.externalId, name: c.name, status: c.status, excludedAt: includeNew ? null : new Date(), ...budgetFields(c) },
      update: { name: c.name, status: c.status, ...budgetFields(c) },
      select: { id: true },
    });
    ids.set(c.externalId, row.id);
  }
  return ids;
}

export async function syncAccount(accountId: string, kind: SyncKind, deps: SyncDeps = {}): Promise<SyncResult> {
  const now = deps.now ?? new Date();
  const account = await prisma.adAccount.findUnique({ where: { id: accountId }, include: { client: { select: { timezone: true } }, connection: true } });
  if (!account) return { accountId, status: "FAILED", rowsUpserted: 0, error: "Account not found" };
  if (account.isDemo) return { accountId, status: "SKIPPED", rowsUpserted: 0, error: "Demo accounts are never synced" };
  if (!account.connectionId || !account.connection) return { accountId, status: "FAILED", rowsUpserted: 0, error: "Account has no platform connection" };

  const running = await prisma.syncRun.findFirst({ where: { accountId, status: "RUNNING", startedAt: { gt: new Date(now.getTime() - LOCK_MS) } } });
  if (running) return { accountId, status: "SKIPPED", rowsUpserted: 0, error: "A sync is already running for this account" };

  const adapter = deps.adapter ?? getAdapter(account.platform);
  if (!adapter) return { accountId, status: "FAILED", rowsUpserted: 0, error: `No integration for ${account.platform}` };
  const connectionId = account.connectionId;
  const withToken = deps.withToken ?? (<T,>(fn: (t: string) => Promise<T>) => withAccessToken(connectionId, adapter, fn));
  const call = <T,>(fn: (t: string) => Promise<T>) => withRetry(() => withToken(fn), deps.retry);

  const tz = account.timezone ?? account.client.timezone;
  const today = todayInTimeZone(tz, now);
  // Deep re-fetch when this account hasn't had one in the last 24 hours (spread across the day, never skipped).
  const deepDone = await prisma.syncRun.findFirst({
    where: { accountId, status: { in: ["SUCCEEDED", "PARTIAL"] }, startedAt: { gte: new Date(now.getTime() - 86_400_000) }, rangeStart: { lte: isoToDate(addDays(today, -Math.min(DEEP_RESTATEMENT_DAYS - 5, adapter.initialBackfillDays))) } },
    select: { id: true },
  });
  const range = syncRange(adapter, today, kind, account.dataCompleteThrough ? dateToIso(account.dataCompleteThrough) : null, !deepDone);
  const run = await prisma.syncRun.create({ data: { accountId, kind, status: "RUNNING", rangeStart: isoToDate(range.from), rangeEnd: isoToDate(range.to), startedAt: now } });
  await prisma.adAccount.update({ where: { id: accountId }, data: { lastSyncAttemptAt: now } });

  const ref = { externalId: account.externalId, loginCustomerId: account.loginCustomerId, timezone: tz };
  let rowsUpserted = 0;
  let spendVerified: boolean | undefined;
  const keptDays: IsoDate[] = [];
  try {
    const campaignIds = await upsertCampaigns(accountId, await call((t) => adapter.listCampaigns(t, ref)), account.includeNewCampaigns);

    for (const chunk of chunkRange(range.from, range.to, adapter.maxRangeDays)) {
      const result = await call((t) => adapter.fetchDailyPerformance(t, ref, chunk.from, chunk.to));
      const { rows, campaigns } = result;
      // Any chunk reporting unverified spend makes the account unverified.
      if (result.spendVerified !== undefined) spendVerified = spendVerified === false ? false : result.spendVerified;
      // Campaigns that only appear in metrics (e.g. removed ones that spent earlier in the range)
      const unseen = campaigns.filter((c) => !campaignIds.has(c.externalId));
      for (const [k, v] of await upsertCampaigns(accountId, unseen, account.includeNewCampaigns)) campaignIds.set(k, v);

      // Only accept rows inside the window being replaced; anything else would
      // collide with rows kept outside the window.
      const inWindow = rows.filter((r) => r.date >= chunk.from && r.date <= chunk.to);
      const data: Prisma.DailyPerformanceCreateManyInput[] = inWindow.map((r) => ({
        accountId,
        campaignId: r.campaignExternalId ? campaignIds.get(r.campaignExternalId)! : null,
        date: isoToDate(r.date),
        currency: account.currency,
        costMinor: BigInt(r.costMinor),
        costIsEstimated: r.costIsEstimated,
        impressions: BigInt(r.impressions),
        clicks: BigInt(r.clicks),
        reach: r.reach === undefined ? null : BigInt(r.reach),
        conversions: r.conversions,
        conversionValueMinor: BigInt(r.conversionValueMinor),
        leads: r.leads ?? null,
        isDemo: false,
        syncedAt: now,
      }));
      // Spend on a finished day doesn't disappear. If the platform sends nothing
      // for a past day we hold spend for, it's a gap in the response, not a
      // restatement: keep what we have for that day rather than wiping it.
      const returned = new Set(inWindow.map((r) => r.date));
      const stored = await prisma.dailyPerformance.groupBy({
        by: ["date"],
        where: { accountId, date: { gte: isoToDate(chunk.from), lte: isoToDate(chunk.to) } },
        _sum: { costMinor: true },
      });
      const settled = addDays(today, -KEEP_AFTER_DAYS);
      const keep = stored
        .map((d) => ({ date: dateToIso(d.date), cost: Number(d._sum.costMinor ?? 0) }))
        .filter((d) => d.cost > 0 && d.date <= settled && !returned.has(d.date))
        .map((d) => d.date);
      keptDays.push(...keep);
      // Replace the rest of the window atomically: restated days are updated, and
      // recent days that dropped to zero (absent from the response) are cleared.
      await prisma.$transaction([
        prisma.dailyPerformance.deleteMany({
          where: { accountId, date: { gte: isoToDate(chunk.from), lte: isoToDate(chunk.to), ...(keep.length ? { notIn: keep.map(isoToDate) } : {}) } },
        }),
        prisma.dailyPerformance.createMany({ data }),
      ]);
      rowsUpserted += data.length;
    }

    if (keptDays.length) console.warn(`Sync ${accountId}: ${keptNote(keptDays)}`);
    const completeThrough = adapter.dataCompleteThrough(tz, now);
    await prisma.$transaction([
      prisma.adAccount.update({
        where: { id: accountId },
        data: { lastSuccessfulSyncAt: now, dataCompleteThrough: isoToDate(completeThrough), status: "ACTIVE", spendIsVerified: spendVerified ?? adapter.spendIsVerified },
      }),
      prisma.syncRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", rowsUpserted, finishedAt: new Date(), error: keptDays.length ? keptNote(keptDays) : null } }),
      prisma.platformConnection.update({ where: { id: connectionId }, data: { status: "ACTIVE", lastError: null } }),
    ]);
    return { accountId, status: "SUCCEEDED", rowsUpserted, range };
  } catch (e) {
    const err = e instanceof IntegrationError ? e : new IntegrationError("INVALID_REQUEST", (e as Error).message);
    if (err.kind === "AUTH_REVOKED") await markConnectionNeedsReauth(connectionId, err.message);
    if (err.kind === "PERMISSION_DENIED") await prisma.adAccount.update({ where: { id: accountId }, data: { status: "DISCONNECTED" } });
    // App-level block: keep accounts ACTIVE so syncs resume on their own once the platform lifts it;
    // the connection shows the error (Settings › Connections) and rows show as stale meanwhile.
    if (err.kind === "APP_BLOCKED") await prisma.platformConnection.update({ where: { id: connectionId }, data: { lastError: err.message } });
    if (err.kind === "NOT_APPROVED") {
      await prisma.platformConnection.update({ where: { id: connectionId }, data: { status: "PENDING_APPROVAL", lastError: err.message } });
    }
    const status = rowsUpserted > 0 ? "PARTIAL" : "FAILED";
    const message = `${err.kind}: ${err.message}`.slice(0, 2000);
    await prisma.syncRun.update({ where: { id: run.id }, data: { status, rowsUpserted, error: message, finishedAt: new Date() } });
    return { accountId, status, rowsUpserted, range, error: message };
  }
}

/** Accounts due for a scheduled sync (live, connected, not attempted recently). */
export async function dueAccountIds(now: Date = new Date(), agencyId?: string): Promise<string[]> {
  const accounts = await prisma.adAccount.findMany({
    where: {
      isDemo: false,
      status: "ACTIVE",
      client: { archivedAt: null },
      connection: { status: "ACTIVE", ...(agencyId ? { agencyId } : {}) },
      OR: [{ lastSyncAttemptAt: null }, { lastSyncAttemptAt: { lt: new Date(now.getTime() - SYNC_INTERVAL_MS) } }],
    },
    select: { id: true },
    orderBy: { lastSyncAttemptAt: { sort: "asc", nulls: "first" } },
  });
  return accounts.map((a) => a.id);
}

/** Sync due accounts with limited concurrency to stay within API rate limits. */
export async function syncDueAccounts(opts: { now?: Date; concurrency?: number; limit?: number } = {}): Promise<SyncResult[]> {
  const ids = (await dueAccountIds(opts.now)).slice(0, opts.limit ?? 200);
  const results: SyncResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      results.push(await syncAccount(id, "scheduled", { now: opts.now }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, ids.length) }, worker));
  return results;
}
