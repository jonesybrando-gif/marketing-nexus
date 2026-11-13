import type { SessionUser } from "@/lib/access";
import { canEditClient } from "@/lib/access";
import { prisma } from "@/server/db";
import { visibleClientsWhere } from "@/server/access";
import { loadBudgetPacingRows } from "@/server/budget-pacing";
import { addDays } from "@/lib/pacing/dates";
import { formatDate } from "@/lib/time";
import { BudgetPacingTable, type MonthOption } from "./budget-pacing-table";

export const monthLabel = (key: string) => formatDate(`${key}-01`, { month: "long", year: "numeric" });

/**
 * Clients › Budgets ("Budget Pacing"): one table, one row per client and
 * platform for the chosen month. Detail (charts, pacing maths, budget history,
 * sync status) lives in each client's Budgets tab.
 */
export async function BudgetsView({ user, month, currentKey }: { user: SessionUser; month: { key: string; start: string; end: string; isCurrent: boolean }; currentKey: string }) {
  const visible = visibleClientsWhere(user);
  const [rows, clients, labels] = await Promise.all([
    loadBudgetPacingRows(visible, month),
    prisma.client.findMany({ where: visible, select: { id: true, agencyId: true, primaryManagerId: true, assignments: { select: { userId: true } }, labels: { select: { id: true } } } }),
    prisma.clientLabel.findMany({ where: { agencyId: user.agencyId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const labelsByClient = Object.fromEntries(clients.map((c) => [c.id, c.labels.map((l) => l.id)]));
  const editable = Object.fromEntries(
    clients.map((c) => [c.id, canEditClient(user, { id: c.id, agencyId: c.agencyId, primaryManagerId: c.primaryManagerId, assignedUserIds: c.assignments.map((a) => a.userId) })]),
  );
  // This month and the 23 before it.
  const months: MonthOption[] = [];
  let d = `${currentKey}-01`;
  for (let i = 0; i < 24; i++) {
    months.push({ key: d.slice(0, 7), label: monthLabel(d.slice(0, 7)) });
    d = `${addDays(d, -1).slice(0, 7)}-01`;
  }
  if (!months.some((m) => m.key === month.key) && month.key < currentKey) months.push({ key: month.key, label: monthLabel(month.key) });

  return <BudgetPacingTable rows={rows} month={{ key: month.key, label: monthLabel(month.key) }} months={months} editable={editable} labels={labels} labelsByClient={labelsByClient} />;
}
