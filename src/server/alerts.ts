import "server-only";
import type { AlertType, Prisma } from "@prisma/client";
import { prisma } from "./db";
import { INCLUDED_ROWS } from "./campaign-selection";
import { loadPacing, type PacingRow } from "./pacing-service";
import { appUrl, sendEmail } from "./email";
import { evaluateAlerts, resolveAlertSettings, type AccountInput, type AlertCandidate, type CampaignInput, type PacingRowInput } from "@/lib/alerts";
import { alertEmail, dailySummaryEmail, type AlertLine } from "@/lib/email-templates";
import { slackAlertText } from "@/lib/slack";
import { agencySlackWebhook, postToSlack } from "./slack";
import { dateToIso, dayOfWeek, todayInTimeZone } from "@/lib/pacing/dates";
import { resultCount } from "@/lib/portfolio";
import { summaryLines } from "@/lib/daily-summary";
import { groupAlertsByCause, visibleAlerts } from "@/lib/alert-groups";
import { applyEfficiencyAdvice, highCostPerResultClients, portfolioResults } from "./portfolio";
import { visibleClientsWhere } from "./client-scope";

const LOOKBACK_DAYS = 35;

function toRowInput(r: PacingRow): PacingRowInput {
  return {
    key: r.key,
    clientId: r.clientId,
    clientName: r.clientName,
    label: r.level === "CLIENT" ? "Combined budget" : r.label,
    currency: r.currency,
    isDemo: r.isDemo,
    disconnected: r.disconnected,
    notConnected: r.notConnected,
    accountIds: r.accounts.map((a) => a.id),
    action: { headline: r.action.headline, detail: r.action.detail },
    result: r.result
      ? { phase: r.result.phase, periodStart: r.result.periodStart, status: r.result.status, forecastStatus: r.result.forecastStatus, budgetMinor: r.result.budgetMinor, projectedVarianceMinor: r.result.projectedVarianceMinor, elapsedDays: r.result.elapsedDays }
      : null,
  };
}

async function staffOf(agencyId: string) {
  const users = await prisma.user.findMany({
    where: { agencyId, deactivatedAt: null, role: { in: ["AGENCY_ADMIN", "ACCOUNT_MANAGER"] } },
    include: { assignments: { select: { clientId: true } }, managedClients: { select: { id: true } } },
  });
  return users.map((u) => ({
    ...u,
    visible: new Set([...u.assignments.map((a) => a.clientId), ...u.managedClients.map((c) => c.id)]),
  }));
}

/** Same rule as canViewClient: admins see every client, managers their primary/assigned ones. */
function userCanSee(u: Awaited<ReturnType<typeof staffOf>>[number], clientId: string) {
  return u.role === "AGENCY_ADMIN" || u.visible.has(clientId);
}

async function brand(agencyId: string) {
  const a = await prisma.agency.findUniqueOrThrow({ where: { id: agencyId }, select: { name: true, brandColor: true, reportFooter: true, defaultTimezone: true } });
  return { brand: { name: a.name, color: a.brandColor, footer: a.reportFooter }, timezone: a.defaultTimezone };
}

export interface AlertRunResult {
  agencyId: string;
  created: number;
  refreshed: number;
  resolved: number;
  emailsQueued: number;
}

/** Evaluates every alert rule for an agency and reconciles stored alerts. */
export async function evaluateAgencyAlerts(agencyId: string, now: Date = new Date()): Promise<AlertRunResult> {
  const agency = await prisma.agency.findUniqueOrThrow({ where: { id: agencyId }, select: { alertSettings: true, defaultTimezone: true } });
  const settings = resolveAlertSettings(agency.alertSettings);
  const pacing = await loadPacing({ agencyId, archivedAt: null }, now);
  // Underspend advice in alert text checks efficiency first (H6).
  applyEfficiencyAdvice(pacing, highCostPerResultClients(await portfolioResults({ agencyId, archivedAt: null }, todayInTimeZone(agency.defaultTimezone, now))));
  const rows = pacing.flatMap((c) => c.rows).map(toRowInput);
  const mutedClients = await prisma.client.findMany({ where: { agencyId, archivedAt: null, NOT: { mutedAlertTypes: { isEmpty: true } } }, select: { id: true, mutedAlertTypes: true } });
  const muted = Object.fromEntries(mutedClients.map((c) => [c.id, c.mutedAlertTypes as AlertCandidate["kind"][]]));

  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const [accounts, perf] = await Promise.all([
    prisma.adAccount.findMany({
      where: { client: { agencyId, archivedAt: null } },
      include: { client: { select: { name: true } }, campaigns: { where: { excludedAt: null }, select: { id: true, name: true, status: true } }, syncRuns: { orderBy: { startedAt: "desc" }, take: 1 } },
    }),
    prisma.dailyPerformance.findMany({
      where: { account: { client: { agencyId, archivedAt: null } }, date: { gte: since }, ...INCLUDED_ROWS },
      select: { accountId: true, campaignId: true, date: true, costMinor: true, conversions: true, leads: true },
    }),
  ]);
  const platformOf = new Map(accounts.map((a) => [a.id, a.platform]));
  const accountDaily = new Map<string, Record<string, number>>();
  const accountResults = new Map<string, Record<string, number>>();
  const campaignDaily = new Map<string, Record<string, number>>();
  for (const p of perf) {
    const d = dateToIso(p.date);
    const a = accountDaily.get(p.accountId) ?? {};
    a[d] = (a[d] ?? 0) + Number(p.costMinor);
    accountDaily.set(p.accountId, a);
    const res = accountResults.get(p.accountId) ?? {};
    res[d] = (res[d] ?? 0) + resultCount(platformOf.get(p.accountId)!, { conversions: Number(p.conversions), leads: Number(p.leads ?? 0) });
    accountResults.set(p.accountId, res);
    if (p.campaignId) {
      const c = campaignDaily.get(p.campaignId) ?? {};
      c[d] = (c[d] ?? 0) + Number(p.costMinor);
      campaignDaily.set(p.campaignId, c);
    }
  }
  const accountInputs: AccountInput[] = accounts.map((a) => {
    const run = a.syncRuns[0];
    return {
      id: a.id,
      name: a.name,
      clientId: a.clientId,
      clientName: a.client.name,
      currency: a.currency,
      isDemo: a.isDemo,
      monitored: a.isDemo || !!a.connectionId,
      status: a.status,
      lastSuccessfulSyncAt: a.lastSuccessfulSyncAt,
      lastSyncFailed: run && (run.status === "FAILED" || run.status === "PARTIAL") ? { at: run.startedAt, error: run.error ?? "Sync failed" } : null,
      dataCompleteThrough: a.dataCompleteThrough ? dateToIso(a.dataCompleteThrough) : null,
      daily: accountDaily.get(a.id) ?? {},
      dailyResults: accountResults.get(a.id) ?? {},
    };
  });
  const campaignInputs: CampaignInput[] = accounts.flatMap((a) => a.campaigns.map((c) => ({ id: c.id, name: c.name, accountId: a.id, status: c.status, daily: campaignDaily.get(c.id) ?? {} })));

  const candidates = evaluateAlerts({ rows, accounts: accountInputs, campaigns: campaignInputs, settings, now, muted });
  return reconcile(agencyId, candidates, now);
}

const PERFORMANCE_KINDS = new Set<string>(["CPA_SPIKE", "RESULTS_DROP", "TRACKING_ZERO"]);

async function reconcile(agencyId: string, candidates: AlertCandidate[], now: Date): Promise<AlertRunResult> {
  const existing = await prisma.alert.findMany({ where: { agencyId, status: { in: ["OPEN", "ACKNOWLEDGED"] } } });
  const byKey = new Map(existing.map((a) => [a.dedupeKey, a]));
  const seen = new Set<string>();
  const created: { id: string; c: AlertCandidate }[] = [];
  let refreshed = 0;
  for (const c of candidates) {
    if (seen.has(c.dedupeKey)) continue;
    seen.add(c.dedupeKey);
    const details: Prisma.InputJsonValue = { detail: c.detail, clientName: c.clientName, isDemo: c.isDemo, ...(c.accountIds ? { accountIds: c.accountIds } : {}) };
    const prev = byKey.get(c.dedupeKey) ?? adoptLegacyPacingAlert(c.dedupeKey, byKey, seen);
    if (prev) {
      await prisma.alert.update({ where: { id: prev.id }, data: { lastSeenAt: now, message: c.title, details, severity: c.severity, type: c.kind as AlertType, dedupeKey: c.dedupeKey } });
      seen.add(prev.dedupeKey);
      refreshed++;
    } else {
      const a = await prisma.alert.create({
        data: { agencyId, clientId: c.clientId, accountId: c.accountId ?? null, type: c.kind as AlertType, severity: c.severity, dedupeKey: c.dedupeKey, message: c.title, details, firstSeenAt: now, lastSeenAt: now },
      });
      created.push({ id: a.id, c });
    }
  }
  const stale = existing.filter((a) => !seen.has(a.dedupeKey)).map((a) => a.id);
  if (stale.length) await prisma.alert.updateMany({ where: { id: { in: stale } }, data: { status: "RESOLVED", resolvedAt: now } });

  // Performance alerts can clear and come back as numbers wobble: don't re-email
  // one whose key was resolved in the last 7 days (it still shows in the app).
  const recentlyResolved = created.length
    ? new Set((await prisma.alert.findMany({ where: { agencyId, status: "RESOLVED", resolvedAt: { gte: new Date(now.getTime() - 7 * 864e5) }, dedupeKey: { in: created.map((x) => x.c.dedupeKey) } }, select: { dedupeKey: true } })).map((a) => a.dedupeKey))
    : new Set<string>();
  const toNotify = created.filter((x) => !(PERFORMANCE_KINDS.has(x.c.kind) && recentlyResolved.has(x.c.dedupeKey)));
  const emailsQueued = toNotify.length ? await notify(agencyId, toNotify) : 0;
  return { agencyId, created: created.length, refreshed, resolved: stale.length, emailsQueued };
}

/**
 * Pacing alerts used to be keyed by status ("OVERSPENDING:<line>:<period>");
 * they are now keyed by direction ("PACING_OVER:<line>:<period>"). An open
 * alert under an old key is carried over instead of being closed and raised
 * again, so the change doesn't re-notify anyone.
 */
function adoptLegacyPacingAlert<T extends { dedupeKey: string }>(key: string, byKey: Map<string, T>, seen: Set<string>): T | undefined {
  const m = /^PACING_(OVER|UNDER):(.+)$/.exec(key);
  if (!m) return undefined;
  const legacy = m[1] === "OVER" ? ["OVERSPENDING", "PROJECTED_OVERRUN"] : ["UNDERSPENDING"];
  for (const kind of legacy) {
    const old = byKey.get(`${kind}:${m[2]}`);
    if (old && !seen.has(old.dedupeKey)) return old;
  }
  return undefined;
}

/** In-app notification for every staff member who can see the client; one email per person per run. */
async function notify(agencyId: string, created: { id: string; c: AlertCandidate }[]): Promise<number> {
  const staff = await staffOf(agencyId);
  const { brand: b } = await brand(agencyId);
  let emails = 0;
  for (const u of staff) {
    const mine = created.filter((x) => userCanSee(u, x.c.clientId));
    if (!mine.length) continue;
    await prisma.notification.createMany({
      data: mine.map((x) => ({ userId: u.id, alertId: x.id, channel: "in_app", title: `${x.c.clientName}: ${x.c.title}`, body: x.c.detail })),
    });
    if (u.emailAlerts) {
      const lines: AlertLine[] = mine.map((x) => ({ severity: x.c.severity, client: x.c.clientName, title: x.c.title, detail: x.c.detail }));
      await sendEmail({ agencyId, to: u.email, kind: "alert", ...alertEmail(b, lines, appUrl("/insights")) });
      emails++;
    }
  }
  // One Slack message per run for the whole agency, when a webhook is set.
  const slack = await agencySlackWebhook(agencyId);
  if (slack) {
    const lines: AlertLine[] = created.map((x) => ({ severity: x.c.severity, client: x.c.clientName, title: x.c.title, detail: x.c.detail }));
    const r = await postToSlack(slack, slackAlertText(b.name, lines, appUrl("/insights")));
    if (!r.ok) console.error("[alerts] Slack delivery failed:", r.error);
  }
  return emails;
}

/**
 * Weekday-morning summary (from 7:00 in the agency's time zone), at most once
 * per person per day, listing the budget lines that need action.
 */
export async function sendDailySummaries(agencyId: string, now: Date = new Date()): Promise<number> {
  const { brand: b, timezone } = await brand(agencyId);
  const today = todayInTimeZone(timezone, now);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(now));
  const dow = dayOfWeek(today);
  if (dow === 0 || dow === 6 || hour < 7) return 0;

  const staff = (await staffOf(agencyId)).filter((u) => u.dailySummary && (!u.lastDailySummaryAt || todayInTimeZone(timezone, u.lastDailySummaryAt) < today));
  if (!staff.length) return 0;
  const pacing = await loadPacing({ agencyId, archivedAt: null }, now);
  applyEfficiencyAdvice(pacing, highCostPerResultClients(await portfolioResults({ agencyId, archivedAt: null }, today)));
  const muted = new Map((await prisma.client.findMany({ where: { agencyId, archivedAt: null }, select: { id: true, mutedAlertTypes: true } })).map((c) => [c.id, c.mutedAlertTypes as string[]]));
  const rows = pacing.flatMap((c) => c.rows).filter((r) => !r.notConnected);
  const label = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  let sent = 0;
  for (const u of staff) {
    const mine = rows.filter((r) => userCanSee(u, r.clientId));
    if (!mine.length) continue;
    const { needAction, onTarget, staleOnTarget } = summaryLines(mine, muted, now);
    await sendEmail({ agencyId, to: u.email, kind: "daily_summary", ...dailySummaryEmail(b, label, needAction, onTarget, appUrl("/dashboard"), staleOnTarget) });
    await prisma.user.update({ where: { id: u.id }, data: { lastDailySummaryAt: now } });
    sent++;
  }
  return sent;
}

/**
 * Open alert issues (alerts grouped by cause) a staff member can see: open and
 * unacknowledged, not snoozed, not muted, not explained by another alert. This
 * is the number in the Alerts page header (without filters) and the sidebar badge.
 */
export async function openAlertIssueCount(agencyId: string, userId?: string): Promise<{ alerts: number; issues: number }> {
  const user = userId ? await prisma.user.findFirst({ where: { id: userId, agencyId } }) : null;
  const where = user ? visibleClientsWhere(user) : { agencyId, archivedAt: null };
  const clients = await prisma.client.findMany({ where, select: { id: true, mutedAlertTypes: true } });
  const now = new Date();
  const alerts = await prisma.alert.findMany({
    where: { agencyId, clientId: { in: clients.map((c) => c.id) }, status: "OPEN", OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] },
    select: { id: true, type: true, severity: true, clientId: true, accountId: true, details: true, account: { select: { platform: true, connection: { select: { id: true, platform: true, status: true } } } } },
    take: 2000,
  });
  const shown = visibleAlerts(
    alerts.map((a) => ({ ...a, connection: a.account?.connection ?? null, platform: a.account?.platform ?? null })),
    new Map(clients.map((c) => [c.id, c.mutedAlertTypes as string[]])),
  );
  return { alerts: shown.length, issues: groupAlertsByCause(shown).length };
}

/** Alerts + daily summaries for every agency. Called by the cron endpoints and `npm run alerts`. */
export async function runAllAlerts(now: Date = new Date()) {
  const agencies = await prisma.agency.findMany({ select: { id: true } });
  const results = [];
  for (const a of agencies) {
    const r = await evaluateAgencyAlerts(a.id, now);
    const summaries = await sendDailySummaries(a.id, now);
    results.push({ ...r, summaries });
  }
  return results;
}
