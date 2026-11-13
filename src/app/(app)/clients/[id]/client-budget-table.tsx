import { prisma } from "@/server/db";
import { loadBudgetPacingRows, resolveMonth } from "@/server/budget-pacing";
import type { SessionUser } from "@/lib/access";
import { todayInTimeZone } from "@/lib/pacing/dates";
import { BudgetPacingTable } from "../budget-pacing-table";
import { monthLabel } from "../budgets-view";

/** This client's rows from Budget Pacing (this month): budget, spend, what's left, pacing and the daily adjustment. */
export async function ClientBudgetTable({ clientId, user, canEdit }: { clientId: string; user: SessionUser; canEdit: boolean }) {
  const agency = await prisma.agency.findUniqueOrThrow({ where: { id: user.agencyId }, select: { defaultTimezone: true } });
  const month = resolveMonth(undefined, todayInTimeZone(agency.defaultTimezone));
  const rows = await loadBudgetPacingRows({ id: clientId, agencyId: user.agencyId, archivedAt: null }, month);
  const m = { key: month.key, label: monthLabel(month.key) };
  return (
    <section aria-label="This month's budgets" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">{m.label}</h2>
      <BudgetPacingTable rows={rows} month={m} months={[m]} editable={{ [clientId]: canEdit }} variant="client" />
    </section>
  );
}
