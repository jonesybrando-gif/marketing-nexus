import Link from "next/link";
import { clientBackHref } from "@/lib/client-nav";
import { ChevronLeft } from "lucide-react";
import type { Platform } from "@prisma/client";
import { prisma } from "@/server/db";
import { requireClientEdit } from "@/server/access";
import { integrationStatus, SLUG_FOR_PLATFORM } from "@/server/integrations/registry";
import { PLATFORM_LABEL } from "@/lib/platforms";
import { formatCustomerId } from "@/server/integrations/google-ads/gaql";
import { relativeTime } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { stopTrackingAction } from "./actions";
import { RemoveAccountButton, StopTrackingButton } from "./forms";

export const dynamic = "force-dynamic";

const SECTIONS: { platform: Platform; via: Platform; note: string }[] = [
  { platform: "GOOGLE_ADS", via: "GOOGLE_ADS", note: "Sign in with any Google login that can see this client's Google Ads account: your manager (MCC) login, a login the client added you to, or the client's own." },
  { platform: "GOOGLE_LSA", via: "GOOGLE_ADS", note: "Local Services Ads come from the client's Google Ads account. Connect it under Google Ads and tick “Local Services Ads”." },
  { platform: "META_ADS", via: "META_ADS", note: "Sign in with a Facebook login that has access to this client's ad account, usually through Business Manager." },
  { platform: "MICROSOFT_ADS", via: "MICROSOFT_ADS", note: "Sign in with a Microsoft login that has access to this client's Microsoft Advertising account." },
];

const STATUS: Record<string, { label: string; variant: "good" | "warning" | "critical" | "neutral" }> = {
  ACTIVE: { label: "Syncing", variant: "good" },
  NEEDS_REAUTH: { label: "Needs reconnecting", variant: "critical" },
  PENDING_APPROVAL: { label: "Waiting on platform approval", variant: "warning" },
};

export default async function ClientAccountsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ linked?: string; replaced?: string } & Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const back = clientBackHref(id, sp, "settings");
  const user = await requireClientEdit(id);
  const admin = user.role === "AGENCY_ADMIN";
  const [client, accounts, connections, stopped] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id }, select: { name: true } }),
    prisma.adAccount.findMany({ where: { clientId: id, status: { not: "DISCONNECTED" } }, include: { connection: { select: { status: true } } }, orderBy: { name: "asc" } }),
    prisma.platformConnection.findMany({ where: { agencyId: user.agencyId, status: { not: "DISCONNECTED" } }, select: { id: true, platform: true, label: true }, orderBy: { createdAt: "desc" } }),
    prisma.adAccount.findMany({ where: { clientId: id, status: "DISCONNECTED", isDemo: false }, select: { id: true, name: true, platform: true, externalId: true, lastSuccessfulSyncAt: true }, orderBy: { name: "asc" } }),
  ]);
  const status = Object.fromEntries(integrationStatus().map((i) => [i.platform, i]));

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div>
        <Link href={back} className="inline-flex items-center gap-1 text-sm text-text-2 hover:text-text"><ChevronLeft className="h-4 w-4" /> {client.name}</Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Ad accounts</h1>
        <p className="text-sm text-text-2">Each platform links to one of {client.name}&apos;s ad accounts. Marketing Nexus only reads reporting data; it never changes campaigns or budgets.</p>
      </div>
      {sp.linked && (
        <p className="rounded-lg border border-border bg-good-bg px-4 py-3 text-sm text-good-ink" role="status">
          Linked. About 13 months of history is importing in the background; refresh in a few minutes.{Number(sp.replaced) > 0 && " The previously linked account stopped syncing; its history is kept."}
        </p>
      )}
      {SECTIONS.map((s) => {
        const linked = accounts.filter((a) => a.platform === s.platform);
        const info = status[s.via];
        const ready = info && info.state !== "awaiting_credentials" && info.state !== "not_implemented";
        const slug = SLUG_FOR_PLATFORM[s.via]!;
        const logins = connections.filter((c) => c.platform === s.via);
        return (
          <Card key={s.platform}>
            <CardHeader>
              <CardTitle>{PLATFORM_LABEL[s.platform]}</CardTitle>
              <CardDescription>{s.note}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {linked.length === 0 ? (
                <p className="text-sm text-text-3">No account linked.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                  {linked.map((a) => {
                    const st = a.isDemo ? null : STATUS[a.connection?.status ?? a.status] ?? STATUS.ACTIVE;
                    return (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="font-medium">{a.name}</span>
                          <span className="text-xs text-text-3">
                            {(a.platform === "GOOGLE_ADS" || a.platform === "GOOGLE_LSA") && /^\d{10}$/.test(a.externalId) ? formatCustomerId(a.externalId) : a.externalId}
                            {" · "}{a.isDemo ? "Demo data" : `Last synced ${relativeTime(a.lastSuccessfulSyncAt?.toISOString() ?? null).toLowerCase()}`}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          {a.isDemo ? <Badge variant="info">Demo data</Badge> : st && <Badge variant={st.variant}>{st.label}</Badge>}
                          {admin && !a.isDemo && <StopTrackingButton action={stopTrackingAction.bind(null, id, a.id)} />}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {s.platform !== "GOOGLE_LSA" && (
                !admin ? (
                  <p className="text-xs text-text-3">An agency administrator can connect or change this account.</p>
                ) : !ready ? (
                  <p className="text-xs text-warning-ink">Waiting for API credentials. See <Link className="underline" href="/integrations">Integrations</Link>.</p>
                ) : (
                  <div className="flex flex-wrap items-end gap-3">
                    <a href={`/api/integrations/${slug}/connect?client=${id}`} className={buttonVariants()}>
                      {linked.length ? "Change account" : `Connect ${PLATFORM_LABEL[s.via]}`}
                    </a>
                    {logins.length > 0 && (
                      <form action={`/clients/${id}/accounts/${slug}`} method="get" className="flex flex-wrap items-center gap-2">
                        <Select name="connection" aria-label="Use a login you've already connected" className="w-64" defaultValue={logins[0].id}>
                          {logins.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </Select>
                        <button type="submit" className={buttonVariants({ variant: "outline" })}>Use this login</button>
                      </form>
                    )}
                  </div>
                )
              )}
            </CardContent>
          </Card>
        );
      })}
      {stopped.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Stopped tracking</CardTitle>
            <CardDescription>These accounts no longer sync. Their history still counts in past months. Remove one to delete it and its history from {client.name}.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {stopped.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{a.name}</span>
                    <span className="text-xs text-text-3">
                      {PLATFORM_LABEL[a.platform]} · {(a.platform === "GOOGLE_ADS" || a.platform === "GOOGLE_LSA") && /^\d{10}$/.test(a.externalId) ? formatCustomerId(a.externalId) : a.externalId}
                      {" · "}Last synced {relativeTime(a.lastSuccessfulSyncAt?.toISOString() ?? null).toLowerCase()}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant="neutral">Stopped</Badge>
                    {admin && <RemoveAccountButton clientId={id} accountId={a.id} name={a.name} />}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
