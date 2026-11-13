import Link from "next/link";
import { Pencil } from "lucide-react";
import type { ClientReport } from "@/server/client-report";
import { contextFromReport, resolveWidgets } from "@/server/dashboards/data";
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
import { DashboardEditor } from "./dashboard-editor";
import { adSlots } from "./dashboard-section";

/**
 * A client's Report tab: the AI Executive Summary (a fixed, collapsible
 * section, not a widget), then their own customizable dashboard of metric and
 * chart widgets (or the default report template until someone edits it).
 * Staff who may edit the client get Edit Dashboard; everyone else sees the
 * finished report. Everything follows the page's date range, comparison and
 * ad account filter.
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
}: {
  rep: ClientReport;
  staff: boolean;
  canEdit: boolean;
  editing: boolean;
  basePath: string;
  query: Record<string, string | undefined>;
  editHref: string;
  doneHref: string;
}) {
  const clientId = rep.client.id;
  const linked = await linkedSources(clientId);
  const layout = await loadClientReportLayout(clientId, linked);
  const data = await resolveWidgets(layout.widgets, contextFromReport(rep, linked, staff));
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
      <DashboardEditor
        dashboardId={layout.saved?.id ?? null}
        name="Report"
        heading="Editing the Report"
        widgets={layout.widgets}
        data={data}
        currency={rep.client.currency}
        slots={adSlots(slotOpts, "all")}
        clientId={clientId}
        linked={linked}
        rangeParams={{ range: query.range, compare: query.compare, from: query.from, to: query.to }}
        doneHref={doneHref}
        saveAction={saveClientReportAction.bind(null, clientId)}
        resetWidgets={layout.defaults}
      />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {summary}
      {(canEdit || scope.all.length > 1) && (
        // The reporting area's own header: which accounts it adds up, and editing.
        <div className="flex flex-wrap items-center justify-between gap-2">
          <AccountFilter accounts={scope.all} selected={scope.selected} />
          {canEdit && (
            <Link href={editHref} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm", className: "ml-auto" })}>
              <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit Dashboard
            </Link>
          )}
        </div>
      )}
      {otherCurrency}
      {layout.widgets.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-sm text-text-2">
            {canEdit ? "This report has no widgets yet. Use Edit Dashboard to add some." : "This report has no figures yet."}
          </CardContent>
        </Card>
      ) : (
        <DashboardGrid widgets={layout.widgets} data={data} currency={rep.client.currency} slots={adSlots(slotOpts, layout.widgets)} staff={staff} />
      )}
    </div>
  );
}
