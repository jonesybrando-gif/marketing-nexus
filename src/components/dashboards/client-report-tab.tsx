import Link from "next/link";
import { Pencil } from "lucide-react";
import type { ClientReport } from "@/server/client-report";
import { contextFromReport, resolveWidgets } from "@/server/dashboards/data";
import { linkedSources } from "@/server/dashboards/sources";
import { loadClientReportLayout } from "@/server/dashboards/report";
import { saveClientReportAction } from "@/server/dashboards/report-actions";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DashboardGrid } from "./dashboard-grid";
import { DashboardEditor } from "./dashboard-editor";
import { adSlots } from "./dashboard-section";

/**
 * A client's Report tab: their own customizable dashboard of metric widgets
 * (or the default report template until someone edits it). Staff who may edit
 * the client get Edit Dashboard; everyone else sees the finished report.
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

  if (editing && canEdit) {
    return (
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
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {canEdit && (
        <div className="flex justify-end">
          <Link href={editHref} scroll={false} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit Dashboard
          </Link>
        </div>
      )}
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
