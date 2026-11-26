import Link from "next/link";
import { Gauge } from "lucide-react";
import { prisma } from "@/server/db";
import { siteAuditView } from "@/server/site-audit/queries";
import { ANALYSIS_VERSION, auditEstimate, monthSpend } from "@/server/site-audit/jobs";
import { ERROR_HELP, type AuditErrorCode } from "@/server/site-audit/engine";
import { agencyDataForSeoConnection } from "@/server/data-sources/dataforseo/account";
import { onPageRates } from "@/server/data-sources/dataforseo/pricing";
import { describeAuditSchedule } from "@/lib/site-audit/schedule";
import { formatDate, relativeTime } from "@/lib/time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { AuditScoreBody, AuditSummaryBody, type AuditTarget } from "./audit-widgets";
import { AuditAutoRefresh, AuditIssueTable, AuditSettingsDrawer, AuditSettingsForm, ReanalyzeButton, RunAuditButton, StopCrawlButton } from "./site-audit-controls";
import { SCORE_EXPLANATION } from "@/lib/site-audit/score";

const when = (d: Date | null | undefined) => (d ? formatDate(d.toISOString().slice(0, 10), { month: "short", day: "numeric", year: "numeric" }) : "—");
const fmtMs = (ms: number | null) => (ms === null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

/**
 * Client → Site Audit: health score and trend, what changed, the AI summary,
 * issues by severity, page speed, and (staff) settings and "Run audit now".
 */
export async function SiteAuditTab({ clientId, agencyId, canEdit, isAdmin, staff }: { clientId: string; agencyId: string; canEdit: boolean; isAdmin: boolean; staff: boolean }) {
  const [view, client, connection] = await Promise.all([
    siteAuditView(clientId),
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { name: true, timezone: true } }),
    staff ? agencyDataForSeoConnection(agencyId) : Promise.resolve(null),
  ]);
  const rates = onPageRates();
  const { config, latest, running, lastAttempt } = view;

  if (!config) {
    if (!staff) return <Card><CardContent className="py-6 text-sm text-text-2">No site audit has been set up yet.</CardContent></Card>;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Gauge className="h-5 w-5 text-text-2" aria-hidden /> Set up the Site Auditor</CardTitle>
          <CardDescription>
            Crawls {client.name}&apos;s website on a schedule with DataForSEO and turns what it finds into a health score, a list of technical SEO issues with how to fix each, and what changed since the last crawl.
            {!connection && " DataForSEO isn't connected yet: an administrator can add the API login in Settings › Connections."}
          </CardDescription>
        </CardHeader>
        {canEdit && (
          <CardContent className="max-w-xl">
            <AuditSettingsForm clientId={clientId} rates={rates} value={{ targetUrl: "", schedule: "weekly", dayOfWeek: 1, dayOfMonth: 1, maxPages: 500, enableJs: false, lighthouse: "homepage", active: true, ignorePatterns: [] }} />
          </CardContent>
        )}
      </Card>
    );
  }

  const estimate = auditEstimate(config);
  const agency = staff ? await prisma.agency.findUniqueOrThrow({ where: { id: agencyId }, select: { siteAuditMonthlyCapUsd: true } }) : null;
  const spent = staff ? await monthSpend(agencyId) : 0;
  const capLeft = (agency?.siteAuditMonthlyCapUsd ?? 0) - spent;
  const failedSince = lastAttempt && (lastAttempt.status === "failed" || lastAttempt.status === "skipped") && (!latest || lastAttempt.createdAt > latest.createdAt) ? lastAttempt : null;
  const issueDetail = latest ? await prisma.siteAuditIssue.findMany({ where: { auditId: latest.id }, select: { issueKey: true, sampleUrls: true, targets: true } }) : [];
  const samples = Object.fromEntries(issueDetail.map((i) => [i.issueKey, Array.isArray(i.sampleUrls) ? (i.sampleUrls as string[]).filter(Boolean) : []]));
  const targets = Object.fromEntries(issueDetail.filter((i) => Array.isArray(i.targets)).map((i) => [i.issueKey, i.targets as unknown as AuditTarget[]]));
  const settingsValue = { targetUrl: config.targetUrl, schedule: config.schedule, dayOfWeek: config.dayOfWeek ?? 1, dayOfMonth: config.dayOfMonth ?? 1, maxPages: config.maxPages, enableJs: config.enableJs, lighthouse: config.lighthouse, active: config.active, ignorePatterns: config.ignorePatterns };
  // The latest results predate the current rules, or the ignore patterns changed since: offer a free re-check.
  const samePatterns = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const outdated = !!latest && (latest.analysisVersion < ANALYSIS_VERSION || !samePatterns(latest.ignorePatterns, config.ignorePatterns));

  return (
    <div className="flex flex-col gap-4">
      <AuditAutoRefresh active={!!running} />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>Site health</CardTitle>
              <CardDescription>
                <a href={config.targetUrl} target="_blank" rel="noreferrer noopener" className="text-brand-text hover:underline">{config.targetUrl.replace(/^https?:\/\//, "")}</a>
                {" · "}{config.active ? describeAuditSchedule(config) : "Scheduled crawls off"}
                {config.active && config.nextRunAt && <> · next crawl {when(config.nextRunAt)}</>}
                {" · "}up to {config.maxPages.toLocaleString("en-US")} pages
              </CardDescription>
            </div>
            {staff && (
              <div className="flex flex-wrap items-start gap-2">
                {canEdit && <AuditSettingsDrawer clientId={clientId} value={settingsValue} rates={rates} />}
                {isAdmin && <RunAuditButton clientId={clientId} estimate={estimate} capLeft={capLeft} disabled={!!running || !connection} disabledReason={running ? "A crawl is already running." : "Connect DataForSEO first."} />}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {running && (
            <div className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-info-bg px-3 py-2 text-sm text-info-ink" role="status">
              <p>
                {running.status === "processing" ? "Crawl finished; analysing the results…" : running.stopRequestedAt ? `Stopping after ${running.pagesCrawled ?? 0} pages; analysing what was crawled…` : `Crawling… ${running.pagesCrawled ?? 0} of up to ${running.maxPages} pages so far`} (started {relativeTime(running.startedAt?.toISOString() ?? running.createdAt.toISOString())}). This page updates on its own.
              </p>
              {isAdmin && running.status === "crawling" && <StopCrawlButton clientId={clientId} stopping={!!running.stopRequestedAt} />}
            </div>
          )}
          {latest?.stopRequestedAt && latest.errorMessage && staff && <p className="text-xs text-text-2">{latest.errorMessage}</p>}
          {failedSince && staff && (
            <p className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-ink" role="alert">
              {failedSince.status === "skipped" ? "Last crawl skipped" : "Last crawl failed"} on {when(failedSince.createdAt)}: {failedSince.errorMessage ?? ERROR_HELP[failedSince.errorCode as AuditErrorCode] ?? "unknown error"}
            </p>
          )}
          {latest ? (
            <AuditScoreBody
              score={latest.healthScore}
              previous={view.previous?.healthScore ?? null}
              comparedAt={view.previous ? (view.previous.finishedAt ?? view.previous.createdAt).toISOString() : null}
              pages={latest.pagesCrawled}
              errorPages={latest.errorPages}
              crawledAt={(latest.finishedAt ?? latest.createdAt).toISOString()}
              trend={{ dates: view.trend.map((t) => t.date.slice(0, 10)), scores: view.trend.map((t) => t.score) }}
              chartClassName="h-56"
            />
          ) : (
            !running && <p className="text-sm text-text-2">No crawl has finished yet. {isAdmin ? "Run one now, or wait for the schedule." : "The first one runs on the schedule above."}</p>
          )}
          {latest && isAdmin && !running && (
            <div className="flex flex-col gap-1">
              {outdated && <p className="text-xs text-warning-ink">These results were analysed with older rules or before the current ignore patterns. Re-check them for free (no new crawl).</p>}
              <ReanalyzeButton clientId={clientId} outdated={outdated} />
            </div>
          )}
          {latest && view.previous && (
            <p className="text-sm text-text-2">
              Since {when(view.previous.finishedAt ?? view.previous.createdAt)}: <span className="font-medium text-critical-ink">{view.changes.new} new</span>, <span className="font-medium text-warning-ink">{view.changes.worse} worse</span>, <span className="font-medium text-good-ink">{view.changes.fixed} fixed</span>, {view.changes.better} better.
            </p>
          )}
          {staff && (
            <p className="text-xs text-text-3">
              Each crawl costs up to about ${estimate.toFixed(2)} (DataForSEO){latest?.actualCost != null && <>; the last one cost ${latest.actualCost.toFixed(3)}</>}. This month: ${spent.toFixed(2)} of the ${(agency?.siteAuditMonthlyCapUsd ?? 0).toFixed(2)} agency cap
              {isAdmin && <> (<Link href="/integrations" className="underline hover:text-text">change</Link>)</>}.
              {" "}Score: {SCORE_EXPLANATION}
            </p>
          )}
        </CardContent>
      </Card>

      {latest && (view.aiSummary || (staff && latest.aiSummaryError)) && (
        <Card>
          <CardHeader><CardTitle>What the latest crawl found</CardTitle></CardHeader>
          <CardContent>
            {view.aiSummary ? <AuditSummaryBody {...view.aiSummary} /> : <p className="text-sm text-text-3">AI summary not available: {latest.aiSummaryError}</p>}
          </CardContent>
        </Card>
      )}

      {latest && (
        <Card>
          <CardHeader>
            <CardTitle>Issues</CardTitle>
            <CardDescription>Grouped by severity. Open an issue for how to fix it and example pages.{latest.detailPrunedAt && " Example pages are kept for the last 6 crawls only."}</CardDescription>
          </CardHeader>
          <CardContent>
            {view.issues.length ? <AuditIssueTable rows={view.issues} sampleUrls={samples} targets={targets} hasPrevious={!!view.previous} /> : <p className="text-sm text-text-2">No issues found in the latest crawl.</p>}
          </CardContent>
        </Card>
      )}

      {latest && view.lighthouse.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Page speed</CardTitle>
            <CardDescription>Google Lighthouse on mobile. Performance 0–100 (90+ is good); LCP = when the main content shows (under 2.5 s is good); CLS = how much the layout jumps (under 0.1); TBT = time the page is unresponsive (under 200 ms).</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-text-2"><th className="py-1 pr-3 font-medium">Page</th><th className="py-1 pr-3 text-right font-medium">Performance</th><th className="py-1 pr-3 text-right font-medium">LCP</th><th className="py-1 pr-3 text-right font-medium">CLS</th><th className="py-1 text-right font-medium">TBT</th></tr></thead>
              <tbody className="divide-y divide-border">
                {view.lighthouse.map((r) => (
                  <tr key={r.url}>
                    <td className="max-w-[320px] truncate py-1.5 pr-3"><a href={r.url} target="_blank" rel="noreferrer noopener" className="text-brand-text hover:underline">{r.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</a></td>
                    {r.error ? <td colSpan={4} className="max-w-[520px] py-1.5 text-right text-xs text-warning-ink">Not measured: {r.error}</td> : (
                      <>
                        <td className={`py-1.5 pr-3 text-right font-semibold tabular ${r.performance === null ? "" : r.performance >= 90 ? "text-good-ink" : r.performance >= 50 ? "text-warning-ink" : "text-critical-ink"}`}>{r.performance ?? "—"}</td>
                        <td className="py-1.5 pr-3 text-right tabular">{fmtMs(r.lcpMs)}</td>
                        <td className="py-1.5 pr-3 text-right tabular">{r.cls === null ? "—" : r.cls.toFixed(3)}</td>
                        <td className="py-1.5 text-right tabular">{fmtMs(r.tbtMs)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {staff && !latest && !running && !connection && (
        <p className="text-sm text-text-2">Connect DataForSEO in <Link href="/integrations" className={buttonVariants({ variant: "outline", size: "sm" })}>Settings › Connections</Link> to start crawling.</p>
      )}
    </div>
  );
}
