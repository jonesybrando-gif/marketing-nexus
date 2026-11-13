"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requireClientEdit } from "../access";
import { parseWidgets } from "@/lib/dashboards/parse";
import { DEFAULT_REPORT_TEMPLATE, REPORT_LAYOUT_VERSION } from "@/lib/dashboards/report-templates";
import type { DashboardResult } from "./actions";
import { REPORT_ROLE } from "./report";

/**
 * Saves a client's Report tab layout (its own copy; the template and other
 * clients are untouched). Staff who may edit the client only.
 */
export async function saveClientReportAction(clientId: string, widgets: unknown): Promise<DashboardResult> {
  const user = await requireClientEdit(clientId);
  const parsed = parseWidgets(widgets);
  if (!parsed.ok) return parsed;
  const data = parsed.widgets as unknown as Prisma.InputJsonValue;
  await prisma.dashboard.upsert({
    where: { clientId_role: { clientId, role: REPORT_ROLE } },
    create: {
      agencyId: user.agencyId,
      clientId,
      role: REPORT_ROLE,
      name: "Report",
      templateKey: DEFAULT_REPORT_TEMPLATE,
      layoutVersion: REPORT_LAYOUT_VERSION,
      clientVisible: true,
      position: -1,
      widgets: data,
      createdById: user.id,
    },
    update: { widgets: data, layoutVersion: REPORT_LAYOUT_VERSION },
  });
  revalidatePath(`/clients/${clientId}`, "layout");
  return { ok: true };
}
