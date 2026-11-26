import "server-only";
import type { Prisma, SiteAudit } from "@prisma/client";
import { prisma } from "../db";
import { readSecret, markDataSourceNeedsReauth } from "../data-sources/credentials";
import { agencyDataForSeoConnection } from "../data-sources/dataforseo/account";
import { onPageRates } from "../data-sources/dataforseo/pricing";
import type { FetchLike } from "../data-sources/dataforseo/api";
import { metricBreakdown } from "../metrics/query";
import { draftSiteAuditSummary } from "../ai/assistant";
import { addDays, todayInTimeZone } from "@/lib/pacing/dates";
import { checkCostCap, estimateAuditCost, lighthouseUrlCount } from "@/lib/site-audit/cost";
import { healthScore } from "@/lib/site-audit/score";
import { nextAuditRun } from "@/lib/site-audit/schedule";
import { zonedTime } from "@/lib/report-schedule";
import { AuditError, classifyError, collectCrawl, crawlProgress, hostOfTarget, NO_AUTO_RETRY, runLighthouse, startCrawl, stopCrawl, type AuditErrorCode, type LighthouseRow } from "./engine";
import { ISSUE_BY_KEY, type CrawlFindings } from "@/lib/site-audit/issues";
import { auditSummaryData } from "./summary-data";

// Site Auditor jobs, run by the existing hourly scheduler (src/server/scheduler.ts,
// /api/cron/sync) plus a short poll while crawls are running:
//  - scheduleDueAudits: configs due now → cost-capped SiteAudit rows → crawl started
//  - pollActiveAudits: crawling → finished → results analysed, scored, stored → AI summary
// One crawl per client at a time; bad credentials and low balance are never retried automatically.

export const CRAWL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Completed audits per client that keep sample URLs and page rows; older ones keep score and counts only. */
export const KEEP_DETAIL = 6;
const ACTIVE = ["queued", "crawling", "processing"];

export interface JobDeps { fetch?: FetchLike; now?: Date; /** Lighthouse retry wait (tests use 0). */ retryDelayMs?: number }

async function agencySecret(agencyId: string): Promise<{ secret: string; connectionId: string }> {
  const c = await agencyDataForSeoConnection(agencyId);
  if (!c) throw new AuditError("not_connected");
  if (c.status === "NEEDS_REAUTH") throw new AuditError("bad_credentials");
  const secret = readSecret(c);
  if (!secret) throw new AuditError("not_connected");
  return { secret, connectionId: c.id };
}

/** Start of the agency's current calendar month (agency time zone). */
export function monthStart(timeZone: string, now: Date): Date {
  return zonedTime(`${todayInTimeZone(timeZone, now).slice(0, 8)}01`, 0, timeZone);
}

/** What this month's crawls cost (actual where known, else the estimate), for the cap. Skipped crawls cost nothing. */
export async function monthSpend(agencyId: string, now: Date = new Date()): Promise<number> {
  const agency = await prisma.agency.findUniqueOrThrow({ where: { id: agencyId }, select: { defaultTimezone: true } });
  const rows = await prisma.siteAudit.findMany({
    where: { client: { agencyId }, createdAt: { gte: monthStart(agency.defaultTimezone, now) }, providerTaskId: { not: null } },
    select: { estimatedCost: true, actualCost: true },
  });
  return rows.reduce((s, r) => s + (r.actualCost ?? r.estimatedCost), 0);
}

export function auditEstimate(cfg: { maxPages: number; enableJs: boolean; lighthouse: string }): number {
  return estimateAuditCost({ maxPages: cfg.maxPages, enableJs: cfg.enableJs, loadResources: true, lighthouseUrls: lighthouseUrlCount(cfg.lighthouse) }, onPageRates());
}

async function fail(audit: Pick<SiteAudit, "id">, code: AuditErrorCode, message: string, status: "failed" | "skipped" = "failed") {
  return prisma.siteAudit.update({ where: { id: audit.id }, data: { status, errorCode: code, errorMessage: message.slice(0, 500), finishedAt: new Date() } });
}

/**
 * Creates a SiteAudit for the client and starts its crawl. Returns the row in
 * its new state: crawling, or skipped/failed with a reason (cost cap, not
 * connected, DataForSEO error). Throws AuditError("already_running") when a
 * crawl is in progress, so callers never start a second one.
 */
export async function startAudit(clientId: string, trigger: "schedule" | "manual", deps: JobDeps = {}): Promise<SiteAudit> {
  const now = deps.now ?? new Date();
  const cfg = await prisma.siteAuditConfig.findUnique({ where: { clientId }, include: { client: { select: { agencyId: true, archivedAt: true } } } });
  if (!cfg) throw new Error("Site audit isn't set up for this client.");
  const running = await prisma.siteAudit.findFirst({ where: { clientId, status: { in: ACTIVE } } });
  if (running) throw new AuditError("already_running");
  const estimate = auditEstimate(cfg);
  const agency = await prisma.agency.findUniqueOrThrow({ where: { id: cfg.client.agencyId }, select: { siteAuditMonthlyCapUsd: true } });
  const audit = await prisma.siteAudit.create({
    data: { clientId, trigger, status: "queued", targetUrl: cfg.targetUrl, maxPages: cfg.maxPages, enableJs: cfg.enableJs, lighthouseMode: cfg.lighthouse, estimatedCost: estimate, createdAt: now },
  });
  const cap = checkCostCap(await monthSpend(cfg.client.agencyId, now), estimate, agency.siteAuditMonthlyCapUsd);
  if (!cap.allowed) return fail(audit, "cost_cap", cap.reason!, "skipped");
  let conn: { secret: string; connectionId: string };
  try {
    conn = await agencySecret(cfg.client.agencyId);
  } catch (e) {
    const k = classifyError(e);
    return fail(audit, k.code, k.message, "skipped");
  }
  try {
    const started = await startCrawl(conn.secret, { targetUrl: cfg.targetUrl, maxPages: cfg.maxPages, enableJs: cfg.enableJs, auditId: audit.id }, deps.fetch);
    return prisma.siteAudit.update({ where: { id: audit.id }, data: { status: "crawling", providerTaskId: started.taskId, startedAt: now, actualCost: started.cost } });
  } catch (e) {
    const k = classifyError(e);
    if (k.code === "bad_credentials") await markDataSourceNeedsReauth(conn.connectionId, k.message);
    return fail(audit, k.code, k.message);
  }
}

/** Starts every scheduled crawl that is due. Each config is claimed (nextRunAt moved on) before its crawl starts. */
export async function scheduleDueAudits(deps: JobDeps = {}): Promise<{ started: number; skipped: number }> {
  const now = deps.now ?? new Date();
  const due = await prisma.siteAuditConfig.findMany({
    where: { active: true, schedule: { in: ["weekly", "monthly"] }, nextRunAt: { lte: now }, client: { archivedAt: null } },
    include: { client: { select: { timezone: true } } },
    take: 50,
  });
  let started = 0, skipped = 0;
  for (const cfg of due) {
    const next = nextAuditRun(cfg, cfg.client.timezone, now);
    const claimed = await prisma.siteAuditConfig.updateMany({ where: { id: cfg.id, nextRunAt: cfg.nextRunAt }, data: { nextRunAt: next } });
    if (!claimed.count) continue; // another runner took it
    // Don't retry a login or balance problem on our own. A balance error waits for a person to run the
    // audit by hand (adding funds leaves no trace here); a login error waits until the login is updated.
    const last = await prisma.siteAudit.findFirst({ where: { clientId: cfg.clientId, status: { not: "skipped" } }, orderBy: { createdAt: "desc" } });
    if (last?.status === "failed" && NO_AUTO_RETRY.includes(last.errorCode as AuditErrorCode)) {
      let reconnected = false;
      if (last.errorCode === "bad_credentials") {
        const agencyId = (await prisma.client.findUniqueOrThrow({ where: { id: cfg.clientId }, select: { agencyId: true } })).agencyId;
        const conn = await agencyDataForSeoConnection(agencyId);
        reconnected = !!conn && conn.status === "ACTIVE" && conn.updatedAt > (last.finishedAt ?? last.createdAt);
      }
      if (!reconnected) {
        await prisma.siteAudit.create({
          data: {
            clientId: cfg.clientId, trigger: "schedule", status: "skipped", targetUrl: cfg.targetUrl, maxPages: cfg.maxPages, enableJs: cfg.enableJs, lighthouseMode: cfg.lighthouse,
            errorCode: last.errorCode,
            errorMessage: last.errorCode === "insufficient_balance"
              ? "Not retried automatically after a low-balance error. Run the audit by hand once DataForSEO has funds."
              : "Not retried automatically: DataForSEO rejected the API login. Update it in Settings › Connections.",
            finishedAt: now, createdAt: now,
          },
        });
        skipped++;
        continue;
      }
    }
    try {
      const a = await startAudit(cfg.clientId, "schedule", { ...deps, now });
      if (a.status === "crawling") started++;
      else skipped++;
    } catch (e) {
      if (e instanceof AuditError && e.code === "already_running") skipped++;
      else throw e;
    }
  }
  return { started, skipped };
}

/** Homepage, plus the top 5 landing pages (GA4 visits, else Search Console clicks) for "top_pages". */
async function lighthouseUrls(clientId: string, targetUrl: string, mode: string, timeZone: string, now: Date): Promise<string[]> {
  const home = `${targetUrl}/`;
  if (mode === "off") return [];
  if (mode === "homepage") return [home];
  const to = todayInTimeZone(timeZone, now);
  const from = addDays(to, -30);
  const host = hostOfTarget(targetUrl);
  const toUrl = (v: string) => {
    try {
      const u = new URL(v, targetUrl);
      return u.hostname.replace(/^www\./, "") === host ? `${targetUrl}${u.pathname}` : null;
    } catch {
      return null;
    }
  };
  let pages = (await metricBreakdown(clientId, "page", ["ga4.sessions"], from, to, 15).catch(() => [])).map((r) => toUrl(r.value));
  if (!pages.some(Boolean)) pages = (await metricBreakdown(clientId, "page", ["gsc.clicks"], from, to, 15).catch(() => [])).map((r) => toUrl(r.value));
  const urls = [home, ...pages.filter((u): u is string => !!u && u !== home && u !== targetUrl)];
  return [...new Set(urls)].slice(0, 6);
}

/** Drops sample URLs and page rows from all but the client's last KEEP_DETAIL completed audits. */
export async function pruneAuditDetail(clientId: string): Promise<number> {
  const old = await prisma.siteAudit.findMany({ where: { clientId, status: "completed", detailPrunedAt: null }, orderBy: { createdAt: "desc" }, skip: KEEP_DETAIL, select: { id: true } });
  if (!old.length) return 0;
  const ids = old.map((a) => a.id);
  await prisma.$transaction([
    prisma.siteAuditPage.deleteMany({ where: { auditId: { in: ids } } }),
    prisma.siteAuditIssue.updateMany({ where: { auditId: { in: ids } }, data: { sampleUrls: [] } }),
    prisma.siteAudit.updateMany({ where: { id: { in: ids } }, data: { detailPrunedAt: new Date() } }),
  ]);
  return ids.length;
}

/** Writes the AI summary for a completed audit. Never throws; a failure is stored for the tab to show. */
export async function summarizeAudit(auditId: string): Promise<void> {
  // Without an API key the pipeline throws "The AI assistant isn't set up…", stored below like any failure.
  try {
    const data = await auditSummaryData(auditId);
    const summary = await draftSiteAuditSummary(data);
    await prisma.siteAudit.update({ where: { id: auditId }, data: { aiSummary: summary as unknown as Prisma.InputJsonValue, aiSummaryError: null } });
  } catch (e) {
    await prisma.siteAudit.update({ where: { id: auditId }, data: { aiSummaryError: ((e as Error).message ?? "AI summary failed.").slice(0, 300) } });
  }
}

/**
 * What the crawl itself finally cost. DataForSEO charges task_post for every
 * allowed page up front and refunds the pages it didn't crawl (seen live: 50
 * pages charged $0.0225, 3 crawled, $0.00135 kept), so the charge per allowed
 * page times the pages crawled.
 */
export function crawlCharge(upfront: number, maxPages: number, pagesCrawled: number): number {
  if (maxPages <= 0) return upfront;
  return Math.round((upfront / maxPages) * Math.min(Math.max(pagesCrawled, 0), maxPages) * 1e6) / 1e6;
}

/** Version of the analysis rules (exclusions, severities, score). Older audits can be re-analysed for free. */
export const ANALYSIS_VERSION = 2;

const ignorePatternsFor = async (clientId: string) => (await prisma.siteAuditConfig.findUnique({ where: { clientId }, select: { ignorePatterns: true } }))?.ignorePatterns ?? [];

/** Replaces an audit's issues and pages with `findings` and updates the audit row in one transaction. */
async function storeFindings(auditId: string, findings: CrawlFindings, data: Prisma.SiteAuditUpdateInput, ignorePatterns: string[]) {
  await prisma.$transaction([
    prisma.siteAuditIssue.deleteMany({ where: { auditId } }),
    prisma.siteAuditPage.deleteMany({ where: { auditId } }),
    prisma.siteAuditIssue.createMany({ data: findings.issues.map((i) => ({ auditId, issueKey: i.key, severity: i.severity, category: i.category, count: i.count, sampleUrls: i.sampleUrls })) }),
    prisma.siteAuditPage.createMany({ data: findings.pageRows.slice(0, 5000).map((p) => ({ auditId, ...p })) }),
    prisma.siteAudit.update({
      where: { id: auditId },
      data: {
        ...data,
        pagesCrawled: findings.pages,
        healthScore: healthScore({ pages: findings.pages, issues: findings.issues }),
        errorPages: findings.errorPages,
        warningPages: findings.warningPages,
        noticePages: findings.noticePages,
        analysisVersion: ANALYSIS_VERSION,
        ignorePatterns,
      },
    }),
  ]);
}

/** Collects a finished crawl: issues, pages, score, Lighthouse, costs. Leaves the audit completed (or failed). */
async function finishAudit(audit: SiteAudit, secret: string, crawl: { domainChecks: Record<string, boolean | null> | null; onpageScore: number | null; pagesCrawled: number; server: string | null }, deps: JobDeps) {
  const now = deps.now ?? new Date();
  const client = await prisma.client.findUniqueOrThrow({ where: { id: audit.clientId }, select: { timezone: true } });
  const ignore = await ignorePatternsFor(audit.clientId);
  const { findings, cost } = await collectCrawl(secret, audit.providerTaskId!, { targetUrl: audit.targetUrl, maxPages: audit.maxPages, domainChecks: crawl.domainChecks, ignore }, deps.fetch);
  const lh = await runLighthouse(secret, await lighthouseUrls(audit.clientId, audit.targetUrl, audit.lighthouseMode, client.timezone, now), deps.fetch, { server: crawl.server, retryDelayMs: deps.retryDelayMs });
  await storeFindings(audit.id, findings, {
    status: "completed",
    finishedAt: now,
    onpageScore: crawl.onpageScore,
    serverSoftware: crawl.server,
    lighthouse: lh.rows.length ? (lh.rows as unknown as Prisma.InputJsonValue) : undefined,
    actualCost: crawlCharge(audit.actualCost ?? 0, audit.maxPages, crawl.pagesCrawled) + cost + lh.cost,
    errorCode: null,
    errorMessage: audit.stopRequestedAt ? `Stopped early by an administrator after ${crawl.pagesCrawled} pages; results cover those pages.` : null,
  }, ignore);
  await pruneAuditDetail(audit.clientId);
  await summarizeAudit(audit.id);
}

/**
 * Re-checks a finished crawl with the current rules and the client's ignore
 * patterns, without crawling again: the crawl's results are read back from
 * DataForSEO (free while DataForSEO still holds them). If it no longer does,
 * the stored issue counts are re-scored with the current formula and
 * severities; CDN-path and ignore-pattern exclusions then can't be applied.
 * Lighthouse results and costs are kept. The AI summary is rewritten.
 */
export async function reanalyzeAudit(auditId: string, deps: JobDeps = {}): Promise<{ mode: "refetched" | "stored"; before: number | null; after: number | null; speedRetried: number }> {
  const audit = await prisma.siteAudit.findUniqueOrThrow({ where: { id: auditId }, include: { client: { select: { agencyId: true } }, issues: true } });
  if (audit.status !== "completed") throw new AuditError("provider_error", "Only a finished audit can be re-checked.");
  const before = audit.healthScore;
  const speedRetried = await retryFailedSpeedTests(audit, deps).catch(() => 0);
  if (audit.providerTaskId) {
    try {
      const { secret } = await agencySecret(audit.client.agencyId);
      const p = await crawlProgress(secret, audit.providerTaskId, deps.fetch);
      if (p.finished && p.pagesCrawled > 0) {
        const ignore = await ignorePatternsFor(audit.clientId);
        const { findings } = await collectCrawl(secret, audit.providerTaskId, { targetUrl: audit.targetUrl, maxPages: audit.maxPages, domainChecks: p.domainChecks, ignore }, deps.fetch);
        if (findings.pages > 0) {
          await storeFindings(audit.id, findings, { serverSoftware: p.server ?? audit.serverSoftware, onpageScore: p.onpageScore ?? audit.onpageScore }, ignore);
          await summarizeAudit(audit.id);
          const after = (await prisma.siteAudit.findUniqueOrThrow({ where: { id: audit.id }, select: { healthScore: true } })).healthScore;
          return { mode: "refetched", before, after, speedRetried };
        }
      }
    } catch (e) {
      const k = classifyError(e).code;
      if (k === "bad_credentials" || k === "insufficient_balance") throw e;
      // DataForSEO no longer has the crawl (or a transient error): fall back to the stored counts.
    }
  }
  // Stored counts, current severities and formula.
  const issues = audit.issues.filter((i) => ISSUE_BY_KEY[i.issueKey]).map((i) => ({ ...i, severity: ISSUE_BY_KEY[i.issueKey].severity }));
  const after = healthScore({ pages: audit.pagesCrawled ?? 0, issues: issues.map((i) => ({ key: i.issueKey, severity: i.severity, count: i.count })) });
  await prisma.$transaction([
    ...issues.map((i) => prisma.siteAuditIssue.update({ where: { id: i.id }, data: { severity: i.severity } })),
    prisma.siteAudit.update({ where: { id: audit.id }, data: { healthScore: after } }),
  ]);
  await summarizeAudit(audit.id);
  return { mode: "stored", before, after, speedRetried };
}

/**
 * Re-runs only the Lighthouse tests of an audit that failed, keeping the ones
 * that worked. DataForSEO doesn't charge for failed tests, so this costs $0
 * if the site still blocks the tester (and stores the real reason), $0.005 per
 * page if it now works. Returns how many were re-run.
 */
async function retryFailedSpeedTests(audit: SiteAudit & { client: { agencyId: string } }, deps: JobDeps): Promise<number> {
  const rows = Array.isArray(audit.lighthouse) ? (audit.lighthouse as unknown as LighthouseRow[]) : [];
  const failed = rows.filter((r) => r.error);
  if (!failed.length) return 0;
  const { secret } = await agencySecret(audit.client.agencyId);
  const lh = await runLighthouse(secret, failed.map((r) => r.url), deps.fetch, { server: audit.serverSoftware, retryDelayMs: deps.retryDelayMs });
  const fresh = new Map(lh.rows.map((r) => [r.url, r]));
  await prisma.siteAudit.update({
    where: { id: audit.id },
    data: { lighthouse: rows.map((r) => fresh.get(r.url) ?? r) as unknown as Prisma.InputJsonValue, actualCost: (audit.actualCost ?? 0) + lh.cost },
  });
  return failed.length;
}

/**
 * Admin: stops the client's running crawl. DataForSEO keeps what it crawled;
 * the poller then collects those pages as a normal (partial) audit. A crawl
 * that hasn't started at DataForSEO yet is simply cancelled.
 */
export async function stopAudit(clientId: string, deps: JobDeps = {}): Promise<SiteAudit> {
  const a = await prisma.siteAudit.findFirst({ where: { clientId, status: { in: ["queued", "crawling"] } }, include: { client: { select: { agencyId: true } } }, orderBy: { createdAt: "desc" } });
  if (!a) throw new AuditError("provider_error", "No crawl is running.");
  if (!a.providerTaskId || a.status === "queued") return fail(a, "provider_error", "Stopped by an administrator before the crawl started.");
  const { secret } = await agencySecret(a.client.agencyId);
  await stopCrawl(secret, a.providerTaskId, deps.fetch);
  return prisma.siteAudit.update({ where: { id: a.id }, data: { stopRequestedAt: deps.now ?? new Date() } });
}

/** Advances running crawls: progress, then results when finished; fails crawls older than 24 h. */
export async function pollActiveAudits(deps: JobDeps = {}): Promise<{ checked: number; completed: number; failed: number }> {
  const now = deps.now ?? new Date();
  const active = await prisma.siteAudit.findMany({ where: { status: "crawling" }, include: { client: { select: { agencyId: true } } }, orderBy: { startedAt: "asc" }, take: 25 });
  let completed = 0, failed = 0;
  for (const a of active) {
    if (a.startedAt && now.getTime() - a.startedAt.getTime() > CRAWL_TIMEOUT_MS) {
      await fail(a, "timeout", "The crawl didn't finish within 24 hours.");
      failed++;
      continue;
    }
    let conn: { secret: string; connectionId: string };
    try {
      conn = await agencySecret(a.client.agencyId);
    } catch (e) {
      const k = classifyError(e);
      await fail(a, k.code, k.message);
      failed++;
      continue;
    }
    try {
      const p = await crawlProgress(conn.secret, a.providerTaskId!, deps.fetch);
      if (!p.finished) {
        await prisma.siteAudit.update({ where: { id: a.id }, data: { pagesCrawled: p.pagesCrawled } });
        continue;
      }
      // Claim it, so a second runner doesn't process the same crawl.
      const claimed = await prisma.siteAudit.updateMany({ where: { id: a.id, status: "crawling" }, data: { status: "processing", pagesCrawled: p.pagesCrawled } });
      if (!claimed.count) continue;
      await finishAudit({ ...a, status: "processing" }, conn.secret, { domainChecks: p.domainChecks, onpageScore: p.onpageScore, pagesCrawled: p.pagesCrawled, server: p.server }, deps);
      completed++;
    } catch (e) {
      const k = classifyError(e);
      if (k.code === "bad_credentials") await markDataSourceNeedsReauth(conn.connectionId, k.message);
      // Rate limits and transient provider errors: back to "crawling" and try again on the next poll (the 24 h timeout still applies).
      if (k.code === "rate_limit" || k.code === "provider_error") {
        await prisma.siteAudit.updateMany({ where: { id: a.id, status: "processing" }, data: { status: "crawling" } });
        continue;
      }
      await fail(a, k.code, k.message);
      failed++;
    }
  }
  return { checked: active.length, completed, failed };
}

/** Hourly entry point (scheduler and cron). */
export async function runSiteAuditJobs(deps: JobDeps = {}) {
  const polled = await pollActiveAudits(deps);
  const scheduled = await scheduleDueAudits(deps);
  return { ...scheduled, ...polled };
}

/** True when any crawl is running (the scheduler then polls every few minutes instead of hourly). */
export const hasActiveCrawls = async () => (await prisma.siteAudit.count({ where: { status: "crawling" } })) > 0;
