import "server-only";
import { reattachAllAccounts } from "@/server/integrations/reattach";
import { syncDueAccounts } from "./sync/sync-account";
import { syncDueDataAssets } from "./data-sources/sync";
import { runAllAlerts } from "./alerts";
import { sendDueScheduledReports } from "./scheduled-reports";
import { rollForwardBudgets } from "./budget-rollover";
import { hasActiveCrawls, pollActiveAudits, runSiteAuditJobs } from "./site-audit/jobs";

// Built-in hourly job for hosts that keep the app running (Railway, Render,
// a VPS). Does the same work as GET /api/cron/sync, so no external scheduler
// is needed. Turned on with INTERNAL_SCHEDULER=1; run only one app instance
// with it on.

const HOUR = 3_600_000;
const DATA_SYNC_BUDGET_MS = 45 * 60_000;
let running = false;

async function tick() {
  if (running) return; // the previous run is still going
  running = true;
  const started = Date.now();
  // First, so a new month's repeating budgets exist before pacing and alerts run.
  try {
    const rolled = await rollForwardBudgets();
    if (rolled.created) console.log(`[scheduler] repeated ${rolled.created} budget(s) into the new month for ${rolled.clients} client(s)`);
  } catch (e) {
    console.error("[scheduler] budget roll-forward failed", e);
  }
  try {
    // Accounts stranded on a dead connection move to a live one that can reach them.
    await reattachAllAccounts();
    const results = await syncDueAccounts();
    const failed = results.filter((r) => r.status === "FAILED").length;
    await runAllAlerts();
    const reports = await sendDueScheduledReports();
    console.log(`[scheduler] synced ${results.length} account(s), ${failed} failed, alerts checked, ${reports.filter((r) => r.sent > 0).length} scheduled report(s) sent (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (e) {
    console.error("[scheduler] run failed", e);
  }
  // Non-ad data sources run after ad sync, alerts and reports (and even when
  // those failed), with a time budget so a large backfill can't hold the
  // `running` flag into the next hour's tick.
  try {
    const data = await syncDueDataAssets({ deadline: started + DATA_SYNC_BUDGET_MS });
    if (data.length) console.log(`[scheduler] synced ${data.length} data source(s), ${data.filter((r) => r.status === "FAILED").length} failed`);
  } catch (e) {
    console.error("[scheduler] data source sync failed", e);
  }
  // Site audits: start due crawls (cost-capped) and collect finished ones.
  try {
    const audits = await runSiteAuditJobs();
    if (audits.started || audits.completed || audits.failed) console.log(`[scheduler] site audits: ${audits.started} started, ${audits.completed} completed, ${audits.failed} failed, ${audits.skipped} skipped`);
  } catch (e) {
    console.error("[scheduler] site audits failed", e);
  } finally {
    running = false;
  }
}

const CRAWL_POLL_MS = 2 * 60_000;
let polling = false;

/** While a crawl is running, collect it within minutes rather than at the next hourly tick. */
async function pollCrawls() {
  if (polling || running) return;
  polling = true;
  try {
    if (await hasActiveCrawls()) await pollActiveAudits();
  } catch (e) {
    console.error("[scheduler] site audit poll failed", e);
  } finally {
    polling = false;
  }
}

export function startScheduler() {
  const g = globalThis as { __pmScheduler?: boolean };
  if (g.__pmScheduler) return;
  g.__pmScheduler = true;
  console.log("[scheduler] hourly sync on");
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), HOUR);
  }, 60_000); // first run a minute after start-up
  setInterval(() => void pollCrawls(), CRAWL_POLL_MS);
}
