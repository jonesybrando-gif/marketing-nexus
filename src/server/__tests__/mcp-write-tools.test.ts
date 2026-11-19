// MCP connector write tools: argument parsing, the read-only switch, and (with a
// database) budgets, campaign selection and account removal end to end.
import "dotenv/config";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { handleMcpMessage } from "../mcp/protocol";
import { connectorInstructions, connectorTools } from "../mcp";
import { MCP_WRITE_TOOLS, normalizeExternalId, parseAmountToMinor, parsePlatform, writesEnabled } from "../mcp/write-tools";

describe("MCP write tools: arguments", () => {
  it("normalizes platform account and campaign ids", () => {
    expect(normalizeExternalId("129-418-4188")).toBe("1294184188");
    expect(normalizeExternalId("act_211254013573249")).toBe("211254013573249");
    expect(normalizeExternalId(23494454599, "campaign_id")).toBe("23494454599");
    expect(() => normalizeExternalId("abc")).toThrow(/numeric id/);
    expect(() => normalizeExternalId(undefined)).toThrow(/required/);
  });

  it("accepts platform names and common aliases", () => {
    expect(parsePlatform("google_ads")).toBe("GOOGLE_ADS");
    expect(parsePlatform("lsa")).toBe("GOOGLE_LSA");
    expect(parsePlatform("Meta")).toBe("META_ADS");
    expect(parsePlatform(undefined)).toBeUndefined();
    expect(() => parsePlatform(undefined, true)).toThrow(/required/);
    expect(() => parsePlatform("tiktok")).toThrow(/one of/);
  });

  it("turns dollar amounts into cents", () => {
    expect(parseAmountToMinor(1000)).toBe(100000);
    expect(parseAmountToMinor("$1,250.50")).toBe(125050);
    expect(parseAmountToMinor(0)).toBe(0);
    expect(() => parseAmountToMinor(-5)).toThrow(/non-negative/);
    expect(() => parseAmountToMinor("lots")).toThrow(/non-negative/);
  });
});

describe("MCP write tools: read-only switch", () => {
  const prev = process.env.MCP_READ_ONLY;
  afterEach(() => {
    if (prev === undefined) delete process.env.MCP_READ_ONLY;
    else process.env.MCP_READ_ONLY = prev;
  });

  it("offers write tools by default and says they never touch the ad platforms", () => {
    delete process.env.MCP_READ_ONLY;
    expect(writesEnabled()).toBe(true);
    const names = connectorTools().map((t) => t.name);
    for (const t of MCP_WRITE_TOOLS) expect(names).toContain(t.name);
    expect(names).toEqual(expect.arrayContaining(["list_clients", "get_budget_pacing", "get_campaigns", "list_budgets", "list_linkable_accounts"]));
    expect(connectorInstructions()).toMatch(/never change budgets, campaigns or settings inside Google, Meta or Microsoft/);
  });

  it("hides every write tool when MCP_READ_ONLY is true", async () => {
    process.env.MCP_READ_ONLY = "true";
    expect(writesEnabled()).toBe(false);
    const tools = connectorTools();
    for (const t of MCP_WRITE_TOOLS) expect(tools.map((x) => x.name)).not.toContain(t.name);
    expect(connectorInstructions()).toMatch(/read-only/);
    const r = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_budget", arguments: {} } }, tools)) as { error: { code: number } };
    expect(r.error.code).toBe(-32602);
  });

  it("marks destructive tools and requires confirm in their schemas", () => {
    for (const name of ["delete_budget", "stop_tracking_ad_account", "remove_ad_account"]) {
      const t = MCP_WRITE_TOOLS.find((x) => x.name === name)!;
      expect(t.annotations?.destructiveHint).toBe(true);
      expect((t.inputSchema.properties as Record<string, unknown>).confirm).toBeDefined();
    }
    for (const t of MCP_WRITE_TOOLS) expect(t.annotations?.readOnlyHint).toBe(false);
  });
});

const hasDb = !!process.env.DATABASE_URL;
const SLUG = "mcp-write-tools-test";

describe.skipIf(!hasDb)("MCP write tools (database)", () => {
  const prisma = new PrismaClient();
  const prevSlug = process.env.MCP_AGENCY_SLUG;
  let clientId = "";
  let accountId = "";
  let oldAccountId = "";
  let campaignId = "";

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, connectorTools())) as {
      result: { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> };
    };
    return r.result;
  };

  beforeAll(async () => {
    process.env.MCP_AGENCY_SLUG = SLUG;
    delete process.env.MCP_READ_ONLY;
    await prisma.agency.deleteMany({ where: { slug: SLUG } });
    const agencyId = (await prisma.agency.create({ data: { name: "MCP writes", slug: SLUG } })).id;
    clientId = (await prisma.client.create({ data: { agencyId, name: "Writes Client", timezone: "UTC" } })).id;
    accountId = (await prisma.adAccount.create({ data: { clientId, platform: "GOOGLE_ADS", externalId: "1294184188", name: "Shared Ads", currency: "USD" } })).id;
    oldAccountId = (await prisma.adAccount.create({ data: { clientId, platform: "GOOGLE_ADS", externalId: "7015530446", name: "Old Ads", currency: "USD", status: "DISCONNECTED" } })).id;
    campaignId = (await prisma.campaign.create({ data: { accountId, externalId: "23494454599", name: "RHM" } })).id;
    await prisma.campaign.create({ data: { accountId, externalId: "17507992999", name: "Other practice" } });
  });
  afterAll(async () => {
    await prisma.agency.deleteMany({ where: { slug: SLUG } });
    await prisma.$disconnect();
    if (prevSlug === undefined) delete process.env.MCP_AGENCY_SLUG;
    else process.env.MCP_AGENCY_SLUG = prevSlug;
  });

  it("creates a client with labels and refuses a duplicate name", async () => {
    const created = await call("create_client", { name: "  New  Brand ", timezone: "America/New_York", labels: ["Everest"] });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ action: "created", client: "New Brand", timezone: "America/New_York", labels: ["Everest"] });
    const row = await prisma.client.findFirstOrThrow({ where: { id: created.structuredContent.clientId as string }, include: { labels: true } });
    expect(row.labels.map((l) => l.name)).toEqual(["Everest"]);
    const dup = await call("create_client", { name: "new brand" });
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toMatch(/already exists/);
    const badTz = await call("create_client", { name: "Bad TZ", timezone: "Mars/Olympus" });
    expect(badTz.isError).toBe(true);
  });

  it("creates a campaign budget, then revises it instead of adding a second one", async () => {
    const created = await call("set_budget", { client: "Writes Client", level: "campaign", campaign_id: "23494454599", amount: 1000, month: "2026-11" });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ action: "created", amount: 1000, period: { start: "2026-11-01", end: "2026-11-30" }, repeatsMonthly: true });

    const revised = await call("set_budget", { client: "Writes Client", level: "campaign", campaign_id: "23494454599", amount: 1200, month: "2026-11", effective_date: "2026-11-16" });
    expect(revised.structuredContent).toMatchObject({ action: "revised", previousAmount: 1000, newAmount: 1200, effectiveDate: "2026-11-16" });
    expect(await prisma.budget.count({ where: { campaignId } })).toBe(1);

    const listed = await call("list_budgets", { client: "Writes Client", month: "2026-11" });
    const budgets = listed.structuredContent.budgets as { currentAmount: number; campaign: { campaignId: string } }[];
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({ currentAmount: 1200, campaign: { campaignId: "23494454599" } });
  });

  it("won't leave out a campaign that has its own budget, but can leave out others", async () => {
    const blocked = await call("set_campaign_included", { client: "Writes Client", campaign_id: "23494454599", included: false });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toMatch(/own budget/);
    const ok = await call("set_campaign_included", { client: "Writes Client", campaign_id: "17507992999", included: false });
    expect(ok.structuredContent).toMatchObject({ campaign: "Other practice", included: false });
  });

  it("needs confirm before deleting, then deletes", async () => {
    const b = await prisma.budget.findFirstOrThrow({ where: { campaignId } });
    const noConfirm = await call("delete_budget", { client: "Writes Client", budget_id: b.id });
    expect(noConfirm.isError).toBe(true);
    expect(await prisma.budget.count({ where: { id: b.id } })).toBe(1);
    const done = await call("delete_budget", { client: "Writes Client", budget_id: b.id, confirm: true });
    expect(done.structuredContent).toMatchObject({ action: "deleted" });
    expect(await prisma.budget.count({ where: { id: b.id } })).toBe(0);
  });

  it("removes only accounts that are no longer tracked", async () => {
    const live = await call("remove_ad_account", { client: "Writes Client", account_id: "129-418-4188", confirm: true });
    expect(live.isError).toBe(true);
    expect(live.content[0].text).toMatch(/still being tracked/);
    const ask = await call("remove_ad_account", { client: "Writes Client", account_id: "701-553-0446" });
    expect(ask.isError).toBe(true);
    expect(ask.content[0].text).toMatch(/confirm: true/);
    const gone = await call("remove_ad_account", { client: "Writes Client", account_id: "701-553-0446", confirm: true });
    expect(gone.isError).toBeFalsy();
    expect(await prisma.adAccount.count({ where: { id: oldAccountId } })).toBe(0);
  });
});
