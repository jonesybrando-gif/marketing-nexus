import "server-only";
import type { Dashboard } from "@prisma/client";
import { prisma } from "../db";
import type { MetricSource } from "@/lib/metrics-registry";
import type { PlatformKey } from "@/lib/platforms";
import { defaultReportLayout, newlyAvailableSections, readReportLayout, type ReportLayout, type SectionType } from "@/lib/dashboards/report-sections";

export const REPORT_ROLE = "REPORT";

export interface ClientReportLayout {
  /** The client's saved Report, or null while it still follows the defaults. */
  saved: Dashboard | null;
  /** What the Report shows: the saved sections, or the default sections for the connected integrations. */
  layout: ReportLayout;
  /** Default sections for this client's integrations (Reset to Default). */
  defaults: ReportLayout;
  /** Integrations connected since the report was customized, to offer (never added without asking). */
  newlyAvailable: SectionType[];
}

/**
 * A client's Report layout. Each client has at most one saved Report
 * (Dashboard role "REPORT"); until someone customizes it the client follows
 * the default sections, rebuilt from its connected integrations on every
 * load, so a newly connected integration appears automatically.
 */
export async function loadClientReportLayout(clientId: string, linked: MetricSource[], platforms?: PlatformKey[]): Promise<ClientReportLayout> {
  const saved = await prisma.dashboard.findFirst({ where: { clientId, role: REPORT_ROLE, isTemplate: false } });
  const defaults = defaultReportLayout(linked, platforms);
  const layout = saved ? readReportLayout(saved.widgets, saved.layoutVersion) : defaults;
  return { saved, layout, defaults, newlyAvailable: saved ? newlyAvailableSections(layout, linked, platforms) : [] };
}
