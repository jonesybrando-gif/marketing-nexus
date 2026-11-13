import { prisma } from "@/server/db";
import { loadBudgetPacingRows, resolveMonth } from "@/server/budget-pacing";
import type { SessionUser } from "@/lib/access";
import { todayInTimeZone } from "@/lib/pacing/dates";
import { formatDate } from "@/lib/time";
import { getClientPerformance } from "@/server/reporting";
import type { PlatformKey } from "@/lib/platforms";
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
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { currency: true, accounts: { select: { id: true, name: true, platform: true } } } }),
  ]);
  const month = resolveMonth(undefined, todayInTimeZone(agency.defaultTimezone));
  const rows = await loadBudgetPacingRows({ id: clientId, agencyId: user.agencyId, archivedAt: null }, month);
  const m = { key: month.key, label: monthLabel(month.key) };

  // A budget shared by several platforms can't be split, but its spend can:
  // each platform's synced spend over the same days the budget counts.
  const platformOf = new Map(client.accounts.map((a) => [a.id, a.platform as PlatformKey]));
  const platformSpend: Record<string, { platform: PlatformKey; spendMinor: number | null; share: number | null }[]> = {};
  await Promise.all(
    rows
      .filter((r) => r.platforms.length > 1 && r.spendMinor !== null && (r.accountIds?.length ?? 0) > 1)
      .map(async (r) => {
        const perf = await getClientPerformance(clientId, { from: month.start, to: r.asOf && r.asOf <= month.end ? r.asOf : month.end }, r.accountIds);
        const byPlatform = new Map<PlatformKey, number | null>(r.platforms.map((p) => [p, null]));
        for (const id of r.accountIds ?? []) {
          const p = platformOf.get(id);
          const t = perf.byAccount[id];
          if (p && t) byPlatform.set(p, (byPlatform.get(p) ?? 0) + t.costMinor);
        }
        const sum = [...byPlatform.values()].reduce<number>((a, v) => a + (v ?? 0), 0);
        platformSpend[r.key] = [...byPlatform.entries()]
          .map(([platform, spendMinor]) => ({ platform, spendMinor, share: sum > 0 && spendMinor !== null ? spendMinor / sum : null }))
          .sort((a, b) => (b.spendMinor ?? -1) - (a.spendMinor ?? -1));
      }),
  );
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
        platformSpend={platformSpend}
      />
    </section>
  );
}
