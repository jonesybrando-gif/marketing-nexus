import "server-only";
import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import type { ClientReport } from "./client-report";
import { aiContextForReport, contextInput } from "./ai/context";
import { AI_MODEL, aiConfigured, draftExecutiveSummary } from "./ai/assistant";
import { autoExecutiveSummary, fromLegacySummary, MAX_STEPS, type ExecutiveSummaryContent } from "@/lib/exec-summary";
import { diffDays } from "@/lib/pacing/dates";

// The executive summary at the top of a report, for whatever date range is
// being viewed. AI-written when the layout asks for it and a key is set,
// cached per range for a day (data can still be restated by the platforms);
// otherwise, or if the AI call fails, built directly from the figures.

const KIND = "exec_summary";
const TTL_MS = 24 * 3600_000;
export type ExecSummary = ExecutiveSummaryContent & { source: "ai" | "auto" };
/** Bumped when the stored shape changes, so older cached summaries are rewritten. 4 = the three questions. */
const VERSION = 4;
/** The previous format (overview, what's working…): still shown to clients when it was approved. */
const LEGACY_VERSION = 3;

/**
 * Comparison period, plus the account filter when the report is limited to
 * some ad accounts, so a filtered view never reuses the all-accounts summary
 * (and existing all-accounts summaries keep their key and approval).
 */
const compareKey = (rep: ClientReport) =>
  (rep.cmpRange ? `${rep.cmpRange.from}..${rep.cmpRange.to}` : "none") + (rep.accountScope?.ids ? `|accounts:${[...rep.accountScope.ids].sort().join(",")}` : "");

export function automaticSummary(rep: ClientReport): ExecSummary {
  return { ...autoExecutiveSummary(contextInput(rep)), source: "auto" };
}

export const wantsAiSummary = (rep: ClientReport) => rep.template.executiveAi && aiConfigured();

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

type StoredContent = { v?: unknown; compare?: unknown; approvedAt?: unknown; summary?: Record<string, unknown> };

/** A saved summary in the current format; with `legacy`, also an earlier-format one, read as the three questions. */
function parseStored(c: StoredContent, rep: ClientReport, opts: { legacy?: boolean } = {}): ExecutiveSummaryContent | null {
  const s = c.summary;
  if (c.compare !== compareKey(rep) || !s) return null;
  const steps = (v: unknown) => (strings(v) ? v.slice(0, MAX_STEPS) : []);
  if (c.v === VERSION && typeof s.takeaway === "string" && typeof s.happened === "string" && typeof s.meaning === "string") {
    return { takeaway: s.takeaway, happened: s.happened, meaning: s.meaning, recommendations: steps(s.recommendations), nextSteps: steps(s.nextSteps) };
  }
  if (opts.legacy && c.v === LEGACY_VERSION && typeof s.overview === "string" && strings(s.working) && strings(s.notWorking) && strings(s.recommendations)) {
    return fromLegacySummary({ overview: s.overview, working: s.working, notWorking: s.notWorking, recommendations: s.recommendations, nextSteps: strings(s.nextSteps) ? s.nextSteps : [] });
  }
  return null;
}

/** The latest saved AI summary for this range (kept a day), with its id and whether it's approved for clients. */
async function cached(rep: ClientReport, now: Date): Promise<{ id: string; approved: boolean; content: ExecutiveSummaryContent } | null> {
  const rows = await prisma.aiInsight.findMany({
    where: { clientId: rep.client.id, kind: KIND, rangeFrom: rep.range.from, rangeTo: rep.range.to, createdAt: { gt: new Date(now.getTime() - TTL_MS) } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  for (const r of rows) {
    const c = r.content as StoredContent;
    const content = parseStored(c, rep);
    if (content) return { id: r.id, approved: typeof c.approvedAt === "string", content };
  }
  return null;
}

/**
 * The summary clients read (client logins, shared links, client PDFs and
 * scheduled emails). AI-written text reaches a client only after someone at
 * the agency approved it; otherwise it's the automatic summary built directly
 * from the figures. Approved summaries don't expire, so a report for a past
 * month keeps the wording that was approved. Never calls the AI.
 */
export async function clientFacingSummary(rep: ClientReport): Promise<ExecSummary> {
  if (!rep.template.executiveAi) return automaticSummary(rep);
  try {
    const rows = await prisma.aiInsight.findMany({
      where: { clientId: rep.client.id, kind: KIND, rangeFrom: rep.range.from, rangeTo: rep.range.to },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    for (const r of rows) {
      const c = r.content as StoredContent;
      if (typeof c.approvedAt !== "string") continue;
      // An approved summary in the earlier format keeps reaching clients until a new one is approved.
      const content = parseStored(c, rep, { legacy: true });
      if (content) return { ...content, source: "ai" };
    }
  } catch (e) {
    console.error("Executive summary: approved summary lookup failed, using the automatic version", e);
  }
  return automaticSummary(rep);
}

/** Approves (or withdraws approval of) one saved AI summary for client-facing reports. */
export async function setSummaryApproval(clientId: string, insightId: string, userId: string, approve: boolean): Promise<boolean> {
  const row = await prisma.aiInsight.findFirst({ where: { id: insightId, clientId, kind: KIND }, select: { content: true } });
  if (!row) return false;
  const c = { ...(row.content as Record<string, unknown>) };
  if (approve) {
    c.approvedAt = new Date().toISOString();
    c.approvedById = userId;
  } else {
    delete c.approvedAt;
    delete c.approvedById;
  }
  await prisma.aiInsight.update({ where: { id: insightId }, data: { content: c as Prisma.InputJsonValue } });
  return true;
}

// Kept on globalThis: Next bundles pages and API routes separately, and the
// status endpoint must see the same state as the pages that start the work.
const shared = ((globalThis as unknown as { __mnExecSummary?: { inFlight: Map<string, Promise<ExecutiveSummaryContent>>; failedAt: Map<string, number>; queued: Map<string, number> } }).__mnExecSummary ??= {
  inFlight: new Map(),
  failedAt: new Map(),
  queued: new Map(),
});
// Concurrent viewers of the same range share one request.
const inFlight = shared.inFlight;
// After a failed AI call, don't try the same range again for a while (pages would otherwise retry on every view).
const failedAt = shared.failedAt;
const RETRY_AFTER_MS = 10 * 60_000;
const MAX_BACKGROUND = 3;
// Asked for by a page, starting once that page has been sent.
const queued = shared.queued;
const isQueued = (key: string) => {
  const t = queued.get(key);
  return t !== undefined && Date.now() - t < 2 * 60_000;
};

/** Identifies one summary: client, range and comparison. */
export const summaryKey = (rep: ClientReport) => `${rep.client.id}|${rep.range.from}|${rep.range.to}|${compareKey(rep)}`;

function startGeneration(rep: ClientReport, key: string): Promise<ExecutiveSummaryContent> {
  let p = inFlight.get(key);
  if (!p) {
    p = (async () => {
      const agency = await prisma.agency.findUniqueOrThrow({ where: { id: rep.client.agencyId }, select: { name: true } });
      const summary = await draftExecutiveSummary(await aiContextForReport(rep), { agencyName: agency.name, days: diffDays(rep.range.from, rep.range.to) + 1 });
      await prisma.aiInsight.create({ data: { clientId: rep.client.id, kind: KIND, content: { v: VERSION, summary: { ...summary }, compare: compareKey(rep) }, model: AI_MODEL, rangeFrom: rep.range.from, rangeTo: rep.range.to } });
      failedAt.delete(key);
      return summary;
    })()
      .catch((e) => {
        failedAt.set(key, Date.now());
        throw e;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

/**
 * Writes a fresh AI summary for this range now (the "Regenerate" button). The
 * newest one is shown from then on; an earlier approved summary keeps
 * reaching clients until the new one is approved. Returns false when AI
 * summaries are off for this client or the AI isn't available.
 */
export async function regenerateExecutiveSummary(rep: ClientReport): Promise<boolean> {
  if (!wantsAiSummary(rep)) return false;
  const key = summaryKey(rep);
  failedAt.delete(key);
  try {
    await startGeneration(rep, key);
    return true;
  } catch (e) {
    console.error("Executive summary: regenerate failed", e);
    return false;
  }
}

/** True while an AI summary for this key is being written. */
export const summaryPending = (key: string) => isQueued(key) || inFlight.has(key);

/**
 * The summary to show.
 *  - `generate: false`: never calls the AI (falls back to automatic).
 *  - `generate: true`: waits for the AI (PDFs and emails, which must contain it).
 *  - `generate: "background"`: for pages. Returns the saved AI summary, or the
 *    automatic one at once with `pending: true` while the AI version is written
 *    in the background, so a page never waits on the AI.
 */
export async function getExecutiveSummary(rep: ClientReport, opts: { generate: boolean | "background"; now?: Date }): Promise<ExecSummary & { pending?: boolean; insightId?: string; approved?: boolean }> {
  if (!wantsAiSummary(rep)) return automaticSummary(rep);
  const now = opts.now ?? new Date();
  const key = summaryKey(rep);
  try {
    const hit = await cached(rep, now);
    if (hit) return { ...hit.content, source: "ai", insightId: hit.id, approved: hit.approved };
    if (!opts.generate) return automaticSummary(rep);
    if (opts.generate === "background") {
      const failed = failedAt.get(key);
      if (failed && Date.now() - failed < RETRY_AFTER_MS) return automaticSummary(rep);
      // Start once the page has been sent, so the AI's database work never slows the page itself.
      const run = () => {
        queued.delete(key);
        return startGeneration(rep, key).catch((e) => console.error("Executive summary: AI unavailable, using the automatic version", e));
      };
      // At most a few written at once, so skimming many clients can't set off a burst of AI calls.
      const busy = inFlight.size + [...queued.keys()].filter(isQueued).length;
      if (!inFlight.has(key) && !isQueued(key) && busy >= MAX_BACKGROUND) return automaticSummary(rep);
      if (!inFlight.has(key) && !isQueued(key)) {
        queued.set(key, Date.now());
        try {
          after(run);
        } catch {
          void run(); // Outside a request (no after()): start now.
        }
      }
      return { ...automaticSummary(rep), pending: true };
    }
    return { ...(await startGeneration(rep, key)), source: "ai" };
  } catch (e) {
    console.error("Executive summary: AI unavailable, using the automatic version", e);
    return automaticSummary(rep);
  }
}
