"use server";

import { PLATFORM_LABEL, type PlatformKey } from "@/lib/platforms";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requireUser } from "../auth";
import { requireAdmin, requireClientEdit } from "../access";
import { loadClientReport, type ReportParams } from "../client-report";
import { loadDashboardFor } from "./access";
import { contextFromReport, resolveWidgets, scopeToPlatform } from "./data";
import { linkedSources } from "./sources";
import { DASHBOARD_TEMPLATES } from "@/lib/dashboards/templates";
import { cleanName, copyWidgets, planTemplateApplication, resolveTemplateChoices, uniqueName } from "@/lib/dashboards/apply";
import { parseWidgets, readWidgets } from "@/lib/dashboards/parse";
import { canManageDashboardTemplates } from "@/lib/dashboards/access";
import type { WidgetData } from "@/lib/dashboards/widget-data";

export type DashboardResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };
export type CreateDashboardState = { error?: string } | undefined;

const json = (v: unknown) => v as Prisma.InputJsonValue;

function revalidateClient(clientId: string | null) {
  if (clientId) revalidatePath(`/clients/${clientId}`, "layout");
  revalidatePath("/r/[token]", "page");
  revalidatePath("/settings/dashboards", "layout");
}

async function agencyTemplates(agencyId: string) {
  return prisma.dashboard.findMany({ where: { agencyId, isTemplate: true }, select: { id: true, name: true, widgets: true, defaultRange: true }, orderBy: { name: "asc" } });
}

/** New client dashboard, blank or from a template ("blank" | "builtin:<key>" | "agency:<id>"). */
export async function createDashboardAction(clientId: string, _prev: CreateDashboardState, form: FormData): Promise<CreateDashboardState> {
  const user = await requireClientEdit(clientId);
  const choices = form.getAll("template").map(String);
  const tpl = resolveTemplateChoices(choices, DASHBOARD_TEMPLATES, choices.some((c) => c.startsWith("agency:")) ? await agencyTemplates(user.agencyId) : []);
  if (!tpl) return { error: "One of those templates no longer exists. Pick again." };
  const existing = await prisma.dashboard.findMany({ where: { clientId, isTemplate: false }, select: { name: true, position: true } });
  const typed = String(form.get("name") ?? "").trim();
  const [plan] = planTemplateApplication(
    { ...tpl, name: typed || tpl.name },
    [{ clientId, existingNames: existing.map((d) => d.name), maxPosition: existing.reduce((m, d) => Math.max(m, d.position), -1) }],
  );
  const d = await prisma.dashboard.create({
    data: { agencyId: user.agencyId, clientId, name: plan.name, position: plan.position, defaultRange: plan.defaultRange, widgets: json(plan.widgets), createdById: user.id, clientVisible: form.get("clientVisible") !== "off" },
  });
  revalidateClient(clientId);
  redirect(plan.widgets.length ? `/clients/${clientId}?tab=reports&d=${d.id}` : `/clients/${clientId}/dashboards/${d.id}/edit`);
}

export async function renameDashboardAction(id: string, name: string): Promise<DashboardResult> {
  const user = await requireUser();
  const d = await loadDashboardFor(user, id, "edit");
  if (!d) return { ok: false, error: "Dashboard not found." };
  const clean = cleanName(name, "");
  if (!clean) return { ok: false, error: "Enter a name." };
  await prisma.dashboard.update({ where: { id: d.id }, data: { name: clean } });
  revalidateClient(d.clientId);
  return { ok: true };
}

export async function deleteDashboardAction(id: string): Promise<DashboardResult> {
  const user = await requireUser();
  const d = await loadDashboardFor(user, id, "edit");
  if (!d) return { ok: false, error: "Dashboard not found." };
  await prisma.dashboard.delete({ where: { id: d.id } });
  revalidateClient(d.clientId);
  return { ok: true };
}

export async function duplicateDashboardAction(id: string): Promise<DashboardResult<{ id: string }>> {
  const user = await requireUser();
  const d = await loadDashboardFor(user, id, "edit");
  if (!d) return { ok: false, error: "Dashboard not found." };
  const siblings = await prisma.dashboard.findMany({ where: d.isTemplate ? { agencyId: d.agencyId, isTemplate: true } : { clientId: d.clientId, isTemplate: false }, select: { name: true, position: true } });
  const copy = await prisma.dashboard.create({
    data: {
      agencyId: d.agencyId,
      clientId: d.clientId,
      isTemplate: d.isTemplate,
      name: uniqueName(`${d.name} copy`, siblings.map((s) => s.name)),
      position: siblings.reduce((m, s) => Math.max(m, s.position), -1) + 1,
      clientVisible: d.clientVisible,
      defaultRange: d.defaultRange,
      widgets: json(copyWidgets(readWidgets(d.widgets))),
      createdById: user.id,
    },
  });
  revalidateClient(d.clientId);
  return { ok: true, id: copy.id };
}

/** Sets the tab order of a client's dashboards (ids in the new order). */
export async function reorderDashboardsAction(clientId: string, ids: string[]): Promise<DashboardResult> {
  const user = await requireClientEdit(clientId);
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) return { ok: false, error: "Invalid order." };
  const own = await prisma.dashboard.findMany({ where: { clientId, agencyId: user.agencyId, isTemplate: false }, select: { id: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  const ownIds = new Set(own.map((d) => d.id));
  // Unknown ids are ignored; dashboards missing from the list keep their relative order at the end.
  const order = [...new Set(ids.filter((i) => ownIds.has(i))), ...own.map((d) => d.id).filter((i) => !ids.includes(i))];
  await prisma.$transaction(order.map((id, position) => prisma.dashboard.update({ where: { id }, data: { position } })));
  revalidateClient(clientId);
  return { ok: true };
}

export async function setDashboardVisibilityAction(id: string, visible: boolean): Promise<DashboardResult> {
  const user = await requireUser();
  const d = await loadDashboardFor(user, id, "edit");
  if (!d || d.isTemplate) return { ok: false, error: "Dashboard not found." };
  await prisma.dashboard.update({ where: { id: d.id }, data: { clientVisible: !!visible } });
  revalidateClient(d.clientId);
  return { ok: true };
}

/** Saves the editor's widgets after validating them (12-column grid, at most 100). */
export async function saveDashboardWidgetsAction(id: string, widgets: unknown, name?: string): Promise<DashboardResult> {
  const user = await requireUser();
  const d = await loadDashboardFor(user, id, "edit");
  if (!d) return { ok: false, error: "Dashboard not found." };
  const parsed = parseWidgets(widgets);
  if (!parsed.ok) return parsed;
  const clean = name === undefined ? d.name : cleanName(name, d.name);
  await prisma.dashboard.update({ where: { id: d.id }, data: { widgets: json(parsed.widgets), name: clean } });
  revalidateClient(d.clientId);
  return { ok: true };
}

/** Copies a client dashboard into an agency template (no client). Admins only. */
export async function saveAsTemplateAction(id: string, name: string): Promise<DashboardResult<{ id: string }>> {
  const user = await requireUser();
  if (!canManageDashboardTemplates(user)) return { ok: false, error: "Only agency admins can save templates." };
  const d = await loadDashboardFor(user, id, "edit");
  if (!d) return { ok: false, error: "Dashboard not found." };
  const existing = await prisma.dashboard.findMany({ where: { agencyId: user.agencyId, isTemplate: true }, select: { name: true } });
  const t = await prisma.dashboard.create({
    data: {
      agencyId: user.agencyId,
      clientId: null,
      isTemplate: true,
      clientVisible: true,
      name: uniqueName(cleanName(name, d.name), existing.map((e) => e.name)),
      defaultRange: d.defaultRange,
      widgets: json(copyWidgets(readWidgets(d.widgets))),
      createdById: user.id,
    },
  });
  revalidatePath("/settings/dashboards", "layout");
  return { ok: true, id: t.id };
}

/** Copies an agency template to each selected client as a new dashboard. Admins only. */
export async function applyTemplateAction(templateId: string, clientIds: string[]): Promise<DashboardResult<{ count: number }>> {
  const admin = await requireAdmin();
  const t = await prisma.dashboard.findFirst({ where: { id: templateId, agencyId: admin.agencyId, isTemplate: true } });
  if (!t) return { ok: false, error: "Template not found." };
  if (!Array.isArray(clientIds) || clientIds.length === 0) return { ok: false, error: "Pick at least one client." };
  const clients = await prisma.client.findMany({
    where: { id: { in: clientIds.filter((c) => typeof c === "string").slice(0, 500) }, agencyId: admin.agencyId, archivedAt: null },
    select: { id: true, dashboards: { where: { isTemplate: false }, select: { name: true, position: true } } },
  });
  if (!clients.length) return { ok: false, error: "None of those clients were found." };
  const plans = planTemplateApplication(
    { name: t.name, widgets: readWidgets(t.widgets), defaultRange: t.defaultRange },
    clients.map((c) => ({ clientId: c.id, existingNames: c.dashboards.map((d) => d.name), maxPosition: c.dashboards.reduce((m, d) => Math.max(m, d.position), -1) })),
  );
  await prisma.dashboard.createMany({
    data: plans.map((p) => ({ agencyId: admin.agencyId, clientId: p.clientId, name: p.name, position: p.position, defaultRange: p.defaultRange, widgets: json(p.widgets), clientVisible: true, createdById: admin.id })),
  });
  for (const p of plans) revalidatePath(`/clients/${p.clientId}`, "layout");
  revalidatePath("/r/[token]", "page");
  return { ok: true, count: plans.length };
}

/** New agency template, blank or from a built-in template. Admins only. */
export async function createTemplateAction(_prev: CreateDashboardState, form: FormData): Promise<CreateDashboardState> {
  const admin = await requireAdmin();
  const choices = form.getAll("template").map(String);
  const tpl = resolveTemplateChoices(choices, DASHBOARD_TEMPLATES, []);
  if (!tpl) return { error: "One of those templates no longer exists." };
  const blank = tpl.widgets.length === 0;
  const existing = await prisma.dashboard.findMany({ where: { agencyId: admin.agencyId, isTemplate: true }, select: { name: true } });
  const typed = String(form.get("name") ?? "").trim();
  const t = await prisma.dashboard.create({
    data: {
      agencyId: admin.agencyId,
      clientId: null,
      isTemplate: true,
      name: uniqueName(typed || (blank ? "New template" : tpl.name), existing.map((e) => e.name)),
      widgets: json(copyWidgets(tpl.widgets)),
      createdById: admin.id,
    },
  });
  revalidatePath("/settings/dashboards", "layout");
  redirect(`/settings/dashboards/${t.id}`);
}

/** Data for one widget while editing (added or changed, not yet saved). */
export async function previewWidgetAction(clientId: string, widget: unknown, params: ReportParams, platform?: string): Promise<WidgetData> {
  await requireClientEdit(clientId);
  const parsed = parseWidgets([widget]);
  if (!parsed.ok) return { kind: "empty", reason: "no_data", source: null, message: parsed.error };
  const p = params && typeof params === "object" ? params : {};
  const [rep, linked] = await Promise.all([
    loadClientReport(clientId, { range: p.range, compare: p.compare, from: p.from, to: p.to }),
    linkedSources(clientId),
  ]);
  const base = contextFromReport(rep, linked);
  // A widget in an ad platform section (Google Ads, Meta Ads…) previews that platform only.
  const ctx = platform && platform in PLATFORM_LABEL ? await scopeToPlatform(base, platform as PlatformKey) : base;
  const data = await resolveWidgets(parsed.widgets, ctx);
  return data[parsed.widgets[0].id];
}

/**
 * Opens a client's dashboard for one built-in template (e.g. CallRail), making
 * it first if the client doesn't have one yet. Used by the Overview's
 * "Connected data" cards. New ones start hidden from the client.
 */
export async function openTemplateDashboardAction(clientId: string, templateKey: string): Promise<void> {
  const user = await requireClientEdit(clientId);
  const tpl = DASHBOARD_TEMPLATES.find((t) => t.key === templateKey);
  if (!tpl) redirect(`/clients/${clientId}?tab=reports`);
  const existing = await prisma.dashboard.findMany({ where: { clientId, isTemplate: false }, select: { id: true, name: true, position: true } });
  let id = existing.find((d) => d.name.toLowerCase() === tpl.name.toLowerCase())?.id;
  if (!id) {
    const [plan] = planTemplateApplication(tpl, [{ clientId, existingNames: existing.map((d) => d.name), maxPosition: existing.reduce((m, d) => Math.max(m, d.position), -1) }]);
    const d = await prisma.dashboard.create({
      data: { agencyId: user.agencyId, clientId, name: plan.name, position: plan.position, defaultRange: plan.defaultRange, widgets: json(plan.widgets), createdById: user.id, clientVisible: false },
    });
    id = d.id;
    revalidateClient(clientId);
  }
  redirect(`/clients/${clientId}?tab=reports&d=${id}`);
}
