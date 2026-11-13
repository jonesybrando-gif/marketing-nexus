"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requireClientEdit } from "../access";
import { availableSectionTypes, isSectionType, newSection, parseReportLayout, REPORT_SECTIONS_VERSION, type ReportLayout, type SectionType } from "@/lib/dashboards/report-sections";
import { DEFAULT_REPORT_TEMPLATE } from "@/lib/dashboards/report-templates";
import type { DashboardResult } from "./actions";
import { loadClientReportLayout, REPORT_ROLE } from "./report";
import { linkedSources } from "./sources";

async function store(clientId: string, agencyId: string, userId: string, layout: ReportLayout) {
  const data = layout as unknown as Prisma.InputJsonValue;
  await prisma.dashboard.upsert({
    where: { clientId_role: { clientId, role: REPORT_ROLE } },
    create: {
      agencyId,
      clientId,
      role: REPORT_ROLE,
      name: "Report",
      templateKey: DEFAULT_REPORT_TEMPLATE,
      layoutVersion: REPORT_SECTIONS_VERSION,
      clientVisible: true,
      position: -1,
      widgets: data,
      createdById: userId,
    },
    update: { widgets: data, layoutVersion: REPORT_SECTIONS_VERSION },
  });
  revalidatePath(`/clients/${clientId}`, "layout");
}

/**
 * Saves a client's Report: its sections and their widgets (its own copy; the
 * section templates and other clients are untouched). Every integration
 * available at saving time counts as known, so it isn't offered again later.
 * Staff who may edit the client only.
 */
export async function saveClientReportAction(clientId: string, layout: unknown): Promise<DashboardResult> {
  const user = await requireClientEdit(clientId);
  const parsed = parseReportLayout(layout);
  if (!parsed.ok) return parsed;
  const available = availableSectionTypes(await linkedSources(clientId));
  const present = new Set(parsed.layout.sections.map((s) => s.type));
  const next: ReportLayout = {
    ...parsed.layout,
    // A type that is back in the report is no longer "removed".
    removed: parsed.layout.removed.filter((t) => !present.has(t)),
    known: [...new Set([...parsed.layout.known, ...available])],
  };
  await store(clientId, user.agencyId, user.id, next);
  return { ok: true };
}

/** Adds the default sections for newly connected integrations to a customized report (after the user agrees). */
export async function addNewReportSectionsAction(clientId: string, types: SectionType[]): Promise<DashboardResult> {
  const user = await requireClientEdit(clientId);
  const linked = await linkedSources(clientId);
  const { layout, saved } = await loadClientReportLayout(clientId, linked);
  if (!saved) return { ok: true };
  const wanted = types.filter(isSectionType);
  const sections = [...layout.sections];
  for (const t of wanted) if (!sections.some((s) => s.type === t)) sections.push(newSection(t, sections, linked));
  await store(clientId, user.agencyId, user.id, { ...layout, sections, removed: layout.removed.filter((t) => !wanted.includes(t)), known: [...new Set([...layout.known, ...wanted])] });
  return { ok: true };
}

/** "Not now": the new integrations stay out of the report and aren't offered again (Add Section still has them). */
export async function dismissNewReportSectionsAction(clientId: string, types: SectionType[]): Promise<DashboardResult> {
  const user = await requireClientEdit(clientId);
  const { layout, saved } = await loadClientReportLayout(clientId, await linkedSources(clientId));
  if (!saved) return { ok: true };
  await store(clientId, user.agencyId, user.id, { ...layout, known: [...new Set([...layout.known, ...types.filter(isSectionType)])] });
  return { ok: true };
}
