import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { CalendarClock, ChevronRight, LayoutDashboard, Sparkles, StickyNote, Download, Database, FileSliders, FileText, Link2, ListChecks, Mail, Plug, Search, Share2, Wallet } from "lucide-react";
import { AiSuggestionsCard } from "@/components/ai/suggestions-card";
import { requireClientView, userCanEditClient, visibleClientsWhere } from "@/server/access";
import { withRememberedRange } from "@/server/remembered-range";
import { shortRangeLabel, withReportQuery } from "@/lib/client-nav";
import { ClientSwitcher } from "@/components/client-switcher";
import { LinkPending } from "@/components/link-pending";
import { loadOnHover } from "@/lib/link-hover";
import { prisma } from "@/server/db";
import { completeClientReport, loadClientReportHead, type ClientReport } from "@/server/client-report";
import { rangeLabel } from "@/lib/date-ranges";
import { ClientAlertsStrip } from "@/components/alerts/client-alerts-strip";
import { formatDate } from "@/lib/time";
import { DemoBadge } from "@/components/status-badge";
import { CompactRangeControls, RangeControls } from "@/components/range-controls";
import { ExportButtons, exportHref } from "@/components/export-buttons";
import { Menu } from "@/components/ui/menu";
import { ClientReportHeader } from "@/components/reports/client-report-header";
import { ClientVisibilityToggle } from "@/components/reports/visibility-toggle";
import { ActionButton } from "@/components/action-button";
import { ChartNoteForm } from "./notes-form";
import { deleteChartNoteAction } from "./notes-actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionSkeleton } from "@/components/ui/skeleton";
import { ExecutiveSummary } from "@/components/reports/executive-summary";
import { ClientDashboardsTab } from "@/components/dashboards/client-dashboards-tab";
import { ClientReportTab } from "@/components/dashboards/client-report-tab";
import { ClientBudgetTable } from "./client-budget-table";
import { ClientFacingDashboards } from "@/components/dashboards/dashboard-section";
import { ConnectedDataSection } from "@/components/dashboards/connected-data-section";
import { listClientDashboards } from "@/server/dashboards/access";
import { DataFreshness, HistorySection, NoAccountsState, PlatformSection } from "@/components/reports/report-sections";
import { PaidMediaTab } from "@/components/reports/paid-media-tab";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { ClientLogo } from "@/components/client-logo";
import { SeoTab } from "@/components/seo/seo-tab";
import { NextStepsSection } from "@/components/next-steps/next-steps-section";
import { OpportunitiesList } from "@/app/(app)/insights/opportunities";
import { AnalyticsTab } from "@/components/analytics/analytics-tab";

export const dynamic = "force-dynamic";

// Report · Paid Media · SEO · Google Analytics · Budgets | Settings
const TABS = [
  { key: "report", label: "Report", group: 0 },
  { key: "paid", label: "Paid Media", group: 0 },
  { key: "seo", label: "SEO", group: 0 },
  { key: "analytics", label: "Google Analytics", group: 0 },
  { key: "budgets", label: "Budgets", group: 0 },
  { key: "settings", label: "Settings", group: 3 },
] as const;
/** Pages reached from Settings rather than the tab bar (the former AI Insights and Reports tabs). */
const SUB_PAGES = ["insights", "dashboards"] as const;
type Tab = (typeof TABS)[number]["key"] | (typeof SUB_PAGES)[number];
/** Old tab names, so old links and bookmarks still land in the right place. */
const LEGACY_TAB: Record<string, Tab> = { overview: "report", campaigns: "paid", trends: "paid", reports: "dashboards", setup: "settings" };

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  // Same access check as the page, so the tab title never names a client the viewer can't open.
  await requireClientView(id);
  const c = await prisma.client.findUnique({ where: { id }, select: { name: true } });
  return { title: c?.name ?? "Client" };
}

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  // No range in the URL: use the last one chosen (cookie), so the dates stick between pages.
  const sp = await withRememberedRange(await searchParams);
  const user = await requireClientView(id);
  const staff = user.role !== "CLIENT_USER";

  // The header needs only the quick part of the report. The heavy figures load
  // in the background and stream into the in-page <Suspense> boundaries below
  // (not a route loading.tsx: those made value-returning server actions hang).
  // Independent lookups run together rather than one after another.
  const now = new Date();
  const [canEdit, rep, switchable] = await Promise.all([
    // Same rule as requireClientEdit, which the template save actions enforce.
    userCanEditClient(user, id),
    loadClientReportHead(id, sp, now),
    staff ? prisma.client.findMany({ where: visibleClientsWhere(user), select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
  ]);
  // The full figures are loaded only by tabs that show them (SEO and Analytics don't), once per page.
  let fullReport: Promise<ClientReport> | null = null;
  const loadFull = () => {
    if (!fullReport) {
      fullReport = completeClientReport(rep, now);
      fullReport.catch(() => {}); // Each <WithReport> awaits it and surfaces any error; this only avoids an unhandled rejection.
    }
    return fullReport;
  };
  const { client, preset, compareMode, range, cmpRange, pacing } = rep;
  const isDemo = client.accounts.some((a) => a.isDemo);
  const asked = sp.tab ? LEGACY_TAB[sp.tab] ?? sp.tab : "report";
  const tab: Tab = staff && (TABS.some((t) => t.key === asked) || (SUB_PAGES as readonly string[]).includes(asked)) ? (asked as Tab) : "report";
  const base = `/clients/${id}`;
  const tabHref = (t: Tab) => {
    const q = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "tab" && k !== "line" && k !== "edit") as [string, string][]);
    if (t !== "report") q.set("tab", t);
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  const exportBase = `/api/reports/clients/${id}`;

  // Sub-pages get the range and tab so their back links return to the same view.
  const keep = (href: string) => withReportQuery(href, { ...sp, tab: sp.tab ?? "report" });
  const editHref = `${tabHref("report")}${tabHref("report").includes("?") ? "&" : "?"}edit=1`;

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
      <div className="min-w-0 max-md:w-full">
        {staff && (
          <nav aria-label="Breadcrumb" className="mb-0.5 hidden md:block">
            <ol className="flex items-center gap-1 text-xs text-text-3">
              <li><Link href="/clients" className="hover:text-text hover:underline">Clients</Link></li>
              <li aria-hidden><ChevronRight className="h-3 w-3" /></li>
              <li aria-current="page" className="truncate text-text-2">{client.name}</li>
            </ol>
          </nav>
        )}
        <div className="flex items-center gap-1">
          <ClientLogo name={client.name} logoUrl={client.logoUrl} size="md" className="mr-2" />
          <h1 className="truncate text-2xl font-semibold tracking-tight">{client.name}</h1>
          {staff && <ClientSwitcher clientId={id} clients={switchable.map((c) => ({ value: c.id, label: c.name }))} />}
          {isDemo && <DemoBadge />}
        </div>
        <p className="hidden text-sm text-text-2 md:block">
          {rangeLabel(preset, range)}: {formatDate(range.from)} – {formatDate(range.to, { month: "short", day: "numeric", year: "numeric" })}
          {cmpRange && <> · compared with {formatDate(cmpRange.from)} – {formatDate(cmpRange.to)}</>}
          {pacing.client.managerName && staff && <> · Manager: {pacing.client.managerName}</>}
        </p>
        <div className="mt-1.5"><DataFreshness rep={rep} staff={staff} setupHref={staff ? tabHref("settings") : undefined} /></div>
      </div>
      <div className="flex min-w-0 items-center gap-2 max-md:w-full max-md:justify-between md:flex-wrap">
        <div className="hidden md:block"><RangeControls preset={preset} compare={compareMode} from={range.from} to={range.to} /></div>
        <div className="md:hidden"><CompactRangeControls label={shortRangeLabel(range.from, range.to)} preset={preset} compare={compareMode} from={range.from} to={range.to} /></div>
        {staff ? (
          // The one output button: send it, or download it.
          <Menu
            label="Share"
            variant="default"
            icon={<Share2 className="h-4 w-4" aria-hidden />}
            sections={[
              {
                heading: "Send",
                items: [
                  { href: keep(`${base}/share`), label: "Share link", hint: "A link the client opens without signing in", icon: <Link2 className="h-4 w-4" /> },
                  { href: keep(`${base}/email`), label: "Email client", hint: "Draft an update from this report", icon: <Mail className="h-4 w-4" /> },
                  { href: keep(`${base}/share#schedule`), label: "Schedule email", hint: "Send the PDF automatically each month", icon: <CalendarClock className="h-4 w-4" /> },
                ],
              },
              {
                heading: "Download",
                items: [
                  { href: exportHref(exportBase, sp, "pdf"), label: "PDF", hint: "Client-facing report", icon: <FileText className="h-4 w-4" />, download: true },
                  { href: exportHref(exportBase, sp, "pdf", "internal=1"), label: "PDF + internal notes", hint: "Includes recommendations; not for the client", icon: <FileText className="h-4 w-4" />, download: true },
                  { href: exportHref(exportBase, sp, "csv"), label: "CSV", hint: "Every daily row", icon: <Download className="h-4 w-4" />, download: true },
                ],
              },
            ]}
          />
        ) : (
          <ExportButtons base={exportBase} query={sp} />
        )}
      </div>
    </div>
  );

  if (!staff) {
    // Client logins see their own logo and name at the top, never the agency's.
    const clientHeader = (
      <ClientReportHeader
        name={client.name}
        logoUrl={client.logoUrl}
        kicker={rep.template.title}
        isDemo={isDemo}
        period={
          <>
            {rangeLabel(preset, range)}: {formatDate(range.from)} – {formatDate(range.to, { month: "short", day: "numeric", year: "numeric" })}
            {cmpRange && <> · compared with {formatDate(cmpRange.from)} – {formatDate(cmpRange.to)}</>}
          </>
        }
        below={<DataFreshness rep={rep} staff={false} />}
        actions={
          <>
            <div className="hidden md:block"><RangeControls preset={preset} compare={compareMode} from={range.from} to={range.to} /></div>
            <div className="md:hidden"><CompactRangeControls label={shortRangeLabel(range.from, range.to)} preset={preset} compare={compareMode} from={range.from} to={range.to} /></div>
            <ExportButtons base={exportBase} query={sp} />
          </>
        }
      />
    );
    return (
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
        {clientHeader}
        <Suspense fallback={<SectionSkeleton tiles={6} cards={2} />}>
          <WithReport report={loadFull()}>
            {(rep) => (
              // The finished Report (no editing), then any other dashboards shared with the client.
              <>
                <ClientReportTab rep={rep} staff={false} canEdit={false} editing={false} basePath={base} query={sp} editHref={base} doneHref={base} />
                <ClientFacingDashboards dashboards={listClientDashboards(user, id)} rep={rep} staff={false} basePath={base} query={sp} />
              </>
            )}
          </WithReport>
        </Suspense>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
      {/* Header, date range and tabs stay in view while scrolling (desktop); on phones only the tabs stick, under the top bar. */}
      <div className="max-md:contents md:sticky md:top-0 md:z-20 md:-mx-10 md:-mt-8 md:flex md:flex-col md:gap-3 md:border-b md:border-border md:bg-background/95 md:px-10 md:pt-8 md:backdrop-blur">
        {header}
        <nav className="sticky top-12 z-20 -mx-4 -mb-px flex gap-1 overflow-x-auto border-b border-border bg-background/95 px-4 backdrop-blur max-md:-mt-3 md:static md:mx-0 md:border-b-0 md:bg-transparent md:px-0 md:backdrop-blur-none" aria-label="Client sections">
          {TABS.map((t, i) => (
            <span key={t.key} className={`flex items-center ${t.group === 3 ? "md:ml-auto" : ""}`}>
              {i > 0 && t.group !== TABS[i - 1].group && t.group !== 3 && <span aria-hidden className="mx-1.5 h-4 w-px bg-border max-md:hidden" />}
              <Link
                href={tabHref(t.key)}
                scroll={false}
                {...loadOnHover}
                aria-current={tab === t.key ? "page" : undefined}
                className={`inline-flex min-h-10 items-center border-b-2 px-3 py-2 text-sm whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60 ${tab === t.key ? "border-brand font-medium text-text" : "border-transparent text-text-2 hover:text-text"}`}
              >
                {t.label}
                <LinkPending className="ml-1.5" />
              </Link>
            </span>
          ))}
        </nav>
      </div>

      <Suspense fallback={null}>
        {/* Critical alerts only, so they're never missed; the full list is in AI Insights. */}
        <ClientAlertsStrip clientId={id} user={user} criticalOnly />
      </Suspense>

      {tab === "report" && (
        <Suspense fallback={<SectionSkeleton tiles={6} cards={1} tallFirst={false} />}>
          <WithReport report={loadFull()}>
            {(rep) => <ClientReportTab rep={rep} staff canEdit={canEdit} editing={sp.edit === "1"} basePath={base} query={sp} editHref={editHref} doneHref={tabHref("report")} />}
          </WithReport>
        </Suspense>
      )}

      {tab === "paid" && client.accounts.length === 0 && (
        <>
          <Suspense fallback={<SectionSkeleton cards={1} tallFirst={false} />}>
            <WithReport report={loadFull()}>{(rep) => <NoAccountsState rep={rep} staff />}</WithReport>
          </Suspense>
          {/* Notes on the data work without ad accounts too (SEO- or analytics-only clients). */}
          <Annotations clientId={id} agencyId={user.agencyId} defaultDate={rep.range.to} range={rep.range} card />
        </>
      )}

      {tab === "paid" && client.accounts.length > 0 && (
        <Suspense fallback={<SectionSkeleton tiles={3} cards={1} />}>
          <WithReport report={loadFull()}>
            {(rep) => (
              <PaidMediaTab
                rep={rep}
                basePath={base}
                params={sp}
                annotations={<Annotations clientId={id} agencyId={user.agencyId} defaultDate={rep.range.to} range={rep.range} />}
              />
            )}
          </WithReport>
        </Suspense>
      )}

      {tab === "seo" && <SeoTab clientId={id} range={range} cmpRange={cmpRange} canEdit={canEdit} settingsHref={tabHref("settings")} />}

      {tab === "analytics" && <AnalyticsTab clientId={id} range={range} cmpRange={cmpRange} canEdit={canEdit} />}

      {tab === "budgets" && (
        <>
          <Suspense fallback={<SectionSkeleton cards={1} tallFirst={false} />}>
            <ClientBudgetTable clientId={id} user={user} canEdit={canEdit} range={range} />
          </Suspense>
          <CollapsibleSection storageKey="budget-history" title="View budget history" hint="Budget, actual spend and the final result for previous months" defaultOpen={false}>
            <Suspense fallback={<SectionSkeleton cards={1} tallFirst={false} />}>
              <WithReport report={loadFull()}>{(rep) => <HistorySection rep={rep} hideEmpty bare />}</WithReport>
            </Suspense>
          </CollapsibleSection>
          <Link href={keep(`${base}/budgets`)} className="flex min-h-10 flex-col gap-1 self-start rounded-xl border border-border bg-surface px-5 py-4 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
            <span className="flex items-center gap-2 text-sm font-semibold"><Wallet className="h-4 w-4 text-text-2" aria-hidden /> Set up budgets</span>
            <span className="text-xs text-text-3">Monthly amounts, how they&apos;re split across accounts and campaigns, and when pacing warns you.</span>
          </Link>
        </>
      )}

      {tab === "dashboards" && (
        <>
          <Suspense fallback={<SectionSkeleton cards={1} tallFirst={false} />}>
            <WithReport report={loadFull()}>{(rep) => <NextStepsSection rep={rep} canEdit={canEdit} />}</WithReport>
          </Suspense>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { href: keep(`${base}/share`), Icon: Link2, title: "Share link", body: "A link the client opens without signing in." },
              { href: keep(`${base}/share#schedule`), Icon: CalendarClock, title: "Schedule email", body: "Send the report automatically each week or month." },
              { href: keep(`${base}/email`), Icon: Mail, title: "Email client", body: "Draft an update from this report." },
              { href: keep(`${base}/report`), Icon: FileSliders, title: "What the client sees", body: "The client's goal, the figures and sections in their report." },
            ].map(({ href, Icon, title, body }) => (
              <Link key={title} href={href} className="flex min-h-10 flex-col gap-1 rounded-xl border border-border bg-surface px-5 py-4 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
                <span className="flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4 text-text-2" aria-hidden /> {title}</span>
                <span className="text-xs text-text-3">{body}</span>
              </Link>
            ))}
          </div>
          <Suspense fallback={<SectionSkeleton tiles={6} cards={2} tallFirst={false} />}>
            <WithReport report={loadFull()}>{(rep) => <ClientDashboardsTab rep={rep} user={user} canEdit={canEdit} query={sp} />}</WithReport>
          </Suspense>
        </>
      )}

      {tab === "insights" && (
        // One place for every AI-written insight, with a clear switch for what the client sees.
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-brand-text" aria-hidden /> AI Insights</CardTitle>
            <CardDescription>The summary can go in the client&apos;s report; suggestions and answers stay with your team.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <section className="flex flex-col gap-3" aria-label="Executive summary">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Executive summary</h3>
                <ClientVisibilityToggle clientId={id} section="executive" visible={rep.template.sections.executive} label="Executive summary" />
              </div>
              <Suspense fallback={<SectionSkeleton cards={1} tallFirst={false} />}>
                <WithReport report={loadFull()}>{(rep) => <ExecutiveSummary rep={rep} copyable bare />}</WithReport>
              </Suspense>
            </section>
            <div className="flex flex-col gap-4 border-t border-border pt-5">
              <AiSuggestionsCard clientId={id} query={sp} bare hideList />
              <Suspense fallback={<SectionSkeleton cards={1} tallFirst={false} />}>
                <OpportunitiesList user={user} clientId={id} status={sp.status} clients={[{ id, name: client.name }]} />
              </Suspense>
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "settings" && (
        <>
          <Suspense fallback={<SectionSkeleton cards={1} tallFirst={false} />}>
            <WithReport report={loadFull()}>
              {(rep) => (
                <>
                  <PlatformSection rep={rep} staff status title="Ad accounts and data" />
                  <ConnectedDataSection rep={rep} canEdit={canEdit} query={sp} />
                </>
              )}
            </WithReport>
          </Suspense>
          {/* The one place to configure this client. Sending and downloading live in the Share button. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { href: keep(`${base}/accounts`), Icon: Plug, title: "Ad accounts", body: "Link or unlink this client's Google, Meta, Microsoft and other ad accounts." },
              { href: "/integrations", Icon: Database, title: "Connected data sources", body: "Link CallRail, Google Analytics, Search Console, Business Profile and social pages to this client (in Settings › Connections)." },
              { href: keep(`${base}/campaigns`), Icon: ListChecks, title: "Campaigns included", body: "Choose which campaigns count in reports, pacing and alerts." },
              { href: keep(`${base}/budgets`), Icon: Wallet, title: "Budgets", body: "Monthly budgets, how they're split and when pacing warns you." },
              { href: keep(`${base}/report`), Icon: FileSliders, title: "Report layout, logo & goal", body: "The client's logo and goal, the figures and sections they see, and the default date range." },
              { href: keep(`${base}/rankings`), Icon: Search, title: "Keyword rankings", body: "Daily Google positions for the client's keywords." },
              { href: tabHref("insights"), Icon: Sparkles, title: "AI insights", body: "The executive summary, suggestions and opportunities for this client." },
              { href: tabHref("dashboards"), Icon: LayoutDashboard, title: "Next steps & extra dashboards", body: "Agreed next steps, and any custom dashboards beyond the Report." },
            ].map(({ href, Icon, title, body }) => (
              <Link key={title} href={href} className="flex min-h-10 flex-col gap-1 rounded-xl border border-border bg-surface px-5 py-4 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
                <span className="flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4 text-text-2" aria-hidden /> {title}</span>
                <span className="text-xs text-text-3">{body}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Renders sections that need the full report once it has loaded; place inside a <Suspense> boundary. */
async function WithReport({ report, children }: { report: Promise<ClientReport>; children: (rep: ClientReport) => ReactNode }) {
  return <>{children(await report)}</>;
}

/**
 * Dated notes shown as ◆ markers on this client's charts: a short list (notes
 * in the page's range first) and a small "Add a note" form that stays closed
 * until needed. `card` gives it its own card (clients with no ad accounts).
 */
async function Annotations({ clientId, agencyId, defaultDate, range, card = false }: { clientId: string; agencyId: string; defaultDate: string; range: { from: string; to: string }; card?: boolean }) {
  const [notes, staff] = await Promise.all([
    prisma.chartNote.findMany({ where: { clientId }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 50 }),
    prisma.user.findMany({ where: { agencyId, deactivatedAt: null, role: { in: ["AGENCY_ADMIN", "ACCOUNT_MANAGER"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const name = new Map(staff.map((u) => [u.id, u.name]));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const inRange = notes.filter((n) => day(n.date) >= range.from && day(n.date) <= range.to);
  const others = notes.filter((n) => !inRange.includes(n));
  const item = (n: (typeof notes)[number]) => (
    <li key={n.id} className="flex items-start justify-between gap-2 py-1.5">
      <div className="min-w-0">
        <p className="text-sm"><span aria-hidden className="text-text-3">◆ </span><span className="font-medium tabular">{formatDate(day(n.date), { month: "short", day: "numeric", year: "numeric" })}</span> · {n.text}</p>
        <p className="text-xs text-text-3">
          {n.authorId ? name.get(n.authorId) ?? "A former teammate" : "Someone"}
          {n.taggedUserId && <> · tagged {name.get(n.taggedUserId) ?? "a teammate"}</>}
          {n.clientVisible ? " · shown to the client" : " · team only"}
        </p>
      </div>
      <ActionButton action={deleteChartNoteAction.bind(null, clientId, n.id)} label="Delete" variant="ghost" confirm="Delete this note?" />
    </li>
  );
  const body = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium"><StickyNote className="h-4 w-4 text-text-2" aria-hidden /> Annotations{inRange.length > 0 && <span className="font-normal text-text-3">({inRange.length} in this period)</span>}</p>
      </div>
      {inRange.length > 0 ? <ul className="divide-y divide-border">{inRange.map(item)}</ul> : <p className="text-xs text-text-3">No notes in this period. Pin one to a date (a budget change, a launch, a tracking fix) and it shows on the chart.</p>}
      {others.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-text-2 hover:text-text">Other notes ({others.length})</summary>
          <ul className="mt-1 divide-y divide-border">{others.slice(0, 20).map(item)}</ul>
        </details>
      )}
      <details className="rounded-lg border border-border px-3 py-2 open:pb-3">
        <summary className="cursor-pointer text-sm font-medium text-brand-text">+ Add a note</summary>
        <div className="mt-3"><ChartNoteForm clientId={clientId} defaultDate={defaultDate} teammates={staff} /></div>
      </details>
    </div>
  );
  if (!card) return <div className="border-t border-border pt-3">{body}</div>;
  return <Card><CardContent className="pt-5">{body}</CardContent></Card>;
}
