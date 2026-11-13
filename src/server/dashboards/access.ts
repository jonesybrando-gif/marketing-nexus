import "server-only";
import type { Dashboard } from "@prisma/client";
import { prisma } from "../db";
import type { ClientAccessFacts, SessionUser } from "@/lib/access";
import { canEditDashboard, canViewDashboard, sharedReportShows } from "@/lib/dashboards/access";

// Server side of the dashboard permission rules in src/lib/dashboards/access.ts.

async function clientFacts(clientId: string | null): Promise<ClientAccessFacts | null> {
  if (!clientId) return null;
  const c = await prisma.client.findFirst({
    where: { id: clientId, archivedAt: null },
    select: { id: true, agencyId: true, primaryManagerId: true, assignments: { select: { userId: true } } },
  });
  return c && { id: c.id, agencyId: c.agencyId, primaryManagerId: c.primaryManagerId, assignedUserIds: c.assignments.map((a) => a.userId) };
}

/** The dashboard if `user` may open it (view) or change it (edit); null otherwise (callers 404). */
export async function loadDashboardFor(user: SessionUser, id: string, mode: "view" | "edit"): Promise<Dashboard | null> {
  if (typeof id !== "string" || !id) return null;
  const d = await prisma.dashboard.findFirst({ where: { id, agencyId: user.agencyId } });
  if (!d) return null;
  const facts = await clientFacts(d.clientId);
  const ok = mode === "edit" ? canEditDashboard(user, d, facts) : canViewDashboard(user, d, facts);
  return ok ? d : null;
}

/**
 * A client's dashboards in tab order. Staff see all of them; client logins
 * only client-visible ones. Callers must already have checked the user may
 * view the client (requireClientView).
 */
export async function listClientDashboards(user: SessionUser, clientId: string) {
  return prisma.dashboard.findMany({
    // The Report tab's own dashboard (role REPORT) is shown as the Report, not in this list.
    where: { clientId, agencyId: user.agencyId, isTemplate: false, role: null, ...(user.role === "CLIENT_USER" ? { clientVisible: true } : {}) },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}

/** Dashboards a shared report link may show: the link's client's client-visible ones only. */
export async function sharedReportDashboards(clientId: string) {
  const rows = await prisma.dashboard.findMany({
    where: { clientId, isTemplate: false, clientVisible: true, role: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return rows.filter((d) => sharedReportShows(d, clientId)); // belt and braces over the query
}
