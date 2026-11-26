import "server-only";
import { notFound, redirect } from "next/navigation";
import { prisma } from "./db";
import { requireUser } from "./auth";
import { canEditClient, canViewAgencyDashboard, canViewClient, type SessionUser } from "@/lib/access";

export { visibleClientsWhere } from "./client-scope";

async function loadClientFacts(clientId: string) {
  // Removed (archived) clients are hidden everywhere until restored.
  const c = await prisma.client.findFirst({
    where: { id: clientId, archivedAt: null },
    select: { id: true, agencyId: true, primaryManagerId: true, assignments: { select: { userId: true } } },
  });
  return c && { id: c.id, agencyId: c.agencyId, primaryManagerId: c.primaryManagerId, assignedUserIds: c.assignments.map((a) => a.userId) };
}

/** Non-throwing check for route handlers. */
export async function userCanViewClient(user: SessionUser, clientId: string): Promise<boolean> {
  const facts = await loadClientFacts(clientId);
  return !!facts && canViewClient(user, facts);
}

/** Non-throwing twin of requireClientEdit, for showing or hiding edit controls. */
export async function userCanEditClient(user: SessionUser, clientId: string): Promise<boolean> {
  if (user.role === "CLIENT_USER") return false; // no lookup needed: client logins never edit
  const facts = await loadClientFacts(clientId);
  return !!facts && canEditClient(user, facts);
}

/** 404s (rather than 403s) so the existence of other clients is not revealed. */
export async function requireClientView(clientId: string): Promise<SessionUser> {
  const user = await requireUser();
  const facts = await loadClientFacts(clientId);
  if (!facts || !canViewClient(user, facts)) notFound();
  return user;
}

export async function requireClientEdit(clientId: string): Promise<SessionUser> {
  const user = await requireUser();
  const facts = await loadClientFacts(clientId);
  if (!facts || !canEditClient(user, facts)) notFound();
  return user;
}

export async function requireAgencyStaff(): Promise<SessionUser> {
  const user = await requireUser();
  if (!canViewAgencyDashboard(user)) redirect(user.clientId ? `/clients/${user.clientId}` : "/login");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "AGENCY_ADMIN") notFound();
  return user;
}
