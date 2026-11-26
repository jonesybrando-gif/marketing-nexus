import "server-only";
import { prisma } from "../db";
import { CATEGORY_LABEL } from "@/lib/site-audit/issues";
import { issueRows } from "./queries";
import type { LighthouseRow } from "./engine";

/** Plain-text DATA block for the AI site audit summary: score, change, issues with counts, fixes and changes, page speed. */
export async function auditSummaryData(auditId: string): Promise<string> {
  const audit = await prisma.siteAudit.findUniqueOrThrow({ where: { id: auditId }, include: { issues: true, client: { select: { name: true } } } });
  const previous = await prisma.siteAudit.findFirst({
    where: { clientId: audit.clientId, status: "completed", createdAt: { lt: audit.createdAt } },
    orderBy: { createdAt: "desc" },
    include: { issues: true },
  });
  const rows = issueRows(audit.issues, previous?.issues ?? null);
  const lines: string[] = [
    `Client: ${audit.client.name}`,
    `Website: ${audit.targetUrl}`,
    `Crawl finished: ${(audit.finishedAt ?? audit.createdAt).toISOString().slice(0, 10)}; pages checked: ${audit.pagesCrawled ?? 0} (limit ${audit.maxPages})`,
    `Health score (ours, 0–100, higher is better): ${audit.healthScore ?? "n/a"}${previous ? `; previous crawl ${previous.healthScore ?? "n/a"} on ${(previous.finishedAt ?? previous.createdAt).toISOString().slice(0, 10)}` : "; this is the first crawl"}`,
    `Pages with errors: ${audit.errorPages ?? 0}; with warnings: ${audit.warningPages ?? 0}; with notices: ${audit.noticePages ?? 0}`,
    "",
    "Issues (severity | issue | category | pages affected now | previous crawl | change | how to fix):",
    ...rows.map((r) => `- ${r.severity} | ${r.label} | ${CATEGORY_LABEL[r.category]} | ${r.count}${r.siteWide ? " (site-wide check)" : ""} | ${r.previous ?? "n/a"} | ${previous ? r.change : "first crawl"} | ${r.fix}`),
  ];
  const lh = Array.isArray(audit.lighthouse) ? (audit.lighthouse as unknown as LighthouseRow[]) : [];
  if (lh.length) {
    lines.push("", "Page speed (Lighthouse, mobile; performance 0–100, LCP = largest content paint in ms, CLS = layout shift, TBT = blocking time in ms):");
    for (const r of lh) lines.push(`- ${r.url}: ${r.error ? `not measured (${r.error})` : `performance ${r.performance ?? "n/a"}, LCP ${r.lcpMs !== null ? Math.round(r.lcpMs) : "n/a"}, CLS ${r.cls !== null ? r.cls.toFixed(3) : "n/a"}, TBT ${r.tbtMs !== null ? Math.round(r.tbtMs) : "n/a"}`}`);
  }
  return lines.join("\n");
}
