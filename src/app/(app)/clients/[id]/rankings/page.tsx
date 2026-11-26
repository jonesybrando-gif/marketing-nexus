import Link from "next/link";
import { clientBackHref } from "@/lib/client-nav";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/server/db";
import { requireClientEdit } from "@/server/access";
import { agencyDataForSeoConnection, dataForSeoBalance, formatUsd } from "@/server/data-sources/dataforseo/account";
import { activeItemCount, clientRankProject } from "@/server/data-sources/dataforseo/projects";
import { serpCheckPriceUsd } from "@/server/data-sources/dataforseo/pricing";
import { keywordRankTable, type KeywordRankRow } from "@/server/metrics/rankings";
import { guessDefaultLocation, searchConsoleDomain } from "@/server/metrics/rank-suggestions";
import { DEFAULT_DEVICE, DEFAULT_LOCATION_CODE, DEFAULT_LOCATION_NAME, rankCostEstimate, readRankSettings, shortLocationName } from "@/lib/rankings";
import { relativeTime } from "@/lib/time";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionButton } from "@/components/action-button";
import { setRankProjectPaused } from "./actions";
import { AddKeywordsPanel, RankProjectForm } from "./forms";
import { RankTable, type ArchivedItem } from "./rank-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Keyword rankings" };

export default async function RankingsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const back = clientBackHref(id, await searchParams, "settings");
  const user = await requireClientEdit(id);
  const [client, connection, asset] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id }, select: { name: true } }),
    agencyDataForSeoConnection(user.agencyId),
    clientRankProject(id),
  ]);
  const price = serpCheckPriceUsd();
  const [rows, tracked, archivedRows, agencyItems, { balance, error: balanceError }, gscDomain, guessed] = await Promise.all([
    asset ? keywordRankTable(id, { days: 30 }) : Promise.resolve([] as KeywordRankRow[]),
    asset ? activeItemCount(asset.id) : Promise.resolve(0),
    asset ? prisma.trackedKeyword.findMany({ where: { assetId: asset.id, archivedAt: { not: null } }, orderBy: { archivedAt: "desc" }, take: 200, select: { id: true, keyword: true, locationCode: true, locationName: true, device: true, archivedAt: true } }) : Promise.resolve([]),
    connection ? prisma.trackedKeyword.count({ where: { active: true, asset: { connectionId: connection.id, status: { not: "DISCONNECTED" } } } }) : Promise.resolve(0),
    dataForSeoBalance(connection),
    asset ? Promise.resolve(null) : searchConsoleDomain(id),
    asset || !connection ? Promise.resolve(null) : guessDefaultLocation(id, user.agencyId).catch(() => null),
  ]);
  const settings = readRankSettings(asset?.settings);
  const defaultLocation = asset
    ? { code: settings.locationCode, name: settings.locationName ?? DEFAULT_LOCATION_NAME }
    : guessed ?? { code: DEFAULT_LOCATION_CODE, name: DEFAULT_LOCATION_NAME };
  const defaultDevice = asset ? settings.device : DEFAULT_DEVICE;
  const cost = rankCostEstimate(tracked, price);
  const paused = asset?.status === "DISCONNECTED";
  const lastRunAt = asset?.settings && typeof asset.settings === "object" && "lastRunAt" in asset.settings ? String((asset.settings as Record<string, unknown>).lastRunAt) : null;
  const archived: ArchivedItem[] = archivedRows.map((a) => ({ id: a.id, keyword: a.keyword, locationName: shortLocationName(a.locationName, a.locationCode), device: a.device, archivedAt: a.archivedAt!.toISOString() }));

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6">
      <div>
        <Link href={back} className="inline-flex items-center gap-1 text-sm text-text-2 hover:text-text"><ChevronLeft className="h-4 w-4" /> {client.name}</Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Keyword rankings</h1>
        <p className="text-sm text-text-2">
          Exact Google organic positions for {client.name}&apos;s keywords, checked once a day (top 100 results) through DataForSEO.
          Add the “Keyword rankings” dashboard template to show them to the client.
        </p>
      </div>

      {!connection ? (
        <Card>
          <CardHeader>
            <CardTitle>Connect DataForSEO first</CardTitle>
            <CardDescription>Rank checks run on your agency&apos;s DataForSEO account. {user.role === "AGENCY_ADMIN" ? "Add the API login in Settings › Connections." : "Ask an administrator to connect it in Settings › Connections."}</CardDescription>
          </CardHeader>
          {user.role === "AGENCY_ADMIN" && <CardContent><Link href="/integrations" className={buttonVariants({ size: "sm" })}>Open Integrations</Link></CardContent>}
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle>{asset ? "Client defaults" : "Set up rank tracking"}</CardTitle>
                <CardDescription>
                  {asset
                    ? <>Tracking <span className="font-medium text-text">{asset.externalId}</span>. New keywords default to {shortLocationName(defaultLocation.name, defaultLocation.code)} on {defaultDevice === "both" ? "desktop and mobile" : defaultDevice}; each keyword keeps its own location and device.{" "}
                      {paused ? "Paused." : <>Last check {relativeTime(asset.lastSuccessfulSyncAt?.toISOString() ?? lastRunAt)}{settings.pendingTasks.length > 0 && <> · {settings.pendingTasks.length} check{settings.pendingTasks.length === 1 ? "" : "s"} in progress</>}.</>}</>
                    : "Enter the website. The location and device here are only defaults: you choose them for each batch of keywords when you add it."}
                </CardDescription>
              </div>
              {asset && <ActionButton action={setRankProjectPaused.bind(null, id, !paused)} label={paused ? "Resume checks" : "Pause checks"} variant="outline" />}
            </div>
            {asset?.lastError && <p className="mt-1 text-xs text-critical-ink" role="alert">{asset.lastError}</p>}
            {connection.status !== "ACTIVE" && <p className="mt-1 text-xs text-critical-ink">The agency&apos;s DataForSEO login needs reconnecting in Settings › Connections.</p>}
          </CardHeader>
          <CardContent>
            <RankProjectForm clientId={id} domain={asset?.externalId ?? gscDomain ?? undefined} location={defaultLocation} device={defaultDevice} isNew={!asset} />
          </CardContent>
        </Card>
      )}

      {asset && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Add keywords</CardTitle>
              <CardDescription>Paste a batch, pick where the searcher is and the device, then add. Each keyword × location × device is tracked on its own.</CardDescription>
            </CardHeader>
            <CardContent>
              <AddKeywordsPanel clientId={id} tracked={tracked} defaultLocation={defaultLocation} defaultDevice={defaultDevice} pricePerCheck={price} agencyItems={agencyItems} />
              <p className="mt-4 text-xs text-text-2">
                Now: {tracked} tracked item{tracked === 1 ? "" : "s"} for this client ≈ <span className="tabular">{formatUsd(cost.perMonth)}</span>/month (about {formatUsd(price, 4)} per check, billed by DataForSEO).
                Agency balance: <span className={`font-semibold tabular ${balance !== null && balance < 1 ? "text-critical-ink" : "text-text"}`}>{formatUsd(balance)}</span>
                {balance !== null && balance > 0 && cost.perDay > 0 && <> · covers this client for about {Math.floor(balance / cost.perDay).toLocaleString("en-US")} days</>}
                {balanceError && <span className="text-warning-ink"> · couldn&apos;t read the balance: {balanceError}</span>}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Positions</CardTitle>
              <CardDescription>Latest check per tracked item. Changes compare with 7 and 30 days earlier; ▲ means it moved up. “&gt;100” means the site isn&apos;t in the top 100. Select items to change their location or device, pause, archive or delete them.</CardDescription>
              {settings.taskErrors.length > 0 && (
                <details className="mt-1 text-xs text-warning-ink">
                  <summary className="cursor-pointer">{settings.taskErrors.length} keyword check{settings.taskErrors.length === 1 ? "" : "s"} failed on the last run (retried automatically)</summary>
                  <ul className="mt-1 list-disc pl-5">{settings.taskErrors.map((e, i) => <li key={i}>{e.keyword}: {e.message}</li>)}</ul>
                </details>
              )}
            </CardHeader>
            <CardContent>
              {rows.length || archived.length ? <RankTable clientId={id} rows={rows} archived={archived} defaultLocation={defaultLocation} /> : <p className="text-sm text-text-2">No keywords yet. Add some above.</p>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
