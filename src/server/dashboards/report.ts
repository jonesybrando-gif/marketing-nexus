import "server-only";
import type { Dashboard } from "@prisma/client";
import { prisma } from "../db";
import type { MetricSource } from "@/lib/metrics-registry";
import type { DashboardWidget } from "@/lib/dashboards/types";
import { readWidgets } from "@/lib/dashboards/parse";
import { buildReportWidgets, reportTemplate } from "@/lib/dashboards/report-templates";

export const REPORT_ROLE = "REPORT";

export interface ClientReportLayout {
  /** The client's saved Report, or null while it still follows its template. */
  saved: Dashboard | null;
  /** What the Report shows: the saved widgets, or the template's. */
  widgets: DashboardWidget[];
  /** The template's widgets for this client's sources (Reset to default). */
  defaults: DashboardWidget[];
  templateKey: string;
}

/**
 * A client's Report tab layout. Each client has at most one saved Report
 * (Dashboard role "REPORT"); until it is edited the client follows the
 * default report template, built from the sources it has connected.
 */
export async function loadClientReportLayout(clientId: string, linked: MetricSource[]): Promise<ClientReportLayout> {
  const saved = await prisma.dashboard.findFirst({ where: { clientId, role: REPORT_ROLE, isTemplate: false } });
  const template = reportTemplate(saved?.templateKey);
  const defaults = buildReportWidgets(template, linked);
  return { saved, widgets: saved ? readWidgets(saved.widgets) : defaults, defaults, templateKey: template.key };
}
