// Integration test: runs the sync runner against the real database with a fake
// platform adapter. Skipped when DATABASE_URL is not set.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { chunkRange, syncAccount, syncRange } from "../sync-account";
import { IntegrationError } from "../../integrations/errors";
import type { PlatformAdapter, RemoteDailyRow } from "../../integrations/types";
import { createGoogleAdsAdapter } from "../../integrations/google-ads/adapter";

const hasDb = !!process.env.DATABASE_URL;
const prisma = new PrismaClient();
const SLUG = "sync-runner-test";
const NOW = new Date("2026-10-17T15:00:00Z"); // 11:00 in New York

function fakeAdapter(rowsFor: (from: string, to: string) => RemoteDailyRow[], overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    platform: "GOOGLE_ADS",
    connectionPlatform: "GOOGLE_ADS",
    linkablePlatforms: ["GOOGLE_ADS"],
    isConfigured: () => true,
    authorizationUrl: () => "",
    exchangeCode: async () => ({ accessToken: "x" }),
    refresh: async () => ({ accessToken: "x" }),
    listAccounts: async () => [],
    listCampaigns: async () => [{ externalId: "c1", name: "Search", status: "ENABLED", budgetKind: "DAILY", dailyBudgetMinor: 20000 }],
    fetchDailyPerformance: async (_t, _a, from, to) => ({
      rows: rowsFor(from, to),
      campaigns: [{ externalId: "c1", name: "Search", status: "ENABLED" }, { externalId: "old", name: "Removed campaign", status: "REMOVED" }],
    }),
    dataCompleteThrough: () => "2026-10-16",
    restatementWindowDays: 3,
    initialBackfillDays: 10,
    spendIsVerified: true,
    ...overrides,
  };
}

const row = (date: string, costMinor: number, campaign = "c1"): RemoteDailyRow => ({ campaignExternalId: campaign, date, costMinor, costIsEstimated: false, impressions: 100, clicks: 10, conversions: 1, conversionValueMinor: 5000 });
const deps = (adapter: PlatformAdapter) => ({ adapter, withToken: <T,>(fn: (t: string) => Promise<T>) => fn("token"), retry: { sleep: async () => {} }, now: NOW });

let accountId = "";
let connectionId = "";

async function setup() {
  await prisma.agency.deleteMany({ where: { slug: SLUG } });
  const agency = await prisma.agency.create({ data: { name: "Sync test", slug: SLUG } });
  const client = await prisma.client.create({ data: { agencyId: agency.id, name: "Sync client", timezone: "America/New_York" } });
  const conn = await prisma.platformConnection.create({ data: { agencyId: agency.id, platform: "GOOGLE_ADS", label: "test" } });
  const acct = await prisma.adAccount.create({ data: { clientId: client.id, connectionId: conn.id, platform: "GOOGLE_ADS", externalId: "9999999999", name: "Live acct", currency: "USD", timezone: "America/New_York" } });
  accountId = acct.id;
  connectionId = conn.id;
}

const spendByDate = async () =>
  Object.fromEntries(
    (await prisma.dailyPerformance.findMany({ where: { accountId }, orderBy: { date: "asc" }, include: { campaign: true } })).map((r) => [
      `${r.date.toISOString().slice(0, 10)}:${r.campaign?.externalId}`,
      Number(r.costMinor),
    ]),
  );

describe("sync helpers", () => {
  it("chunks long ranges", () => {
    expect(chunkRange("2026-01-01", "2026-01-10", 4)).toEqual([
      { from: "2026-01-01", to: "2026-01-04" },
      { from: "2026-01-05", to: "2026-01-08" },
      { from: "2026-01-09", to: "2026-01-10" },
    ]);
  });

  it("picks backfill vs incremental windows", () => {
    const a = fakeAdapter(() => []);
    expect(syncRange(a, "2026-10-17", "scheduled", null)).toEqual({ from: "2026-10-07", to: "2026-10-17" });
    expect(syncRange(a, "2026-10-17", "scheduled", "2026-10-16")).toEqual({ from: "2026-10-13", to: "2026-10-17" });
    expect(syncRange(a, "2026-10-17", "backfill", "2026-10-16")).toEqual({ from: "2026-10-07", to: "2026-10-17" });
    // Once a day the window reaches back far enough for late-credited conversions.
    expect(syncRange(a, "2026-10-17", "scheduled", "2026-10-16", true)).toEqual({ from: "2026-09-11", to: "2026-10-17" });
  });
});

describe.skipIf(!hasDb)("syncAccount (database)", () => {
  beforeEach(setup);
  afterAll(async () => {
    await prisma.agency.deleteMany({ where: { slug: SLUG } });
    await prisma.$disconnect();
  });

  it("imports history, then replaces the restatement window", async () => {
    const first = await syncAccount(accountId, "scheduled", deps(fakeAdapter((from, to) => [row(from, 1000), row(to, 2000), row("2026-10-12", 500, "old")])));
    expect(first.status).toBe("SUCCEEDED");
    expect(first.range).toEqual({ from: "2026-10-07", to: "2026-10-17" });
    let spend = await spendByDate();
    expect(spend).toEqual({ "2026-10-07:c1": 1000, "2026-10-12:old": 500, "2026-10-17:c1": 2000 });

    const acct = await prisma.adAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acct.dataCompleteThrough?.toISOString().slice(0, 10)).toBe("2026-10-16");
    expect(acct.lastSuccessfulSyncAt?.toISOString()).toBe(NOW.toISOString());
    const campaigns = await prisma.campaign.findMany({ where: { accountId }, orderBy: { externalId: "asc" } });
    expect(campaigns.map((c) => [c.externalId, c.status])).toEqual([["c1", "ENABLED"], ["old", "REMOVED"]]);
    expect(Number(campaigns[0].platformDailyBudgetMinor)).toBe(20000);

    // Incremental run: window is 2026-10-13..17. Restated value for 10-17, and
    // the 10-12 row (outside the window) must be kept.
    const second = await syncAccount(accountId, "manual", deps(fakeAdapter(() => [row("2026-10-14", 700), row("2026-10-17", 2500)])));
    expect(second.range).toEqual({ from: "2026-10-13", to: "2026-10-17" });
    spend = await spendByDate();
    expect(spend).toEqual({ "2026-10-07:c1": 1000, "2026-10-12:old": 500, "2026-10-14:c1": 700, "2026-10-17:c1": 2500 });

    const runs = await prisma.syncRun.findMany({ where: { accountId }, orderBy: { startedAt: "asc" } });
    expect(runs.map((r) => r.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  });

  it("keeps past days with spend when the platform returns nothing for them, but clears recent ones", async () => {
    // Today is 2026-10-17 in New York. History: spend every day 10-07..10-17.
    await syncAccount(accountId, "scheduled", deps(fakeAdapter((from, to) => {
      const out: RemoteDailyRow[] = [];
      for (let d = from; d <= to; d = new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10)) out.push(row(d, 1000));
      return out;
    })));
    // Incremental window 10-13..10-17, but the platform only returns 10-14.
    const second = await syncAccount(accountId, "manual", deps(fakeAdapter(() => [row("2026-10-14", 700)])));
    expect(second.status).toBe("SUCCEEDED");
    const spend = await spendByDate();
    // 10-13 and 10-15 are settled (2+ days old): kept. 10-16 and 10-17 are recent: cleared. 10-14 restated.
    expect(Object.entries(spend).filter(([k]) => k >= "2026-10-12")).toEqual([
      ["2026-10-12:c1", 1000],
      ["2026-10-13:c1", 1000],
      ["2026-10-14:c1", 700],
      ["2026-10-15:c1", 1000],
    ]);
    const run = await prisma.syncRun.findFirstOrThrow({ where: { accountId, kind: "manual" } });
    expect(run.error).toBe("The platform returned no data for 2 past days with recorded spend (2026-10-13 to 2026-10-15); kept the existing figures.");
  });

  it("starts new campaigns out removed when the account says so, and leaves existing choices alone", async () => {
    await prisma.campaign.create({ data: { accountId, externalId: "c1", name: "Search", excludedAt: new Date("2026-10-01") } });
    await prisma.adAccount.update({ where: { id: accountId }, data: { includeNewCampaigns: false } });
    await syncAccount(accountId, "scheduled", deps(fakeAdapter((from) => [row(from, 100)])));
    const campaigns = await prisma.campaign.findMany({ where: { accountId }, orderBy: { externalId: "asc" } });
    expect(campaigns.map((c) => [c.externalId, !!c.excludedAt])).toEqual([["c1", true], ["old", true]]);
    await prisma.campaign.update({ where: { id: campaigns[0].id }, data: { excludedAt: null } });
    await prisma.adAccount.update({ where: { id: accountId }, data: { includeNewCampaigns: true } });
    await syncAccount(accountId, "manual", deps(fakeAdapter((from) => [row(from, 100)])));
    expect((await prisma.campaign.findFirstOrThrow({ where: { accountId, externalId: "c1" } })).excludedAt).toBeNull();
  });

  it("never syncs demo accounts", async () => {
    await prisma.adAccount.update({ where: { id: accountId }, data: { isDemo: true } });
    const r = await syncAccount(accountId, "manual", deps(fakeAdapter(() => [row("2026-10-16", 1)])));
    expect(r.status).toBe("SKIPPED");
    expect(await prisma.dailyPerformance.count({ where: { accountId } })).toBe(0);
  });

  it("skips while another sync of the account is running", async () => {
    await prisma.syncRun.create({ data: { accountId, kind: "scheduled", status: "RUNNING", startedAt: new Date(NOW.getTime() - 60_000) } });
    const r = await syncAccount(accountId, "manual", deps(fakeAdapter(() => [])));
    expect(r.status).toBe("SKIPPED");
  });

  it("marks the connection for re-authorization when the token is revoked", async () => {
    const adapter = fakeAdapter(() => [], { listCampaigns: async () => { throw new IntegrationError("AUTH_REVOKED", "revoked"); } });
    const r = await syncAccount(accountId, "manual", deps(adapter));
    expect(r.status).toBe("FAILED");
    expect((await prisma.platformConnection.findUniqueOrThrow({ where: { id: connectionId } })).status).toBe("NEEDS_REAUTH");
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe("NEEDS_REAUTH");
    const run = await prisma.syncRun.findFirstOrThrow({ where: { accountId } });
    expect(run.error).toContain("AUTH_REVOKED");
  });

  it("records an unapproved developer token on the connection", async () => {
    const adapter = fakeAdapter(() => [], { listCampaigns: async () => { throw new IntegrationError("NOT_APPROVED", "DEVELOPER_TOKEN_NOT_APPROVED: test accounts only"); } });
    await syncAccount(accountId, "manual", deps(adapter));
    const conn = await prisma.platformConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(conn.status).toBe("PENDING_APPROVAL");
    expect(conn.lastError).toContain("DEVELOPER_TOKEN_NOT_APPROVED");
  });

  it("marks a lost account as disconnected and keeps earlier data", async () => {
    await syncAccount(accountId, "scheduled", deps(fakeAdapter((from) => [row(from, 1000)])));
    const adapter = fakeAdapter(() => [], { fetchDailyPerformance: async () => { throw new IntegrationError("PERMISSION_DENIED", "USER_PERMISSION_DENIED"); } });
    const r = await syncAccount(accountId, "manual", deps(adapter));
    expect(r.status).toBe("FAILED");
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe("DISCONNECTED");
    expect(await prisma.dailyPerformance.count({ where: { accountId } })).toBe(1);
  });

  it("reports PARTIAL when a later chunk fails and does not advance completeness", async () => {
    let calls = 0;
    const adapter = fakeAdapter(() => [], {
      initialBackfillDays: 200,
      fetchDailyPerformance: async (_t, _a, from) => {
        if (++calls > 1) throw new IntegrationError("INVALID_REQUEST", "boom");
        return { rows: [row(from, 100)], campaigns: [] };
      },
    });
    const r = await syncAccount(accountId, "scheduled", deps(adapter));
    expect(r.status).toBe("PARTIAL");
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: accountId } })).dataCompleteThrough).toBeNull();
  });

  it("end to end with the real Google Ads adapter over mocked HTTP", async () => {
    const queries: string[] = [];
    const fetchMock = async (url: string, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body ?? "{}")).query ?? "";
      queries.push(q);
      expect(url).toBe("https://googleads.googleapis.com/v26/customers/9999999999/googleAds:searchStream");
      const body = q.includes("segments.date")
        ? [{ results: [
            { campaign: { id: "77", name: "Search – Brand", status: "ENABLED" }, segments: { date: "2026-10-15" }, metrics: { costMicros: "45670000", impressions: "900", clicks: "60", conversions: 3, conversionsValue: 450.5 } },
            { campaign: { id: "77", name: "Search – Brand", status: "ENABLED" }, segments: { date: "2026-10-16" }, metrics: { costMicros: "12345678" } },
          ] }]
        : [{ results: [{ campaign: { id: "77", name: "Search – Brand", status: "ENABLED" }, campaignBudget: { amountMicros: "50000000" } }] }];
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const adapter = createGoogleAdsAdapter({ config: { clientId: "c", clientSecret: "s", developerToken: "d", apiVersion: "v26" }, fetch: fetchMock });
    const r = await syncAccount(accountId, "manual", { ...deps(adapter), now: NOW });
    expect(r.status).toBe("SUCCEEDED");
    expect(r.range?.from).toBe("2025-09-12"); // first sync imports ~13 months
    expect(queries.filter((q) => q.includes("segments.date"))).toHaveLength(5); // 400 days in 92-day chunks
    const rows = await prisma.dailyPerformance.findMany({ where: { accountId }, orderBy: { date: "asc" } });
    expect(rows.map((x) => [x.date.toISOString().slice(0, 10), Number(x.costMinor), Number(x.clicks), Number(x.conversionValueMinor)])).toEqual([
      ["2026-10-15", 4567, 60, 45050],
      ["2026-10-16", 1235, 0, 0],
    ]);
    // The mock returns the same rows for every chunk; only the chunk that covers them stores them.
    expect(r.rowsUpserted).toBe(2);
  });

  it("stores unverified spend when the adapter reports it", async () => {
    const adapter = fakeAdapter(() => [], { fetchDailyPerformance: async (_t, _a, from) => ({ rows: [{ ...row(from, 0), leads: 2 }], campaigns: [], spendVerified: false }) });
    await syncAccount(accountId, "manual", deps(adapter));
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: accountId } })).spendIsVerified).toBe(false);
  });
});
