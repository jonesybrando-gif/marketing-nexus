import "server-only";
// Write tools for the Marketing Nexus MCP connector. They change only Marketing
// Nexus's own records (budgets used for pacing, which campaigns count for a
// client, which ad accounts a client tracks). Nothing here changes anything
// inside Google, Meta or Microsoft. Set MCP_READ_ONLY=true to switch them off.
import type { Platform, Prisma } from "@prisma/client";
import { after } from "next/server";
import { prisma } from "../db";
import { validateNewBudget, validateRevision } from "@/lib/budget-validation";
import { isWholeMonth } from "@/lib/budget-rollover";
import { addDays, dateToIso, isoToDate, monthBounds, todayInTimeZone, type IsoDate } from "@/lib/pacing/dates";
import { setCampaignIncluded, setIncludeNewCampaigns, CampaignSelectionError } from "../campaign-selection";
import { linkAccountToClient, removeStoppedAccount, stopTrackingAccount } from "../client-accounts";
import { getAdapter } from "../integrations/registry";
import { withAccessToken } from "../integrations/tokens";
import { IntegrationError } from "../integrations/errors";
import { syncAccount } from "../sync/sync-account";
import { ToolInputError, type McpTool } from "./protocol";
import { connectorAgencyId, major, parseMonth } from "./tools";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const PLATFORMS = ["GOOGLE_ADS", "GOOGLE_LSA", "META_ADS", "MICROSOFT_ADS"] as const;
const NOTE = "Set via Claude connector";

/** True unless MCP_READ_ONLY is "true" / "1". */
export function writesEnabled(): boolean {
  const v = process.env.MCP_READ_ONLY?.trim().toLowerCase();
  return !(v === "true" || v === "1" || v === "yes");
}

/** "123-456-7890" → "1234567890", "act_123" → "123". */
export function normalizeExternalId(v: unknown, field = "account_id"): string {
  if (typeof v !== "string" && typeof v !== "number") throw new ToolInputError(`${field} is required.`);
  const s = String(v).trim().replace(/^act_/i, "").replace(/[\s-]/g, "");
  if (!/^\d+$/.test(s)) throw new ToolInputError(`${field} must be the platform's numeric id (e.g. 123-456-7890 or act_123).`);
  return s;
}

export function parsePlatform(v: unknown, required = false): Platform | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolInputError(`platform is required: one of ${PLATFORMS.join(", ")}.`);
    return undefined;
  }
  const s = String(v).trim().toUpperCase().replace(/[\s-]/g, "_");
  const alias: Record<string, Platform> = { GOOGLE: "GOOGLE_ADS", LSA: "GOOGLE_LSA", META: "META_ADS", FACEBOOK: "META_ADS", MICROSOFT: "MICROSOFT_ADS", BING: "MICROSOFT_ADS" };
  const p = (alias[s] ?? s) as Platform;
  if (!(PLATFORMS as readonly string[]).includes(p)) throw new ToolInputError(`platform must be one of ${PLATFORMS.join(", ")}.`);
  return p;
}

/** Dollars (number or "1,000.50") → minor units. */
export function parseAmountToMinor(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new ToolInputError("amount must be a non-negative number of dollars (e.g. 1000).");
  return Math.round(n * 100);
}

function parseIsoDate(v: unknown, field: string): IsoDate | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ToolInputError(`${field} must look like "2026-11-16".`);
  return v as IsoDate;
}

function requireConfirm(args: Record<string, unknown>, what: string) {
  if (args.confirm !== true) throw new ToolInputError(`${what} Pass confirm: true to go ahead.`);
}

/** Exactly one client by id or name (exact name wins over a partial match). */
async function oneClient(agencyId: string, client: unknown) {
  if (typeof client !== "string" || !client.trim()) throw new ToolInputError("client is required (name or id).");
  const q = client.trim();
  const matches = await prisma.client.findMany({
    where: { agencyId, archivedAt: null, OR: [{ id: q }, { name: { contains: q, mode: "insensitive" } }] },
    select: { id: true, name: true, timezone: true, currency: true },
    take: 10,
  });
  const exact = matches.filter((m) => m.id === q || m.name.toLowerCase() === q.toLowerCase());
  const pick = exact.length === 1 ? exact : matches;
  if (pick.length === 0) throw new ToolInputError(`No client matches "${q}".`);
  if (pick.length > 1) throw new ToolInputError(`"${q}" matches several clients: ${pick.map((m) => m.name).join("; ")}. Use the exact name or id.`);
  return pick[0];
}

async function clientAccount(clientId: string, args: Record<string, unknown>, opts: { includeDisconnected?: boolean } = {}) {
  const externalId = normalizeExternalId(args.account_id);
  const platform = parsePlatform(args.platform);
  const accounts = await prisma.adAccount.findMany({
    where: { clientId, externalId, isDemo: false, ...(platform ? { platform } : {}), ...(opts.includeDisconnected ? {} : { status: { not: "DISCONNECTED" } }) },
    select: { id: true, name: true, platform: true, externalId: true, status: true, connectionId: true },
  });
  if (accounts.length === 0) throw new ToolInputError(`This client has no${opts.includeDisconnected ? "" : " active"} ${platform ?? ""} account ${externalId}.`.replace(/\s+/g, " "));
  if (accounts.length > 1) throw new ToolInputError(`Account ${externalId} is linked on several platforms (${accounts.map((a) => a.platform).join(", ")}). Pass platform.`);
  return accounts[0];
}

async function clientCampaign(clientId: string, args: Record<string, unknown>) {
  const externalId = normalizeExternalId(args.campaign_id, "campaign_id");
  const where: Prisma.CampaignWhereInput = { externalId, account: { clientId } };
  if (args.account_id !== undefined) where.account = { clientId, externalId: normalizeExternalId(args.account_id) };
  const campaigns = await prisma.campaign.findMany({ where, select: { id: true, name: true, excludedAt: true, accountId: true, account: { select: { platform: true, externalId: true } } } });
  if (campaigns.length === 0) throw new ToolInputError(`This client has no campaign ${externalId}. It must be in one of the client's linked accounts and synced (call get_campaigns or list_budgets).`);
  if (campaigns.length > 1) throw new ToolInputError(`Campaign ${externalId} appears in several of this client's accounts. Pass account_id.`);
  return campaigns[0];
}

// ---------------------------------------------------------------------------
// Read helpers used before writing
// ---------------------------------------------------------------------------

async function listBudgets(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const c = await oneClient(agencyId, args.client);
  const month = parseMonth(args.month) ?? todayInTimeZone(c.timezone);
  const { start, end } = monthBounds(month);
  const budgets = await prisma.budget.findMany({
    where: { clientId: c.id, periodStart: { lte: isoToDate(end) }, periodEnd: { gte: isoToDate(start) } },
    orderBy: [{ scope: "asc" }, { periodStart: "asc" }],
    include: {
      account: { select: { name: true, platform: true, externalId: true } },
      campaign: { select: { name: true, externalId: true, account: { select: { platform: true, externalId: true } } } },
      revisions: { orderBy: { effectiveDate: "asc" }, select: { amountMinor: true, effectiveDate: true, note: true } },
    },
  });
  return {
    client: c.name,
    month: start.slice(0, 7),
    count: budgets.length,
    budgets: budgets.map((b) => ({
      budgetId: b.id,
      level: b.scope,
      account: b.account ? { name: b.account.name, platform: b.account.platform, accountId: b.account.externalId } : null,
      campaign: b.campaign ? { name: b.campaign.name, campaignId: b.campaign.externalId, platform: b.campaign.account.platform, accountId: b.campaign.account.externalId } : null,
      periodStart: dateToIso(b.periodStart),
      periodEnd: dateToIso(b.periodEnd),
      currentAmount: major(b.revisions.at(-1)?.amountMinor ?? 0),
      revisions: b.revisions.map((r) => ({ amount: major(r.amountMinor), effectiveDate: dateToIso(r.effectiveDate), note: r.note })),
      repeatsMonthly: b.repeatsMonthly,
    })),
  };
}

async function listLinkableAccounts(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const platform = parsePlatform(args.platform, true)!;
  const connPlatform = platform === "GOOGLE_LSA" ? "GOOGLE_ADS" : platform;
  const search = typeof args.search === "string" ? args.search.trim().toLowerCase() : "";
  const connections = await prisma.platformConnection.findMany({
    where: { agencyId, platform: connPlatform, status: { not: "DISCONNECTED" } },
    select: { id: true, label: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  const adapter = getAdapter(connPlatform);
  const out = [];
  for (const conn of connections) {
    try {
      const remote = await withAccessToken(conn.id, adapter, (t) => adapter.listAccounts(t));
      const accounts = remote
        .filter((a) => !a.isManager)
        .filter((a) => !search || a.name.toLowerCase().includes(search) || a.externalId.includes(search.replace(/[\s-]/g, "").replace(/^act_/, "")))
        .map((a) => ({ accountId: a.externalId, displayId: a.displayId ?? a.externalId, name: a.name, currency: a.currency, timezone: a.timezone, statusNote: a.statusNote ?? null }));
      out.push({ connectionId: conn.id, login: conn.label, status: conn.status, count: accounts.length, accounts });
    } catch (e) {
      out.push({ connectionId: conn.id, login: conn.label, status: conn.status, error: e instanceof IntegrationError ? e.message : "Could not load accounts from the platform." });
    }
  }
  return {
    platform,
    note: connections.length ? "Accounts each saved login can reach. Link one with link_ad_account." : `No ${connPlatform} login is saved in Marketing Nexus. Connect one in the app (client > Ad accounts) first.`,
    logins: out,
  };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

async function setBudget(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const c = await oneClient(agencyId, args.client);
  const level = String(args.level ?? "").toUpperCase();
  if (level !== "CLIENT" && level !== "ACCOUNT" && level !== "CAMPAIGN") throw new ToolInputError('level must be "client", "account" or "campaign".');
  const amountMinor = parseAmountToMinor(args.amount);
  const today = todayInTimeZone(c.timezone);
  const { start, end } = monthBounds(parseMonth(args.month) ?? today);

  let accountId: string | null = null;
  let campaignId: string | null = null;
  let target = c.name;
  if (level === "ACCOUNT") {
    const a = await clientAccount(c.id, args);
    accountId = a.id;
    target = `${a.platform} ${a.name} (${a.externalId})`;
  } else if (level === "CAMPAIGN") {
    const camp = await clientCampaign(c.id, args);
    if (camp.excludedAt) throw new ToolInputError(`${camp.name} is left out of this client's reports. Add it back with set_campaign_included first.`);
    accountId = camp.accountId;
    campaignId = camp.id;
    target = `campaign ${camp.name} (${camp.account.platform})`;
  }

  // An existing budget for the same target covering this month gets a revision.
  const existing = await prisma.budget.findFirst({
    where: { clientId: c.id, scope: level, accountId, campaignId, periodStart: { lte: isoToDate(end) }, periodEnd: { gte: isoToDate(start) } },
    include: { revisions: { orderBy: { effectiveDate: "asc" } } },
  });
  if (existing) {
    const pStart = dateToIso(existing.periodStart);
    const pEnd = dateToIso(existing.periodEnd);
    const effective = parseIsoDate(args.effective_date, "effective_date") ?? (today >= pStart && today <= pEnd ? today : pStart);
    const errors = validateRevision(pStart, pEnd, effective, amountMinor);
    if (errors.length) throw new ToolInputError(errors.join(" "));
    const before = major(existing.revisions.at(-1)?.amountMinor ?? 0);
    await prisma.budgetRevision.create({ data: { budgetId: existing.id, amountMinor: BigInt(amountMinor), effectiveDate: isoToDate(effective), note: typeof args.note === "string" && args.note.trim() ? args.note.trim().slice(0, 200) : NOTE } });
    let repeats = existing.repeatsMonthly;
    if (typeof args.repeats_monthly === "boolean" && isWholeMonth(pStart, pEnd)) {
      repeats = args.repeats_monthly;
      await prisma.budget.update({ where: { id: existing.id }, data: { repeatsMonthly: repeats } });
    }
    console.info(`[mcp] revised budget ${existing.id} for ${c.name}: ${before} -> ${major(amountMinor)} from ${effective}`);
    return { ok: true, action: "revised", client: c.name, target, budgetId: existing.id, period: { start: pStart, end: pEnd }, previousAmount: before, newAmount: major(amountMinor), effectiveDate: effective, repeatsMonthly: repeats };
  }

  const all = await prisma.budget.findMany({ where: { clientId: c.id }, select: { id: true, scope: true, accountId: true, campaignId: true, periodStart: true, periodEnd: true } });
  const errors = validateNewBudget(
    { scope: level, accountId, campaignId, periodStart: start, periodEnd: end, amountMinor },
    all.map((b) => ({ id: b.id, scope: b.scope, accountId: b.accountId, campaignId: b.campaignId, periodStart: dateToIso(b.periodStart), periodEnd: dateToIso(b.periodEnd) })),
  );
  if (errors.length) throw new ToolInputError(errors.join(" "));
  const repeats = args.repeats_monthly !== false;
  const created = await prisma.budget.create({
    data: {
      clientId: c.id,
      scope: level,
      accountId,
      campaignId,
      periodStart: isoToDate(start),
      periodEnd: isoToDate(end),
      currency: c.currency,
      repeatsMonthly: repeats,
      revisions: { create: [{ amountMinor: BigInt(amountMinor), effectiveDate: isoToDate(start), note: typeof args.note === "string" && args.note.trim() ? args.note.trim().slice(0, 200) : NOTE }] },
    },
  });
  console.info(`[mcp] created budget ${created.id} for ${c.name}: ${level} ${major(amountMinor)} ${start}..${end}`);
  return { ok: true, action: "created", client: c.name, target, budgetId: created.id, period: { start, end }, amount: major(amountMinor), repeatsMonthly: repeats };
}

async function deleteBudget(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const c = await oneClient(agencyId, args.client);
  if (typeof args.budget_id !== "string" || !args.budget_id) throw new ToolInputError("budget_id is required (from list_budgets).");
  const budget = await prisma.budget.findFirst({ where: { id: args.budget_id, clientId: c.id }, include: { revisions: { orderBy: { effectiveDate: "desc" }, take: 1 } } });
  if (!budget) throw new ToolInputError("That budget doesn't exist for this client.");
  requireConfirm(args, `This deletes the ${budget.scope.toLowerCase()} budget of ${major(budget.revisions[0]?.amountMinor ?? 0)} for ${dateToIso(budget.periodStart)} to ${dateToIso(budget.periodEnd)} and its revision history.`);
  // Same as the app: stop last month's matching budget repeating, or the roll-forward recreates it.
  const prevEnd = addDays(dateToIso(budget.periodStart), -1);
  await prisma.$transaction([
    prisma.budget.updateMany({
      where: { clientId: c.id, scope: budget.scope, accountId: budget.accountId, campaignId: budget.campaignId, periodEnd: isoToDate(prevEnd), repeatsMonthly: true },
      data: { repeatsMonthly: false },
    }),
    prisma.budget.delete({ where: { id: budget.id } }),
  ]);
  console.info(`[mcp] deleted budget ${budget.id} for ${c.name}`);
  return { ok: true, action: "deleted", client: c.name, budgetId: budget.id };
}

// ---------------------------------------------------------------------------
// Campaign selection
// ---------------------------------------------------------------------------

async function setCampaignIncludedTool(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const c = await oneClient(agencyId, args.client);
  if (typeof args.included !== "boolean") throw new ToolInputError("included must be true (count it) or false (leave it out).");
  const camp = await clientCampaign(c.id, args);
  try {
    const name = await setCampaignIncluded(agencyId, c.id, camp.id, args.included);
    console.info(`[mcp] ${c.name}: campaign ${name} included=${args.included}`);
    return { ok: true, client: c.name, campaign: name, campaignId: normalizeExternalId(args.campaign_id, "campaign_id"), included: args.included };
  } catch (e) {
    if (e instanceof CampaignSelectionError) throw new ToolInputError(e.message);
    throw e;
  }
}

async function setIncludeNewCampaignsTool(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const c = await oneClient(agencyId, args.client);
  if (typeof args.value !== "boolean") throw new ToolInputError("value must be true or false.");
  const a = await clientAccount(c.id, args, { includeDisconnected: true });
  await setIncludeNewCampaigns(agencyId, c.id, a.id, args.value);
  return { ok: true, client: c.name, account: `${a.platform} ${a.name} (${a.externalId})`, includeNewCampaigns: args.value };
}

// ---------------------------------------------------------------------------
// Ad accounts
// ---------------------------------------------------------------------------

async function linkAdAccount(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const c = await oneClient(agencyId, args.client);
  const platform = parsePlatform(args.platform, true)!;
  const externalId = normalizeExternalId(args.account_id);
  const connPlatform = platform === "GOOGLE_LSA" ? "GOOGLE_ADS" : platform;
  const connections = await prisma.platformConnection.findMany({
    where: { agencyId, platform: connPlatform, status: { not: "DISCONNECTED" }, ...(typeof args.connection_id === "string" && args.connection_id ? { id: args.connection_id } : {}) },
    select: { id: true, label: true },
    orderBy: { createdAt: "asc" },
  });
  if (!connections.length) throw new ToolInputError(`No usable ${connPlatform} login is saved in Marketing Nexus. Connect one in the app first.`);
  const adapter = getAdapter(connPlatform);
  for (const conn of connections) {
    let remote;
    try {
      remote = (await withAccessToken(conn.id, adapter, (t) => adapter.listAccounts(t))).find((a) => a.externalId === externalId && !a.isManager);
    } catch {
      continue;
    }
    if (!remote) continue;
    const current = await prisma.adAccount.findFirst({
      where: { clientId: c.id, platform, isDemo: false, status: { not: "DISCONNECTED" }, externalId: { not: externalId } },
      select: { name: true, externalId: true },
    });
    if (current && args.replace !== true) {
      throw new ToolInputError(`${c.name} already tracks ${platform} account ${current.name} (${current.externalId}). A client has one account per platform; linking this one stops syncing that one. Pass replace: true to go ahead.`);
    }
    const result = await linkAccountToClient({ agencyId, clientId: c.id, connectionId: conn.id, remote, platforms: [platform] });
    if (!result.ok) throw new ToolInputError(result.error);
    after(async () => {
      for (const id of result.accountIds) await syncAccount(id, "scheduled");
    });
    console.info(`[mcp] linked ${platform} ${externalId} to ${c.name} via ${conn.label}`);
    return {
      ok: true,
      client: c.name,
      platform,
      account: { accountId: externalId, name: remote.name },
      login: conn.label,
      replacedAccounts: result.replaced,
      sharedWith: result.sharedWith,
      note: result.sharedWith.length
        ? "This account is shared with other clients, so all its campaigns start out left out of this client's reports. Add this client's campaigns with set_campaign_included after the first sync (a minute or two)."
        : "History is importing in the background; numbers appear after the first sync (a minute or two).",
    };
  }
  throw new ToolInputError(`None of the saved ${connPlatform} logins (${connections.map((x) => x.label).join("; ")}) can reach account ${externalId}. Connect a login that has access in the app, then try again.`);
}

async function stopTrackingAdAccount(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const c = await oneClient(agencyId, args.client);
  const a = await clientAccount(c.id, args);
  requireConfirm(args, `This stops syncing ${a.platform} ${a.name} (${a.externalId}) for ${c.name}. Its history stays and still counts in past months.`);
  await stopTrackingAccount(agencyId, c.id, a.id);
  console.info(`[mcp] stopped tracking ${a.platform} ${a.externalId} for ${c.name}`);
  return { ok: true, client: c.name, account: `${a.platform} ${a.name} (${a.externalId})`, status: "DISCONNECTED" };
}

async function removeAdAccount(args: Record<string, unknown>) {
  const agencyId = await connectorAgencyId();
  const c = await oneClient(agencyId, args.client);
  const a = await clientAccount(c.id, args, { includeDisconnected: true });
  if (a.status !== "DISCONNECTED" || a.connectionId) {
    throw new ToolInputError(`${a.name} is still being tracked. Stop tracking it first (stop_tracking_ad_account), then remove it.`);
  }
  const [budgets, spend] = await Promise.all([
    prisma.budget.count({ where: { accountId: a.id } }),
    prisma.dailyPerformance.aggregate({ where: { accountId: a.id }, _sum: { costMinor: true }, _count: true }),
  ]);
  if (budgets > 0) throw new ToolInputError(`${a.name} has ${budgets} budget(s) of its own. Delete them first (list_budgets, delete_budget).`);
  requireConfirm(
    args,
    `This permanently removes ${a.platform} ${a.name} (${a.externalId}) from ${c.name}, with its ${spend._count} stored day rows (${major(spend._sum.costMinor ?? 0) ?? 0} of spend in total). Past months that counted that spend will no longer include it.`,
  );
  const result = await removeStoppedAccount(agencyId, c.id, a.id);
  if (!result.ok) throw new ToolInputError(result.error);
  console.info(`[mcp] removed disconnected ${a.platform} ${a.externalId} from ${c.name}`);
  return { ok: true, client: c.name, removed: `${a.platform} ${a.name} (${a.externalId})`, dayRowsDeleted: spend._count, spendRemoved: major(spend._sum.costMinor ?? 0) };
}

// ---------------------------------------------------------------------------

const clientProp = { type: "string", description: "Client name (exact or partial) or id." };
const accountProp = { type: "string", description: "Platform account id, e.g. 123-456-7890 (Google) or act_123 / 123 (Meta)." };
const platformProp = { type: "string", enum: [...PLATFORMS], description: "GOOGLE_ADS, GOOGLE_LSA, META_ADS or MICROSOFT_ADS." };
const confirmProp = { type: "boolean", description: "Must be true. Without it the tool explains what it would do and changes nothing." };

export const MCP_LOOKUP_TOOLS: McpTool[] = [
  {
    name: "list_budgets",
    title: "List budgets",
    description: "A client's Marketing Nexus budgets for a month (client, account and campaign level) with their ids, amounts, revision history and whether they repeat monthly. Use before set_budget or delete_budget.",
    inputSchema: { type: "object", properties: { client: clientProp, month: { type: "string", description: 'Optional "YYYY-MM". Default: the current month.' } }, required: ["client"], additionalProperties: false },
    annotations: { ...READ_ONLY, openWorldHint: false },
    handler: listBudgets,
  },
  {
    name: "list_linkable_accounts",
    title: "List linkable ad accounts",
    description: "Ad accounts each saved platform login in Marketing Nexus can reach, so you can link one to a client with link_ad_account. Calls the ad platform (read only).",
    inputSchema: { type: "object", properties: { platform: platformProp, search: { type: "string", description: "Optional: filter by account name or id." } }, required: ["platform"], additionalProperties: false },
    annotations: READ_ONLY,
    handler: listLinkableAccounts,
  },
];

export const MCP_WRITE_TOOLS: McpTool[] = [
  {
    name: "set_budget",
    title: "Set a budget",
    description:
      "Create or change a monthly pacing budget in Marketing Nexus (never changes the ad platform). Levels: client (all platforms combined), account (one ad account) or campaign. If a budget for the same target already covers the month, a revision is added from effective_date (default today, or the period start for a future month); otherwise a whole-month budget is created. Repeats monthly by default.",
    inputSchema: {
      type: "object",
      properties: {
        client: clientProp,
        level: { type: "string", enum: ["client", "account", "campaign"] },
        amount: { type: "number", description: "Monthly amount in the client's currency, e.g. 1000." },
        account_id: { ...accountProp, description: "Required for level account. Optional for campaign, to pick the account when the campaign id is ambiguous." },
        platform: { ...platformProp, description: "Optional: needed when the same account id is linked as Google Ads and LSA." },
        campaign_id: { type: "string", description: "Required for level campaign: the platform campaign id (externalId from get_campaigns)." },
        month: { type: "string", description: 'Optional "YYYY-MM". Default: the current month.' },
        effective_date: { type: "string", description: 'Optional "YYYY-MM-DD" for a mid-month change to an existing budget.' },
        repeats_monthly: { type: "boolean", description: "Carry the budget forward every month. Default true for new budgets." },
        note: { type: "string", description: "Optional note stored with the change." },
      },
      required: ["client", "level", "amount"],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: setBudget,
  },
  {
    name: "delete_budget",
    title: "Delete a budget",
    description: "Delete one Marketing Nexus budget (by budgetId from list_budgets) and stop the previous month's matching budget from re-creating it. Requires confirm: true.",
    inputSchema: { type: "object", properties: { client: clientProp, budget_id: { type: "string" }, confirm: confirmProp }, required: ["client", "budget_id"], additionalProperties: false },
    annotations: DESTRUCTIVE,
    handler: deleteBudget,
  },
  {
    name: "set_campaign_included",
    title: "Include or leave out a campaign",
    description: "Choose whether a campaign counts in a client's reports, pacing and alerts (Settings > Campaigns included). Leaving one out never changes the ad platform and its data keeps syncing. A campaign with its own budget can't be left out until that budget is deleted.",
    inputSchema: {
      type: "object",
      properties: { client: clientProp, campaign_id: { type: "string", description: "Platform campaign id." }, account_id: { ...accountProp, description: "Optional: the account, if the campaign id is ambiguous." }, included: { type: "boolean" } },
      required: ["client", "campaign_id", "included"],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: setCampaignIncludedTool,
  },
  {
    name: "set_include_new_campaigns",
    title: "Auto-add new campaigns",
    description: "Whether campaigns that first appear in one of a client's ad accounts start out included (true) or left out (false) of the client's reports.",
    inputSchema: { type: "object", properties: { client: clientProp, account_id: accountProp, platform: platformProp, value: { type: "boolean" } }, required: ["client", "account_id", "value"], additionalProperties: false },
    annotations: WRITE,
    handler: setIncludeNewCampaignsTool,
  },
  {
    name: "link_ad_account",
    title: "Link an ad account to a client",
    description:
      "Link an ad account to a client using a platform login already saved in Marketing Nexus (see list_linkable_accounts), then import its history in the background. A client has one account per platform: if it already tracks a different one on that platform, pass replace: true to swap (the old one stops syncing, its history stays). Use platform GOOGLE_LSA for Local Services.",
    inputSchema: {
      type: "object",
      properties: { client: clientProp, platform: platformProp, account_id: accountProp, connection_id: { type: "string", description: "Optional: which saved login to use (from list_linkable_accounts). Default: the first that can reach the account." }, replace: { type: "boolean" } },
      required: ["client", "platform", "account_id"],
      additionalProperties: false,
    },
    annotations: { ...WRITE, openWorldHint: true },
    handler: linkAdAccount,
  },
  {
    name: "stop_tracking_ad_account",
    title: "Stop tracking an ad account",
    description: "Stop syncing one of a client's ad accounts (the app's \"Stop tracking\"). Its history stays and still counts in past months. Requires confirm: true.",
    inputSchema: { type: "object", properties: { client: clientProp, account_id: accountProp, platform: platformProp, confirm: confirmProp }, required: ["client", "account_id"], additionalProperties: false },
    annotations: DESTRUCTIVE,
    handler: stopTrackingAdAccount,
  },
  {
    name: "remove_ad_account",
    title: "Remove a disconnected ad account",
    description: "Permanently remove an ad account that is no longer tracked (DISCONNECTED) from a client, with its stored history. Refuses accounts still syncing or with their own budgets. Requires confirm: true; without it, reports how much stored history would be deleted.",
    inputSchema: { type: "object", properties: { client: clientProp, account_id: accountProp, platform: platformProp, confirm: confirmProp }, required: ["client", "account_id"], additionalProperties: false },
    annotations: DESTRUCTIVE,
    handler: removeAdAccount,
  },
];
