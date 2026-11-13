import Link from "next/link";
import { Pencil } from "lucide-react";
import type { ClientReport } from "@/server/client-report";
import { contextFromReport, resolveWidgets, scopeToPlatform } from "@/server/dashboards/data";
import { linkedSources } from "@/server/dashboards/sources";
import { loadClientReportLayout } from "@/server/dashboards/report";
import { saveClientReportAction } from "@/server/dashboards/report-actions";
import { wantsAiSummary } from "@/server/exec-summary";
import { ExecutiveSummary } from "@/components/reports/executive-summary";
import { AiSummarySection, RegenerateSummaryButton } from "@/components/reports/ai-summary-section";
import { AccountFilter } from "@/components/reports/account-filter";
import { ClientVisibilityToggle } from "@/components/reports/visibility-toggle";
import { HiddenFromClient } from "@/components/reports/report-sections";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DashboardGrid } from "./dashboard-grid";
import { ReportEditor } from "./report-editor";
import { AddSectionMenu, NewSectionsNotice, ReportSectionView } from "./report-section-view";
import { availableSectionTypes, SECTION_TYPE, type SectionType } from "@/lib/dashboards/report-sections";
import type { DashboardWidget } from "@/lib/dashboards/types";
import type { PlatformKey } from "@/lib/platforms";
import { adSlots } from "./dashboard-section";

/**
 * A client's Report tab: the AI Executive Summary (fixed at the top, not a
 * removable section), then the report's sections (Paid Media, CallRail, SEO,
 * Google Analytics, Budget Pacing…), each a grid of the shared widgets. Until
 * someone customizes it, the report has one default section per connected
 * integration. Staff who may edit the client get Edit Report; everyone else
 * (client logins, shared links) sees the saved report. Everything follows the
 * page's date range, comparison and ad account filter.
 */
export async function ClientReportTab({
  rep,
  staff,
  canEdit,
  editing,
  basePath,
  query,
  editHref,
  doneHref,
  showAccountFilter = true,
}: {
  rep: ClientReport;
  staff: boolean;
  canEdit: boolean;
  editing: boolean;
  basePath: string;
  query: Record<string, string | undefined>;
  editHref: string;
  doneHref: string;
  /** Shared links have no account picker. */
  showAccountFilter?: boolean;
}) {
  const clientId = rep.client.id;
  const linked = await linkedSources(clientId);
  const platforms = [...new Set(rep.client.accounts.map((a) => a.platform as PlatformKey))];
  const layout = await loadClientReportLayout(clientId, linked, platforms);
  // Widgets of all-platform sections resolve in one pass (shared queries); each ad platform section
  // (Google Ads, Meta Ads…) resolves against that platform's accounts only.
  const base = contextFromReport(rep, linked, staff);
  const platformOf = (type: SectionType) => SECTION_TYPE[type].platform;
  const shown = layout.layout.sections;
  const shared = shown.filter((s) => !platformOf(s.type)).flatMap((s) => s.widgets);
  const byPlatform = new Map<PlatformKey, DashboardWidget[]>();
  for (const s of shown) {
    const pl = platformOf(s.type);
    if (pl) byPlatform.set(pl, [...(byPlatform.get(pl) ?? []), ...s.widgets]);
  }
  const parts = await Promise.all([
    resolveWidgets(shared, base),
    ...[...byPlatform].map(async ([pl, ws]) => resolveWidgets(ws, await scopeToPlatform(base, pl))),
  ]);
  const data = Object.assign({}, ...parts);
  const slotOpts = { rep, staff, basePath, query };
  const params = { range: query.range, compare: query.compare, from: query.from, to: query.to, accounts: query.accounts };
  const scope = rep.accountScope;

  // Staff always see the summary (marked when it's hidden from the client); clients only when it's switched on for them.
  const showSummary = staff || rep.template.sections.executive;
  const summary = showSummary ? (
    <AiSummarySection
      title={staff ? "AI Executive Summary" : "Executive Summary"}
      marker={staff && !rep.template.sections.executive ? <HiddenFromClient /> : undefined}
      actions={
        staff && canEdit ? (
          <>
            {wantsAiSummary(rep) && <RegenerateSummaryButton clientId={clientId} params={params} />}
            <ClientVisibilityToggle clientId={clientId} section="executive" visible={rep.template.sections.executive} label="Executive summary" />
          </>
        ) : undefined
      }
    >
      <ExecutiveSummary rep={rep} copyable={staff} compact bare clientFacing={!staff} />
    </AiSummarySection>
  ) : null;

  const otherCurrency = scope.otherCurrency.length > 0 && (
    <p className="text-xs text-text-3">
      Not included: {scope.otherCurrency.map((a) => `${a.name} (${a.currency})`).join(", ")}. Amounts in different currencies aren&apos;t added together; pick the account to see it on its own.
    </p>
  );

  if (editing && canEdit) {
    return (
      <div className="flex flex-col gap-3">
        {summary}
        <ReportEditor
          layout={layout.layout}
          defaults={layout.defaults}
          data={data}
          currency={rep.client.currency}
          slots={adSlots(slotOpts, "all")}
          slotsByPlatform={Object.fromEntries(platforms.map((pl) => [pl, adSlots(slotOpts, [{ kind: "campaigns" }], pl)]))}
          clientId={clientId}
          linked={linked}
          rangeParams={{ range: query.range, compare: query.compare, from: query.from, to: query.to }}
          doneHref={doneHref}
          saveAction={saveClientReportAction.bind(null, clientId)}
        />
      </div>
    );
  }

  const sections = layout.layout.sections.filter((s) => s.widgets.length > 0);
  return (
    <div className="flex flex-col gap-5">
      {summary}
      {((showAccountFilter && scope.all.length > 1) || canEdit) && (
        // The reporting area's own header: which accounts it adds up, and editing.
        <div className="-mb-2 flex flex-wrap items-center justify-between gap-2">
          {showAccountFilter && <AccountFilter accounts={scope.all} selected={scope.selected} />}
          {canEdit && (
            <Link href={editHref} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm", className: "ml-auto" })}>
              <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit Report
            </Link>
          )}
        </div>
      )}
      {canEdit && layout.newlyAvailable.length > 0 && <NewSectionsNotice clientId={clientId} types={layout.newlyAvailable} />}
      {otherCurrency}
      {sections.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-sm text-text-2">
            {canEdit ? "This report has no sections yet. Use Edit Report to add Paid Media, CallRail, SEO, Google Analytics or Budget Pacing." : "This report has no figures yet."}
          </CardContent>
        </Card>
      ) : (
        sections.map((s) => (
          <ReportSectionView key={s.id} storageKey={`${clientId}:${s.id}`} title={s.title} defaultCollapsed={s.collapsed} remove={canEdit ? { clientId, sectionId: s.id } : undefined}>
            <DashboardGrid widgets={s.widgets} data={data} currency={rep.client.currency} slots={adSlots(slotOpts, s.widgets, platformOf(s.type))} staff={staff} />
          </ReportSectionView>
        ))
      )}
      {canEdit && (
        <AddSectionMenu
          clientId={clientId}
          options={availableAddOptions(layout.layout.sections.map((s) => s.type), layout.layout.removed, availableSectionTypes(linked, platforms))}
        />
      )}
    </div>
  );
}

/** Add Section choices: every type, marked connected, already in the report, or removed earlier. */
function availableAddOptions(present: SectionType[], removed: SectionType[], available: SectionType[]) {
  return (Object.keys(SECTION_TYPE) as SectionType[]).map((t) => ({
    type: t,
    title: SECTION_TYPE[t].title,
    description: SECTION_TYPE[t].description,
    inReport: present.includes(t),
    connected: available.includes(t),
    removed: removed.includes(t) && !present.includes(t),
  }));
}
