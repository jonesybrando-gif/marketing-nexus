import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorized } from "@/server/cron-auth";
import { reattachAllAccounts } from "@/server/integrations/reattach";
import { syncDueAccounts } from "@/server/sync/sync-account";
import { syncDueDataAssets } from "@/server/data-sources/sync";
import { runAllAlerts } from "@/server/alerts";
import { sendDueScheduledReports } from "@/server/scheduled-reports";
import { rollForwardBudgets } from "@/server/budget-rollover";
import { runSiteAuditJobs } from "@/server/site-audit/jobs";

// Scheduled entry point. Call hourly with  Authorization: Bearer $CRON_SECRET
// (Vercel Cron sends this header automatically when CRON_SECRET is set).
// Syncs due accounts, then evaluates alerts and sends any due daily summaries
// and scheduled client reports.
export const maxDuration = 300;
/** Stop starting new data-source syncs this long after the run began (one asset in progress may still finish). */
const DATA_SYNC_BUDGET_MS = 200_000;

async function run(req: NextRequest) {
  if (!cronAuthorized(req.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const started = Date.now();
  // First, so a new month's repeating budgets exist before pacing and alerts run.
  let budgetRollover: unknown;
  try {
    budgetRollover = await rollForwardBudgets();
  } catch (e) {
    budgetRollover = { error: (e as Error).message };
  }
  // Accounts stranded on a dead connection move to a live one that can reach them.
  await reattachAllAccounts();
  const results = await syncDueAccounts();
  const count = (s: string) => results.filter((r) => r.status === s).length;
  let alerts: unknown;
  try {
    alerts = await runAllAlerts();
  } catch (e) {
    alerts = { error: (e as Error).message };
  }
  let scheduledReports: unknown;
  try {
    scheduledReports = await sendDueScheduledReports();
  } catch (e) {
    scheduledReports = { error: (e as Error).message };
  }
  // Non-ad data sources run last, within what is left of maxDuration, so a large
  // first backfill never delays (or times out) ad sync, alerts and reports.
  // Assets not reached are picked up on the next run.
  let dataSources: unknown;
  try {
    const d = await syncDueDataAssets({ deadline: started + DATA_SYNC_BUDGET_MS });
    dataSources = { synced: d.length, failed: d.filter((r) => r.status === "FAILED").map((r) => ({ assetId: r.assetId, error: r.error })) };
  } catch (e) {
    dataSources = { error: (e as Error).message };
  }
  // Site audits: start due crawls (cost-capped) and collect finished ones.
  let siteAudits: unknown;
  try {
    siteAudits = await runSiteAuditJobs();
  } catch (e) {
    siteAudits = { error: (e as Error).message };
  }
  return NextResponse.json({
    budgetRollover,
    siteAudits,
    scheduledReports,
    dataSources,
    synced: results.length,
    succeeded: count("SUCCEEDED"),
    partial: count("PARTIAL"),
    failed: count("FAILED"),
    skipped: count("SKIPPED"),
    failures: results.filter((r) => r.status === "FAILED" || r.status === "PARTIAL").map((r) => ({ accountId: r.accountId, error: r.error })),
    alerts,
  });
}

export const GET = run;
export const POST = run;
