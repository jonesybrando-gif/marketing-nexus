import type { PlatformKey } from "@/lib/platforms";
import "server-only";
import type { DataAssetKind } from "@prisma/client";
import { prisma } from "../db";
import type { MetricSource } from "@/lib/metrics-registry";
import { diffDays, type IsoDate } from "@/lib/pacing/dates";
import { keywordRankTable as rankRows } from "../metrics/rankings";
import type { AuditIssueLite, CallLogRow, FormLogRow, KeywordRankRow } from "@/lib/dashboards/widget-data";
import { issueRows } from "../site-audit/queries";
import type { SiteAuditSummary } from "../ai/assistant";

// Data a dashboard needs from sources that live outside the metric registry's
// query API. Kept behind small functions so the resolver (./data.ts) can be
// tested with mocks and so other branches can be wired in at merge time.

export interface KeywordRankOptions {
  from: IsoDate;
  to: IsoDate;
  /** Comparison period end (for "previous" positions); omitted when there is no comparison. */
  compareTo?: IsoDate;
  limit?: number;
}

export type KeywordRankTableFn = (clientId: string, opts: KeywordRankOptions) => Promise<KeywordRankRow[]>;

/** Tracked keyword positions (DataForSEO) for the rankings widget. */
export const keywordRankTable: KeywordRankTableFn = async (clientId, opts) => {
  const days = Math.max(1, diffDays(opts.from, opts.to) + 1);
  const changeDays = opts.compareTo ? Math.max(1, diffDays(opts.compareTo, opts.to)) : 7;
  const rows = await rankRows(clientId, { to: opts.to, days, changeDays, limit: opts.limit });
  // Grouped by market (location), best position first within each.
  return rows
    .map((r) => ({
      keyword: r.keyword,
      position: r.position,
      previous: r.position != null && r.change != null ? r.position - r.change : null,
      url: r.url,
      location: r.locationName,
      device: r.device,
    }))
    .sort((a, b) => (a.location ?? "").localeCompare(b.location ?? "") || (a.position ?? Infinity) - (b.position ?? Infinity) || a.keyword.localeCompare(b.keyword));
};

const KIND_SOURCES: Record<DataAssetKind, MetricSource[]> = {
  GA4_PROPERTY: ["ga4"],
  GSC_SITE: ["gsc"],
  GBP_LOCATION: ["gbp"],
  FB_PAGE: ["facebook"],
  IG_ACCOUNT: ["instagram"],
  CALLRAIL_COMPANY: ["callrail"],
  RANK_PROJECT: ["rank"],
};

export interface SiteAuditSnapshot {
  /** Latest completed crawl that finished by the end of the period. */
  latest: { id: string; score: number | null; pages: number | null; errorPages: number | null; finishedAt: string; summary: SiteAuditSummary | null } | null;
  /** What it is compared with: the latest crawl before the period began, else the crawl before `latest`. */
  baseline: { score: number | null; finishedAt: string } | null;
  /** Issue rows of `latest` against `baseline`. */
  issues: AuditIssueLite[];
  /** Every completed crawl up to the end of the period, oldest first. */
  trend: { date: string; score: number | null }[];
}

export type SiteAuditSnapshotFn = (clientId: string, opts: { from: IsoDate; to: IsoDate }) => Promise<SiteAuditSnapshot>;

/** Site Auditor data for the audit widgets over a period. */
export const siteAuditSnapshot: SiteAuditSnapshotFn = async (clientId, { from, to }) => {
  const end = new Date(`${to}T23:59:59.999Z`);
  const start = new Date(`${from}T00:00:00Z`);
  const done = await prisma.siteAudit.findMany({
    where: { clientId, status: "completed", finishedAt: { lte: end } },
    orderBy: { finishedAt: "asc" },
    select: { id: true, healthScore: true, pagesCrawled: true, errorPages: true, finishedAt: true, aiSummary: true },
  });
  const latest = done.at(-1);
  if (!latest) return { latest: null, baseline: null, issues: [], trend: [] };
  const before = done.filter((a) => a.finishedAt! < start).at(-1);
  const base = before && before.id !== latest.id ? before : done.at(-2) ?? null;
  const [li, bi] = await Promise.all([
    prisma.siteAuditIssue.findMany({ where: { auditId: latest.id } }),
    base ? prisma.siteAuditIssue.findMany({ where: { auditId: base.id } }) : Promise.resolve(null),
  ]);
  return {
    latest: {
      id: latest.id,
      score: latest.healthScore,
      pages: latest.pagesCrawled,
      errorPages: latest.errorPages,
      finishedAt: latest.finishedAt!.toISOString(),
      summary: latest.aiSummary && typeof latest.aiSummary === "object" ? (latest.aiSummary as unknown as SiteAuditSummary) : null,
    },
    baseline: base ? { score: base.healthScore, finishedAt: base.finishedAt!.toISOString() } : null,
    issues: issueRows(li, bi).map(({ key, label, severity, category, fix, count, previous, change }) => ({ key, label, severity, category, fix, count, previous, change })),
    trend: done.map((a) => ({ date: a.finishedAt!.toISOString().slice(0, 10), score: a.healthScore })),
  };
};

/** Sources with something linked to the client ("ads" = any ad account). Drives "Connect GA4 to see this". */
export async function linkedSources(clientId: string): Promise<MetricSource[]> {
  const [assets, ads] = await Promise.all([
    prisma.dataAsset.findMany({ where: { clientId }, select: { kind: true }, distinct: ["kind"] }),
    prisma.adAccount.count({ where: { clientId } }),
  ]);
  const out = new Set<MetricSource>(assets.flatMap((a) => KIND_SOURCES[a.kind] ?? []));
  if (ads > 0) out.add("ads");
  if (await prisma.siteAuditConfig.count({ where: { clientId } })) out.add("audit");
  return [...out];
}

/** The ad platforms a client has accounts on (for Google Ads, Meta Ads… report sections). */
export async function adPlatforms(clientId: string): Promise<PlatformKey[]> {
  const rows = await prisma.adAccount.findMany({ where: { clientId }, select: { platform: true }, distinct: ["platform"] });
  return rows.map((r) => r.platform as PlatformKey);
}

export type CallLogFn = (clientId: string, opts: { from: IsoDate; to: IsoDate; limit?: number; staff: boolean }) => Promise<{ rows: CallLogRow[]; total: number; timeZone: string | null }>;

/** Most recent calls in the range (CallRail), newest first. Recording links only for staff. */
export const callLog: CallLogFn = async (clientId, { from, to, limit = 100, staff }) => {
  const where = { clientId, date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } };
  const [rows, total, asset] = await Promise.all([
    prisma.callRecord.findMany({ where, orderBy: { startedAt: "desc" }, take: Math.min(Math.max(limit, 1), 500) }),
    prisma.callRecord.count({ where }),
    prisma.dataAsset.findFirst({ where: { clientId, kind: "CALLRAIL_COMPANY" }, select: { timezone: true } }),
  ]);
  return {
    total,
    timeZone: asset?.timezone ?? null,
    rows: rows.map((r) => ({
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      callerName: r.callerName,
      callerNumber: r.callerNumber,
      location: [r.city, r.state].filter(Boolean).join(", ") || null,
      source: r.source,
      campaign: r.campaign,
      keyword: r.keyword,
      durationSec: r.durationSec,
      status: r.answered ? "answered" : r.voicemail ? "voicemail" : "missed",
      firstCall: r.firstCall,
      lead: r.leadStatus === "good_lead",
      tags: r.tags,
      recordingUrl: staff ? r.recordingUrl : null,
    })),
  };
};

export type FormLogFn = (clientId: string, opts: { from: IsoDate; to: IsoDate; limit?: number }) => Promise<{ rows: FormLogRow[]; total: number; timeZone: string | null }>;

/** Most recent form submissions in the range (CallRail form tracking), newest first. */
export const formLog: FormLogFn = async (clientId, { from, to, limit = 100 }) => {
  const where = { clientId, date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } };
  const [rows, total, asset] = await Promise.all([
    prisma.formRecord.findMany({ where, orderBy: { submittedAt: "desc" }, take: Math.min(Math.max(limit, 1), 500) }),
    prisma.formRecord.count({ where }),
    prisma.dataAsset.findFirst({ where: { clientId, kind: "CALLRAIL_COMPANY" }, select: { timezone: true } }),
  ]);
  return {
    total,
    timeZone: asset?.timezone ?? null,
    rows: rows.map((r) => ({ id: r.id, submittedAt: r.submittedAt.toISOString(), name: r.name, formUrl: r.formUrl, referrer: r.referrer, referringUrl: r.referringUrl, firstForm: r.firstForm, lead: r.leadStatus === "good_lead" })),
  };
};
