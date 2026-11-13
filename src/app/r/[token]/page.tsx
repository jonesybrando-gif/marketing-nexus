import type { Metadata } from "next";
import { Download } from "lucide-react";
import { prisma } from "@/server/db";
import { loadClientReport } from "@/server/client-report";
import { cookies } from "next/headers";
import { deadShareLinkAgency, recordShareView, resolveShareToken, shareAccessGranted, shareCookieName } from "@/server/share-links";
import { brandStyle } from "@/lib/brand-color";
import { ExpiredShareLink } from "./expired";
import { SharePasswordForm } from "./password-form";
import { rangeLabel } from "@/lib/date-ranges";
import { formatDate } from "@/lib/time";
import { buttonVariants } from "@/components/ui/button";
import { ClientReportHeader } from "@/components/reports/client-report-header";
import { ClientReportView } from "@/components/reports/client-report-view";
import { DataFreshness, NoAccountsState } from "@/components/reports/report-sections";
import { ClientFacingDashboards } from "@/components/dashboards/dashboard-section";
import { sharedReportDashboards } from "@/server/dashboards/access";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const link = await resolveShareToken(token);
  // Don't reveal the client's name in the tab before a password is entered.
  const open = link && shareAccessGranted(link, (await cookies()).get(shareCookieName(link.id))?.value);
  const name = link && open ? (await prisma.client.findUnique({ where: { id: link.clientId }, select: { name: true } }))?.name : null;
  return { title: name ? `${name} · Advertising report` : "Advertising report", robots: { index: false, follow: false } };
}

/** A client-facing report opened from a shared link, without signing in. */
export default async function SharedReportPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  const link = await resolveShareToken(token);
  if (!link) return <ExpiredShareLink agency={await deadShareLinkAgency(token)} />;
  if (!shareAccessGranted(link, (await cookies()).get(shareCookieName(link.id))?.value)) {
    const agency = await prisma.agency.findUniqueOrThrow({ where: { id: link.client.agencyId }, select: { name: true, brandColor: true } });
    return (
      <div className="min-h-screen" style={brandStyle(agency.brandColor)}>
        <div className="h-1.5 bg-brand" />
        <main className="mx-auto flex max-w-sm flex-col gap-4 px-4 py-16">
          <p className="text-sm font-semibold">{agency.name}</p>
          <div className="rounded-xl border border-border bg-surface p-5"><SharePasswordForm token={token} /></div>
        </main>
      </div>
    );
  }
  const [rep, agency] = await Promise.all([
    loadClientReport(link.clientId, { range: link.range ?? undefined, compare: link.compare ?? undefined }),
    prisma.agency.findUniqueOrThrow({ where: { id: link.client.agencyId }, select: { name: true, logoUrl: true, brandColor: true, reportHeader: true, reportFooter: true } }),
  ]);
  await recordShareView(link.id);
  const { client, preset, range, cmpRange, template } = rep;
  const isDemo = client.accounts.some((a) => a.isDemo);

  return (
    <div className="min-h-screen" style={brandStyle(agency.brandColor)}>
      <div className="h-1.5 bg-brand" />
      <main className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
        {/* The reporting provider (the agency's white-label logo or name), then the client's own logo and name. */}
        <p className="-mb-2 flex items-center gap-2 text-xs text-text-3">
          <span>Report by</span>
          {agency.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={agency.logoUrl} alt={agency.name} className="h-5 max-w-[8rem] object-contain" />
          ) : (
            <span className="font-medium text-text-2">{agency.name}</span>
          )}
        </p>
        <ClientReportHeader
          name={client.name}
          logoUrl={client.logoUrl}
          kicker={template.title}
          isDemo={isDemo}
          period={
            <>
              {rangeLabel(preset, range)}: {formatDate(range.from)} – {formatDate(range.to, { month: "short", day: "numeric", year: "numeric" })}
              {cmpRange && <> · compared with {formatDate(cmpRange.from)} – {formatDate(cmpRange.to)}</>}
            </>
          }
          below={<DataFreshness rep={rep} staff={false} />}
          actions={
            <a href={`/r/${token}/pdf`} download className={buttonVariants({ variant: "outline" })}>
              <Download className="h-4 w-4" aria-hidden /> Download PDF
            </a>
          }
        />
        {agency.reportHeader && <p className="-mt-2 text-sm text-text-2">{agency.reportHeader}</p>}
        {/* Only the link client's client-visible dashboards, after the KPI and summary sections. */}
        {client.accounts.length === 0 ? (
          <><NoAccountsState rep={rep} staff={false} /><ClientFacingDashboards dashboards={sharedReportDashboards(link.clientId)} rep={rep} staff={false} basePath={`/r/${token}`} query={{ line: sp.line }} /></>
        ) : (
          <ClientReportView rep={rep} basePath={`/r/${token}`} query={{ line: sp.line }} afterSummary={<ClientFacingDashboards dashboards={sharedReportDashboards(link.clientId)} rep={rep} staff={false} basePath={`/r/${token}`} query={{ line: sp.line }} />} />
        )}
        <footer className="border-t border-border pt-4 text-xs text-text-3">
          {agency.reportFooter && <p className="mb-1">{agency.reportFooter}</p>}
          <p>Figures are as reported by each ad platform; today&apos;s partial data is excluded.</p>
        </footer>
      </main>
    </div>
  );
}
