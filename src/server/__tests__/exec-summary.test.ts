// Executive summary caching and fallback, with a fake Anthropic API.
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { setAiClientForTests } from "../ai/assistant";
import { loadClientReport } from "../client-report";
import { clientFacingSummary, getExecutiveSummary, setSummaryApproval } from "../exec-summary";
import { saveTemplate } from "../report-templates";
import { DEFAULT_TEMPLATE } from "@/lib/report-template";
import { addDays, eachDay, isoToDate, todayInTimeZone } from "@/lib/pacing/dates";

const hasDb = !!process.env.DATABASE_URL;
const prisma = new PrismaClient();
const SLUG = "exec-summary-test";
let clientId = "";
let agencyId = "";
let calls = 0;
let fail = false;
const AI_REPLY = { takeaway: "AI wrote this.", happened: "Leads rose.", meaning: "Search works.", recommendations: ["1. Move budget to Search.", "2. b", "3. c", "4. d"], nextSteps: ["- We'll move budget to Search."] };

describe.skipIf(!hasDb)("executive summary (database)", () => {
  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY ??= "test-key";
    setAiClientForTests(
      new Anthropic({
        apiKey: "test-key",
        maxRetries: 0,
        fetch: async () => {
          calls++;
          if (fail) return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "down" } }), { status: 500 });
          const msg = { id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(AI_REPLY) }] };
          return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } });
        },
      }),
    );
    await prisma.agency.deleteMany({ where: { slug: SLUG } });
    agencyId = (await prisma.agency.create({ data: { name: "Exec", slug: SLUG } })).id;
    clientId = (await prisma.client.create({ data: { agencyId, name: "Exec Client", timezone: "UTC" } })).id;
    const acct = await prisma.adAccount.create({ data: { clientId, platform: "GOOGLE_ADS", externalId: "1", name: "A", currency: "USD", isDemo: true } });
    const today = todayInTimeZone("UTC");
    await prisma.dailyPerformance.createMany({ data: eachDay(addDays(today, -60), addDays(today, -1)).map((d) => ({ accountId: acct.id, date: isoToDate(d), currency: "USD", costMinor: 10000n, impressions: 100n, clicks: 5n, conversions: 1, conversionValueMinor: 0n, isDemo: true })) });
  });
  afterAll(async () => {
    setAiClientForTests(null);
    await prisma.agency.deleteMany({ where: { slug: SLUG } });
    await prisma.$disconnect();
  });

  it("writes once per range, then serves the cached text", async () => {
    calls = 0;
    const rep = await loadClientReport(clientId, { range: "last_7", compare: "previous_period" });
    expect(await getExecutiveSummary(rep, { generate: false })).toMatchObject({ source: "auto" });
    expect(calls).toBe(0);
    const [a, b] = await Promise.all([getExecutiveSummary(rep, { generate: true }), getExecutiveSummary(rep, { generate: true })]);
    // List markers the model adds are stripped.
    // List markers the model adds are stripped, and there are never more than three steps.
    expect(a).toEqual({ takeaway: "AI wrote this.", happened: "Leads rose.", meaning: "Search works.", recommendations: ["Move budget to Search.", "b", "c"], nextSteps: ["We'll move budget to Search."], source: "ai" });
    expect(b.takeaway).toBe("AI wrote this.");
    expect(calls).toBe(1); // concurrent viewers share one request
    expect(await getExecutiveSummary(rep, { generate: true })).toMatchObject({ ...a, approved: false }); // served from the cache
    expect(calls).toBe(1);
    // A different comparison is a different summary.
    await getExecutiveSummary(await loadClientReport(clientId, { range: "last_7", compare: "none" }), { generate: true });
    expect(calls).toBe(2);
    // Older than a day: written again.
    const later = new Date(Date.now() + 25 * 3600_000);
    await getExecutiveSummary(rep, { generate: true, now: later });
    expect(calls).toBe(3);
  });
  it("shows clients AI-written text only after the agency approves it", async () => {
    const rep = await loadClientReport(clientId, { range: "last_month", compare: "previous_period" });
    const agency = await getExecutiveSummary(rep, { generate: true });
    expect(agency.source).toBe("ai");
    // Not approved yet: clients get the summary built from the figures, and no AI call is made for them.
    const before = calls;
    expect(await clientFacingSummary(rep)).toMatchObject({ source: "auto" });
    expect(calls).toBe(before);
    const saved = await getExecutiveSummary(rep, { generate: false });
    expect(saved).toMatchObject({ source: "ai", approved: false });
    const user = await prisma.user.create({ data: { agencyId, email: `approver-${Date.now()}@example.test`, name: "Approver", role: "AGENCY_ADMIN", passwordHash: "x" } });
    expect(await setSummaryApproval(clientId, saved.insightId!, user.id, true)).toBe(true);
    expect(await clientFacingSummary(rep)).toMatchObject({ source: "ai", takeaway: "AI wrote this." });
    // Still approved after the day-long cache has expired (a past month keeps its approved wording).
    expect(await getExecutiveSummary(rep, { generate: false })).toMatchObject({ approved: true });
    // Withdrawn: back to the automatic summary.
    await setSummaryApproval(clientId, saved.insightId!, user.id, false);
    expect(await clientFacingSummary(rep)).toMatchObject({ source: "auto" });
    // Another client's id can't be approved through this client.
    expect(await setSummaryApproval("someone-else", saved.insightId!, user.id, true)).toBe(false);
  });

  it("falls back to the automatic summary when the AI fails or the layout says so", async () => {
    fail = true;
    const rep = await loadClientReport(clientId, { range: "last_30" });
    const s = await getExecutiveSummary(rep, { generate: true });
    expect(s.source).toBe("auto");
    expect(s.happened).toContain("Exec Client's ads were shown");
    expect(s.recommendations.length).toBeGreaterThan(0);
    fail = false;
    await saveTemplate(agencyId, clientId, { ...DEFAULT_TEMPLATE, executiveAi: false });
    calls = 0;
    const manual = await getExecutiveSummary(await loadClientReport(clientId, { range: "last_90" }), { generate: true });
    expect(manual.source).toBe("auto");
    expect(calls).toBe(0);
  });
});
