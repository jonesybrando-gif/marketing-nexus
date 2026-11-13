import type { Dashboard } from "@prisma/client";
import type { ClientReport } from "@/server/client-report";
import { contextFromReport, resolveWidgets } from "@/server/dashboards/data";
import { linkedSources } from "@/server/dashboards/sources";
import { readWidgets } from "@/lib/dashboards/parse";
import type { DashboardWidget } from "@/lib/dashboards/types";
import type { MetricSource } from "@/lib/metrics-registry";
import type { PlatformKey } from "@/lib/platforms";
import { CampaignsSection, PacingSection } from "@/components/reports/report-sections";
import { DashboardGrid } from "./dashboard-grid";
import type { AdSlots } from "./widget-view";

export interface SlotOptions {
  rep: ClientReport;
  staff: boolean;
  basePath: string;
  query: Record<string, string | undefined>;
}

/** The existing pacing and campaign sections, rendered once for any widgets that show them. */
export function adSlots({ rep, staff, basePath, query }: SlotOptions, widgets: Pick<DashboardWidget, "kind">[] | "all", platform?: PlatformKey): AdSlots {
  const has = (k: DashboardWidget["kind"]) => widgets === "all" || widgets.some((w) => w.kind === k);
  return {
    pacing: has("pacing") ? <PacingSection rep={rep} staff={staff} basePath={basePath} query={query} showLines={false} /> : undefined,
    campaigns: has("campaigns") ? <CampaignsSection rep={rep} staff={staff} basePath={basePath} platform={platform} /> : undefined,
  };
}

/** One dashboard's widgets with their data for the report's range and comparison. */
export async function DashboardBody({ dashboard, linked, ...opts }: SlotOptions & { dashboard: Pick<Dashboard, "widgets">; linked?: MetricSource[] }) {
  const widgets = readWidgets(dashboard.widgets);
  if (widgets.length === 0) return null;
  const data = await resolveWidgets(widgets, contextFromReport(opts.rep, linked ?? (await linkedSources(opts.rep.client.id)), opts.staff));
  return <DashboardGrid widgets={widgets} data={data} currency={opts.rep.client.currency} slots={adSlots(opts, widgets)} staff={opts.staff} />;
}

type DashRow = Pick<Dashboard, "id" | "name" | "widgets">;

/**
 * Client-visible dashboards as extra report sections (client logins and
 * shared links). Callers pass only dashboards the viewer may see.
 */
export async function ClientFacingDashboards({ dashboards, ...opts }: SlotOptions & { dashboards: DashRow[] | Promise<DashRow[]> }) {
  const shown = (await dashboards).filter((d) => readWidgets(d.widgets).length > 0);
  if (shown.length === 0) return null;
  const linked = await linkedSources(opts.rep.client.id);
  return (
    <>
      {shown.map((d) => (
        <section key={d.id} aria-label={d.name} className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{d.name}</h2>
          <DashboardBody dashboard={d} linked={linked} {...opts} />
        </section>
      ))}
    </>
  );
}
