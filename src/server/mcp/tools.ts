import "server-only";
// Read tools for the Marketing Nexus MCP connector. None of these change
// anything; the write tools live in write-tools.ts (see index.ts).
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { loadPacing, type PacingRow } from "../pacing-service";
import { INCLUDED_ROWS } from "../campaign-selection";
import { monthBounds, isoToDate, todayInTimeZone, type IsoDate } from "@/lib/pacing/dates";
import type { PacingResult } from "@/lib/pacing/engine";
import { ToolInputError, type McpTool } from "./protocol";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Minor units (cents) to major units (dollars), rounded to cents. */
export const major = (minor: number | bigint | null | undefined): number | null =>
  minor === null || minor === undefined ? null : Math.round(Number(minor)) / 100;

const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/** Which agency the connector serves: MCP_AGENCY_SLUG, or the only agency when there is just one. */
export async function connectorAgencyId(): Promise<string> {
  const slug = process.env.MCP_AGENCY_SLUG?.trim();
  if (slug) {
    const a = await prisma.agency.findUnique({ where: { slug }, select: { id: true } });
    if (!a) throw new ToolInputError(`No agency with slug "${slug}" (check MCP_AGENCY_SLUG).`);
    return a.id;
  }
  const agencies = await prisma.agency.findMany({ select: { id: true }, take: 2 });
  if (agencies.length === 1) return agencies[0].id;
  throw new ToolInputError("Set MCP_AGENCY_SLUG to choose which agency this connector reads.");
}

/** Validates an optional "YYYY-MM" month and returns its first day, or undefined for the current period. */
export function parseMonth(v: unknown): IsoDate | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) throw new ToolInputError('month must look like "2026-11".');
  return `${v}-01` as IsoDate;
}

function clientWhere(agencyId: string, client: unknown, includeArchived = false): Prisma.ClientWhereInput {
  const where: Prisma.ClientWhereInput = { agencyId, ...(includeArchived ? {} : { archivedAt: null }) };
  if (client === undefined || client === null || client === "") return where;
  if (typeof client !== "string") throw new ToolInputError("client must be a client name or id.");
  return { ...where, OR: [{ id: client }, { name: { contains: client.trim(), mode: "insensitive" } }] };
}

export function pacingSummary(r: Omit<PacingResult, "series"> | PacingResult | null) {
  if (!r) return null;
  return {
    period: { start: r.periodStart, end: r.periodEnd, asOf: r.asOf, phase: r.phase },
    days: { total: r.totalDays, elapsed: r.elapsedDays, remaining: r.remainingDays, remainingActive: r.remainingActiveDays },
    budget: major(r.budgetMinor),
    spentToDate: major(r.actualToDateMinor),
    expectedToDate: major(r.expectedToDateMinor),
    remainingBudget: major(r.remainingBudgetMinor),
    projectedMonthEnd: major(r.projectedMinor),
    projectedVariance: major(r.projectedVarianceMinor),
    pacingPct: pct(r.pacingPct),
    pctBudgetConsumed: pct(r.pctBudgetConsumed),
    pctPeriodElapsed: pct(r.pctPeriodElapsed),
    forecastPct: pct(r.forecastPct),
    status: r.status,
    forecastStatus: r.forecastStatus,
    forecastModel: r.forecastModel,
    currentDailyRate: major(r.currentDailyRateMinor),
    requiredDaily: major(r.requiredDailyMinor),
    recommendedDailyChange: major(r.recommendedDailyChangeMinor),
    recommendedDailyChangePct: pct(r.recommendedDailyChangePct),
  };
}

function rowSummary(row: PacingRow) {
  return {
    label: row.label,
    level: row.level,
    platforms: row.platforms,
    accounts: row.accounts.map((a) => ({ name: a.name, platform: a.platform, externalId: a.externalId, lastSuccessfulSyncAt: a.lastSuccessfulSyncAt, dataCompleteThrough: a.dataCompleteThrough, stale: a.stale })),
    pacing: pacingSummary(row.result),
    unbudgetedSpend: row.level === "UNBUDGETED" ? major(row.unbudgetedSpendMinor) : undefined,
    spendIncludingToday: major(row.latestSpendMinor),
    currentPlatformDailyBudget: row.currentDaily ? { amount: major(row.currentDaily.minor), note: row.currentDaily.note } : null,
    recommendation: { severity: row.action.severity, headline: row.action.headline, detail: row.action.detail },
    needsAttention: row.attention,
    stale: row.stale,
    disconnected: row.disconnected,
    notConnected: row.notConnected,
    hasEstimatedSpend: row.hasEstimatedSpend,
    warnings: row.warnings,
  };
}

async function listClients(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const clients = await prisma.client.findMany({
    where: clientWhere(agencyId, args.client, args.include_archived === true),
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      timezone: true,
      currency: true,
      archivedAt: true,
      primaryManager: { select: { name: true } },
      labels: { select: { name: true } },
      accounts: { select: { name: true, platform: true, externalId: true, status: true, lastSuccessfulSyncAt: true, connectionId: true, isDemo: true } },
    },
  });
  return {
    count: clients.length,
    clients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      labels: c.labels.map((l) => l.name),
      manager: c.primaryManager?.name ?? null,
      timezone: c.timezone,
      currency: c.currency,
      archived: !!c.archivedAt,
      accounts: c.accounts.map((a) => ({
        name: a.name,
        platform: a.platform,
        externalId: a.externalId,
        status: a.status,
        monitored: a.isDemo || !!a.connectionId,
        lastSuccessfulSyncAt: a.lastSuccessfulSyncAt?.toISOString() ?? null,
      })),
    })),
  };
}

async function getBudgetPacing(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const periodDate = parseMonth(args.month);
  const pacing = await loadPacing(clientWhere(agencyId, args.client), new Date(), periodDate);
  return {
    count: pacing.length,
    note: "Amounts are in each client's currency. pacingPct = spend to date ÷ expected spend to date. Status thresholds come from the agency settings.",
    clients: pacing.map((p) => ({
      id: p.client.id,
      name: p.client.name,
      manager: p.client.managerName,
      currency: p.client.currency,
      timezone: p.client.timezone,
      today: p.today,
      period: p.period,
      thresholds: p.thresholds,
      total: pacingSummary(p.total),
      budgetLines: p.rows.map(rowSummary),
      subLines: p.subRows.map(rowSummary),
    })),
  };
}

async function getCampaigns(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  if (typeof args.client !== "string" || !args.client.trim()) throw new ToolInputError("client is required (name or id).");
  const periodDate = parseMonth(args.month);
  const clients = await prisma.client.findMany({
    where: clientWhere(agencyId, args.client),
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      timezone: true,
      accounts: {
        select: {
          id: true,
          name: true,
          platform: true,
          externalId: true,
          campaigns: { where: { excludedAt: null }, orderBy: { name: "asc" }, select: { id: true, externalId: true, name: true, status: true, platformDailyBudgetMinor: true, platformBudgetKind: true, platformBudgetId: true, budgets: { select: { id: true } } } },
        },
      },
    },
  });
  const out = [];
  for (const c of clients) {
    const { start, end } = monthBounds(periodDate ?? todayInTimeZone(c.timezone));
    const campaignIds = c.accounts.flatMap((a) => a.campaigns.map((x) => x.id));
    const perf = campaignIds.length
      ? await prisma.dailyPerformance.groupBy({
          by: ["campaignId"],
          where: { campaignId: { in: campaignIds }, date: { gte: isoToDate(start), lte: isoToDate(end) }, ...INCLUDED_ROWS },
          _sum: { costMinor: true, clicks: true, impressions: true, conversions: true, leads: true },
        })
      : [];
    const byId = new Map(perf.map((p) => [p.campaignId, p._sum]));
    out.push({
      id: c.id,
      name: c.name,
      period: { start, end },
      accounts: c.accounts.map((a) => ({
        name: a.name,
        platform: a.platform,
        externalId: a.externalId,
        campaigns: a.campaigns.map((x) => {
          const s = byId.get(x.id);
          return {
            name: x.name,
            externalId: x.externalId,
            status: x.status,
            platformDailyBudget: x.platformBudgetKind === "DAILY" ? major(x.platformDailyBudgetMinor) : null,
            platformBudgetKind: x.platformBudgetKind,
            sharedBudgetId: x.platformBudgetId,
            hasNexusBudget: x.budgets.length > 0,
            periodSpend: major(s?.costMinor ?? 0),
            clicks: Number(s?.clicks ?? 0),
            impressions: Number(s?.impressions ?? 0),
            conversions: s?.conversions ? Number(s.conversions) : 0,
            leads: s?.leads ? Number(s.leads) : null,
          };
        }),
      })),
    });
  }
  return { count: out.length, note: "Campaigns removed from reporting in Marketing Nexus are left out. Conversions are platform-reported.", clients: out };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_clients",
    title: "List clients",
    description: "List Marketing Nexus clients with their labels, manager and linked ad accounts (Google Ads, Google LSA, Meta Ads, Microsoft Ads).",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Optional: filter by client name (partial match) or id." },
        include_archived: { type: "boolean", description: "Include archived clients. Default false." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    handler: listClients,
  },
  {
    name: "get_budget_pacing",
    title: "Get budget pacing",
    description:
      "Monthly budget pacing per client, the same numbers as the Budget Pacing dashboard: monthly budget, spend to date, expected spend to date, projected month-end spend, pacing status, current platform daily budget, the daily spend needed to land on budget, and the app's recommendation for each budget line.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Optional: client name (partial match) or id. Omit for all clients." },
        month: { type: "string", description: 'Optional: a past month as "YYYY-MM". Omit for the current month.' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    handler: getBudgetPacing,
  },
  {
    name: "get_campaigns",
    title: "Get campaigns",
    description: "Campaigns for a client with status, platform daily budget, and month spend, clicks, impressions and conversions from the synced data.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client name (partial match) or id." },
        month: { type: "string", description: 'Optional: "YYYY-MM". Omit for the current month.' },
      },
      required: ["client"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    handler: getCampaigns,
  },
];
