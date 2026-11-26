import { requireAgencyStaff } from "@/server/access";
import { prisma } from "@/server/db";
import { agencyDataForSeoConnection, dataForSeoBalance, formatUsd } from "@/server/data-sources/dataforseo/account";
import { serpCheckPriceUsd } from "@/server/data-sources/dataforseo/pricing";
import { rankCostEstimate } from "@/lib/rankings";
import { relativeTime } from "@/lib/time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataForSeoConnectForm, DataForSeoDisconnectButton } from "../dataforseo-forms";

const STATUS: Record<string, { label: string; variant: "good" | "critical" | "warning" | "neutral" }> = {
  ACTIVE: { label: "Connected", variant: "good" },
  NEEDS_REAUTH: { label: "Needs reconnecting", variant: "critical" },
  PENDING_APPROVAL: { label: "Pending", variant: "warning" },
};

/** Integrations card: DataForSEO API login for daily keyword rank tracking. */
export async function DataForSeoCard() {
  const user = await requireAgencyStaff();
  const admin = user.role === "AGENCY_ADMIN";
  const conn = await agencyDataForSeoConnection(user.agencyId);
  const [projects, keywords, failing, lastSync, { balance, error }] = await Promise.all([
    conn ? prisma.dataAsset.count({ where: { connectionId: conn.id, kind: "RANK_PROJECT" } }) : 0,
    // Tracked items = keyword × location × device, in projects that aren't paused.
    conn ? prisma.trackedKeyword.count({ where: { active: true, asset: { connectionId: conn.id, kind: "RANK_PROJECT", status: { not: "DISCONNECTED" } } } }) : 0,
    conn ? prisma.dataAsset.findFirst({ where: { connectionId: conn.id, lastError: { not: null } }, select: { lastError: true } }) : null,
    conn ? prisma.dataAsset.aggregate({ where: { connectionId: conn.id }, _max: { lastSuccessfulSyncAt: true } }) : null,
    dataForSeoBalance(conn),
  ]);
  const badge = conn ? STATUS[conn.status] ?? STATUS.PENDING_APPROVAL : null;
  const price = serpCheckPriceUsd();
  const monthly = rankCostEstimate(keywords, price).perMonth;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Keyword rank tracking (DataForSEO)</CardTitle>
          {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : <Badge variant="neutral">Not connected</Badge>}
        </div>
        <CardDescription>
          Exact daily Google positions for each client&apos;s keywords, checked once a day through the official DataForSEO SERP API (Standard queue,
          about {formatUsd(price, 4)} per check, billed by DataForSEO). Each keyword is tracked per location and device. Set up keywords per client under Setup → Keyword rankings.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {conn && (
          <div className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{conn.label}</span>
              {conn.status === "ACTIVE" && (
                <span className="text-xs text-text-2">
                  Balance <span className={`font-semibold tabular ${balance !== null && balance < 1 ? "text-critical-ink" : "text-text"}`}>{formatUsd(balance)}</span>
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-text-2">
              {projects} client{projects === 1 ? "" : "s"} · {keywords} tracked item{keywords === 1 ? "" : "s"} (keyword × location × device), {keywords} check{keywords === 1 ? "" : "s"} per day ≈ {formatUsd(monthly)}/month · last successful check {relativeTime(lastSync?._max.lastSuccessfulSyncAt?.toISOString() ?? null)}
            </p>
            {error && <p className="mt-1 text-xs text-warning-ink">Couldn&apos;t read the balance: {error}</p>}
            {conn.lastError && conn.status !== "ACTIVE" && <p className="mt-1 text-xs text-critical-ink">{conn.lastError}</p>}
            {failing?.lastError && <p className="mt-1 text-xs text-critical-ink">Latest error: {failing.lastError}</p>}
            {admin && <div className="mt-2 flex flex-wrap gap-2"><DataForSeoDisconnectButton /></div>}
          </div>
        )}
        {admin ? (
          <DataForSeoConnectForm reconnect={!!conn} defaultLogin={conn?.label} />
        ) : (
          !conn && <p className="text-xs text-text-2">Ask an administrator to connect DataForSEO.</p>
        )}
      </CardContent>
    </Card>
  );
}
