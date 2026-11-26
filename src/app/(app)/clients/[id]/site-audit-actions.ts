"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireClientEdit } from "@/server/access";
import { AuditError, normalizeTargetUrl } from "@/server/site-audit/engine";
import { auditEstimate, pollActiveAudits, reanalyzeAudit, startAudit, stopAudit } from "@/server/site-audit/jobs";
import { MAX_PAGES_LIMIT, nextAuditRun } from "@/lib/site-audit/schedule";
import { parseIgnorePatterns } from "@/lib/site-audit/urls";

export type SiteAuditFormState = { ok?: string; errors?: string[]; n?: number } | undefined;

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/** Create or update the client's Site Auditor settings. */
export async function saveSiteAuditConfig(clientId: string, prev: SiteAuditFormState, form: FormData): Promise<SiteAuditFormState> {
  await requireClientEdit(clientId);
  const targetUrl = normalizeTargetUrl(String(form.get("targetUrl") ?? ""));
  if (!targetUrl) return { errors: ["Enter the website address, e.g. example.com."] };
  const schedule = String(form.get("schedule") ?? "weekly");
  if (!["weekly", "monthly", "manual"].includes(schedule)) return { errors: ["Choose how often to crawl."] };
  const dayOfWeek = Math.min(Math.max(Number(form.get("dayOfWeek") ?? 1) | 0, 0), 6);
  const dayOfMonth = Math.min(Math.max(Number(form.get("dayOfMonth") ?? 1) | 0, 1), 28);
  const maxPages = Number(form.get("maxPages"));
  if (!Number.isInteger(maxPages) || maxPages < 10 || maxPages > MAX_PAGES_LIMIT) return { errors: [`Pages per crawl must be between 10 and ${MAX_PAGES_LIMIT.toLocaleString("en-US")}.`] };
  const enableJs = form.get("enableJs") === "on";
  const lighthouse = String(form.get("lighthouse") ?? "homepage");
  if (!["off", "homepage", "top_pages"].includes(lighthouse)) return { errors: ["Choose a page speed option."] };
  const active = form.get("active") !== "off";
  const ignore = parseIgnorePatterns(String(form.get("ignorePatterns") ?? ""));
  if (ignore.errors.length) return { errors: ignore.errors };
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { timezone: true } });
  const rule = { schedule, dayOfWeek: schedule === "weekly" ? dayOfWeek : null, dayOfMonth: schedule === "monthly" ? dayOfMonth : null };
  const data = { targetUrl, ...rule, maxPages, enableJs, lighthouse, active, ignorePatterns: ignore.patterns, nextRunAt: active ? nextAuditRun(rule, client.timezone, new Date()) : null };
  await prisma.siteAuditConfig.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });
  revalidatePath(`/clients/${clientId}`);
  return { ok: `Saved. Each crawl costs up to about ${usd(auditEstimate({ maxPages, enableJs, lighthouse }))}.`, n: (prev?.n ?? 0) + 1 };
}

/**
 * Admin only: crawl now (the button shows the estimate and asks first). The
 * crawl is then polled every 30 seconds for up to 20 minutes after the
 * response, so results appear without waiting for the hourly job.
 */
export async function runSiteAuditNow(clientId: string): Promise<SiteAuditFormState> {
  const user = await requireClientEdit(clientId);
  if (user.role !== "AGENCY_ADMIN") return { errors: ["Only an administrator can start a crawl (it spends DataForSEO credit)."] };
  let audit;
  try {
    audit = await startAudit(clientId, "manual");
  } catch (e) {
    if (e instanceof AuditError) return { errors: [e.message] };
    throw e;
  }
  revalidatePath(`/clients/${clientId}`);
  if (audit.status !== "crawling") return { errors: [audit.errorMessage ?? "The crawl couldn't start."] };
  const id = audit.id;
  after(async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 30_000));
      await pollActiveAudits().catch(() => undefined);
      const a = await prisma.siteAudit.findUnique({ where: { id }, select: { status: true } });
      if (!a || !["queued", "crawling", "processing"].includes(a.status)) break;
    }
  });
  return { ok: `Crawl started (up to ${audit.maxPages} pages, about ${usd(audit.estimatedCost)}). Results usually appear within a few minutes.` };
}

/** Admin: stop the running crawl. Pages crawled so far are still analysed (DataForSEO refunds the rest). */
export async function stopSiteAuditNow(clientId: string): Promise<SiteAuditFormState> {
  const user = await requireClientEdit(clientId);
  if (user.role !== "AGENCY_ADMIN") return { errors: ["Only an administrator can stop a crawl."] };
  let audit;
  try {
    audit = await stopAudit(clientId);
  } catch (e) {
    if (e instanceof AuditError) return { errors: [e.message] };
    throw e;
  }
  revalidatePath(`/clients/${clientId}`);
  if (audit.status === "failed") return { ok: "Cancelled before the crawl started." };
  const id = audit.id;
  after(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 15_000));
      await pollActiveAudits().catch(() => undefined);
      const a = await prisma.siteAudit.findUnique({ where: { id }, select: { status: true } });
      if (!a || !["queued", "crawling", "processing"].includes(a.status)) break;
    }
  });
  return { ok: "Stopping. The pages crawled so far will be analysed in a minute or two." };
}

/** Admin: re-check the latest finished crawl with the current rules and ignore patterns. No new crawl. */
export async function reanalyzeSiteAuditNow(clientId: string): Promise<SiteAuditFormState> {
  const user = await requireClientEdit(clientId);
  if (user.role !== "AGENCY_ADMIN") return { errors: ["Only an administrator can re-check an audit."] };
  const latest = await prisma.siteAudit.findFirst({ where: { clientId, status: "completed" }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!latest) return { errors: ["There's no finished audit to re-check."] };
  try {
    const r = await reanalyzeAudit(latest.id);
    revalidatePath(`/clients/${clientId}`);
    const scores = `Score ${r.before ?? "—"} → ${r.after ?? "—"}.${r.speedRetried ? ` Re-ran ${r.speedRetried} failed page speed test${r.speedRetried === 1 ? "" : "s"} (no charge if it fails again).` : ""}`;
    return r.mode === "refetched"
      ? { ok: `Re-checked the crawl's results with the current rules. ${scores}` }
      : { ok: `DataForSEO no longer holds this crawl's details, so the stored counts were re-scored with the current formula (CDN-path and ignore-pattern exclusions apply from the next crawl). ${scores}` };
  } catch (e) {
    if (e instanceof AuditError) return { errors: [e.message] };
    throw e;
  }
}
