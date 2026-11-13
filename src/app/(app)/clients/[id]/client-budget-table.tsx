import { prisma } from "@/server/db";
import { loadBudgetPacingRows, resolveMonth } from "@/server/budget-pacing";
import type { SessionUser } from "@/lib/access";
import { todayInTimeZone } from "@/lib/pacing/dates";
import { formatDate } from "@/lib/time";
import { BudgetPacingTable } from "../budget-pacing-table";
import { monthLabel } from "../budgets-view";

/**
 * This client's budgets for the calendar month: the overview (budget, spent,
 * remaining and the pacing bar), then one row per account with inline budget
 * edits. Budgets always use the calendar month, whatever range the page shows.
 */
export async function ClientBudgetTable({ clientId, user, canEdit, range }: { clientId: string; user: SessionUser; canEdit: boolean; range?: { from: string; to: string } }) {
  const [agency, client] = await Promise.all([
    prisma.agency.findUniqueOrThrow({ where: { id: user.agencyId }, select: { defaultTimezone: true } }),
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { currency: true, accounts: { select: { id: true, name: true } } } }),
  ]);
  const month = resolveMonth(undefined, todayInTimeZone(agency.defaultTimezone));
  const rows = await loadBudgetPacingRows({ id: clientId, agencyId: user.agencyId, archivedAt: null }, month);
  const m = { key: month.key, label: monthLabel(month.key) };
  const fullMonth = !range || (range.from === month.start && range.to >= month.start && range.to <= month.end && range.to.slice(0, 7) === month.key);
  const rangeNote = fullMonth ? null : `Budgets follow the calendar month (${m.label}), so they don't change with the page's date range (${formatDate(range!.from)} to ${formatDate(range!.to)}).`;
  return (
    <section aria-label={`${m.label} budgets`} className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">{m.label}</h2>
      <BudgetPacingTable
        rows={rows}
        month={m}
        months={[m]}
        editable={{ [clientId]: canEdit }}
        variant="client"
        accountNames={Object.fromEntries(client.accounts.map((a) => [a.id, a.name]))}
        overview={{ currency: client.currency, rangeNote }}
      />
    </section>
  );
}
