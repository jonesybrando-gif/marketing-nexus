import "server-only";
import type { SiteAudit, SiteAuditConfig } from "@prisma/client";
import { prisma } from "../db";
import { diffIssues, summarizeDiff, type ChangeKind } from "@/lib/site-audit/diff";
import { ISSUE_BY_KEY, SEVERITIES, type Category, type Severity } from "@/lib/site-audit/issues";
import type { SiteAuditSummary } from "../ai/assistant";
import type { LighthouseRow } from "./engine";

// Read models for the Site Audit tab, dashboard widgets, reports and the AI
// summary. Issue changes are computed on read from the stored counts.

export interface AuditIssueRow {
  key: string;
  label: string;
  severity: Severity;
  category: Category;
  fix: string;
  /** Pages affected now (0 for fixed issues). */
  count: number;
  /** Count in the previous completed crawl (null on a first crawl). */
  previous: number | null;
  change: ChangeKind;
  sampleUrls: string[];
  /** Site-wide check (not counted in the score). */
  siteWide: boolean;
}

export interface AuditPoint { id: string; date: string; score: number | null; errorPages: number | null; pages: number | null }

export interface SiteAuditView {
  config: SiteAuditConfig | null;
  /** Latest completed audit. */
  latest: SiteAudit | null;
  /** The completed audit before it. */
  previous: SiteAudit | null;
  /** A crawl in progress (queued, crawling or processing). */
  running: SiteAudit | null;
  /** Newest audit of any status (to show a failure or skip after the last success). */
  lastAttempt: SiteAudit | null;
  issues: AuditIssueRow[];
  changes: Record<ChangeKind, number>;
  trend: AuditPoint[];
  lighthouse: LighthouseRow[];
  aiSummary: SiteAuditSummary | null;
}

const SEV_ORDER: Record<Severity, number> = { error: 0, warning: 1, notice: 2 };

/** Issue rows of `latest` against `previous`, worst first: severity, then pages affected; fixed ones last within their severity. */
export function issueRows(latest: { issueKey: string; count: number; sampleUrls: unknown }[], previous: { issueKey: string; count: number }[] | null): AuditIssueRow[] {
  const changes = diffIssues(latest.map((i) => ({ key: i.issueKey, count: i.count })), previous ? previous.map((i) => ({ key: i.issueKey, count: i.count })) : null);
  const samples = new Map(latest.map((i) => [i.issueKey, Array.isArray(i.sampleUrls) ? (i.sampleUrls as unknown[]).filter((u): u is string => typeof u === "string" && !!u) : []]));
  return changes
    .filter((c) => ISSUE_BY_KEY[c.key])
    .map((c) => {
      const d = ISSUE_BY_KEY[c.key];
      return { key: c.key, label: d.label, severity: d.severity, category: d.category, fix: d.fix, count: c.count, previous: c.previous, change: c.kind, sampleUrls: samples.get(c.key) ?? [], siteWide: d.scope === "site" };
    })
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || Number(a.change === "fixed") - Number(b.change === "fixed") || b.count - a.count || a.label.localeCompare(b.label));
}

export async function siteAuditView(clientId: string): Promise<SiteAuditView> {
  const [config, completed, running, lastAttempt, history] = await Promise.all([
    prisma.siteAuditConfig.findUnique({ where: { clientId } }),
    prisma.siteAudit.findMany({ where: { clientId, status: "completed" }, orderBy: { createdAt: "desc" }, take: 2, include: { issues: true } }),
    prisma.siteAudit.findFirst({ where: { clientId, status: { in: ["queued", "crawling", "processing"] } }, orderBy: { createdAt: "desc" } }),
    prisma.siteAudit.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" } }),
    prisma.siteAudit.findMany({ where: { clientId, status: "completed" }, orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true, finishedAt: true, healthScore: true, errorPages: true, pagesCrawled: true } }),
  ]);
  const [latest, previous] = completed;
  const issues = latest ? issueRows(latest.issues, previous?.issues ?? null) : [];
  return {
    config,
    latest: latest ?? null,
    previous: previous ?? null,
    running,
    lastAttempt,
    issues,
    changes: summarizeDiff(issues.map((i) => ({ key: i.key, kind: i.change, count: i.count, previous: i.previous }))),
    trend: history.map((h) => ({ id: h.id, date: (h.finishedAt ?? h.createdAt).toISOString(), score: h.healthScore, errorPages: h.errorPages, pages: h.pagesCrawled })),
    lighthouse: Array.isArray(latest?.lighthouse) ? (latest!.lighthouse as unknown as LighthouseRow[]) : [],
    aiSummary: latest?.aiSummary && typeof latest.aiSummary === "object" ? (latest.aiSummary as unknown as SiteAuditSummary) : null,
  };
}

export interface AgencyAuditRow {
  clientId: string;
  clientName: string;
  targetUrl: string | null;
  score: number | null;
  /** Score change vs the previous completed crawl. */
  change: number | null;
  errorPages: number | null;
  errors: number;
  pages: number | null;
  lastCrawl: string | null;
  status: string | null;
  errorCode: string | null;
  nextRunAt: string | null;
  schedule: string | null;
}

/** Every visible client with a site audit set up (or any audit), worst first. */
export async function agencyAuditList(clientWhere: object): Promise<AgencyAuditRow[]> {
  const clients = await prisma.client.findMany({
    where: { ...clientWhere, archivedAt: null, OR: [{ siteAuditConfig: { isNot: null } }, { siteAudits: { some: {} } }] },
    select: {
      id: true,
      name: true,
      siteAuditConfig: { select: { targetUrl: true, nextRunAt: true, schedule: true, active: true } },
      siteAudits: { orderBy: { createdAt: "desc" }, take: 8, select: { status: true, healthScore: true, errorPages: true, pagesCrawled: true, finishedAt: true, createdAt: true, errorCode: true, issues: { where: { severity: "error" }, select: { count: true } } } },
    },
  });
  const rows = clients.map((c): AgencyAuditRow => {
    const done = c.siteAudits.filter((a) => a.status === "completed");
    const [a, b] = done;
    const newest = c.siteAudits[0];
    return {
      clientId: c.id,
      clientName: c.name,
      targetUrl: c.siteAuditConfig?.targetUrl ?? null,
      score: a?.healthScore ?? null,
      change: a?.healthScore != null && b?.healthScore != null ? a.healthScore - b.healthScore : null,
      errorPages: a?.errorPages ?? null,
      errors: a ? a.issues.reduce((s, i) => s + i.count, 0) : 0,
      pages: a?.pagesCrawled ?? null,
      lastCrawl: (a?.finishedAt ?? a?.createdAt)?.toISOString() ?? null,
      status: newest?.status ?? null,
      errorCode: newest && newest.status !== "completed" ? newest.errorCode : null,
      nextRunAt: c.siteAuditConfig?.active ? c.siteAuditConfig.nextRunAt?.toISOString() ?? null : null,
      schedule: c.siteAuditConfig?.schedule ?? null,
    };
  });
  // Worst first: lowest score, then most errors; sites with no score yet at the end.
  return rows.sort((x, y) => (x.score ?? 101) - (y.score ?? 101) || y.errors - x.errors || x.clientName.localeCompare(y.clientName));
}

export { SEVERITIES };
