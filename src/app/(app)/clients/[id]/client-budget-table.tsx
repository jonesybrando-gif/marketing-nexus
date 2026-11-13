import { prisma } from "@/server/db";
import { loadBudgetPacingRows, resolveMonth } from "@/server/budget-pacing";
import type { SessionUser } from "@/lib/access";
import { todayInTimeZone } from "@/lib/pacing/dates";
import { formatDate } from "@/lib/time";
import { getClientPerformance } from "@/server/reporting";
import { loadPacing } from "@/server/pacing-service";
import { PLATFORM_LABEL, type PlatformKey } from "@/lib/platforms";
import { formatMoney } from "@/lib/money";
import { displayCampaignName } from "@/lib/campaign-name";
import { BudgetPacingTable, type CampaignBudgetLine } from "../budget-pacing-table";
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
  const where = { id: clientId, agencyId: user.agencyId, archivedAt: null };
  const [rows, pacing] = await Promise.all([loadBudgetPacingRows(where, month), loadPacing(where, new Date(), month.isCurrent ? undefined : month.start)]);
  // Budgets set per account or campaign beneath a combined budget (sub-allocations), by platform.
  const campaignBudgets: CampaignBudgetLine[] = (pacing[0]?.subRows ?? [])
    .filter((sr) => sr.level === "CAMPAIGNS" && sr.result && sr.accounts.length === 1 && sr.platforms.length === 1)
    .map((sr) => ({
      key: sr.key,
      name: displayCampaignName(sr.label),
      platform: sr.platforms[0],
      accountId: sr.accounts[0].id,
      budgetMinor: sr.result!.budgetMinor,
      spendMinor: sr.notConnected ? null : sr.result!.actualToDateMinor,
      elapsedFraction: sr.result!.totalDays ? Math.min(1, sr.result!.elapsedDays / sr.result!.totalDays) : null,
    }))
    .sort((a, b) => b.budgetMinor - a.budgetMinor);
  const subBudget = new Map<PlatformKey, number>();
  for (const sr of pacing[0]?.subRows ?? []) {
    if (!sr.result || sr.platforms.length !== 1) continue;
    subBudget.set(sr.platforms[0], (subBudget.get(sr.platforms[0]) ?? 0) + sr.result.budgetMinor);
  }
  const m = { key: month.key, label: monthLabel(month.key) };

  // A budget shared by several platforms can't be split, but its spend can:
  // each platform's synced spend over the same days the budget counts.
  const platformOf = new Map(client.accounts.map((a) => [a.id, a.platform as PlatformKey]));
  const platformSpend: Record<string, { platform: PlatformKey; budgetMinor: number | null; spendMinor: number | null }[]> = {};
  await Promise.all(
    rows
      .filter((r) => r.platforms.length > 1 && (r.accountIds?.length ?? 0) > 1)
      .map(async (r) => {
        const perf = await getClientPerformance(clientId, { from: month.start, to: r.asOf && r.asOf <= month.end ? r.asOf : month.end }, r.accountIds);
        const byPlatform = new Map<PlatformKey, number | null>(r.platforms.map((p) => [p, null]));
        for (const id of r.accountIds ?? []) {
          const p = platformOf.get(id);
          const t = perf.byAccount[id];
          if (p && t) byPlatform.set(p, (byPlatform.get(p) ?? 0) + t.costMinor);
        }
        platformSpend[r.key] = [...byPlatform.entries()]
          .map(([platform, spendMinor]) => ({ platform, budgetMinor: subBudget.get(platform) ?? null, spendMinor }))
          .sort((a, b) => (b.budgetMinor ?? -1) - (a.budgetMinor ?? -1) || (b.spendMinor ?? -1) - (a.spendMinor ?? -1));
      }),
  );
  const fmt = (m: number) => formatMoney(m, client.currency, { whole: true });
  const notes: string[] = [];
  for (const r of rows) {
    const parts = platformSpend[r.key];
    if (!parts || r.budgetMinor === null) continue;
    const missing = parts.filter((x) => x.budgetMinor === null).map((x) => PLATFORM_LABEL[x.platform]);
    const sum = parts.reduce((a, x) => a + (x.budgetMinor ?? 0), 0);
    if (missing.length) notes.push(`No separate budget is set for ${missing.join(" and ")}, so ${missing.length === 1 ? "it is" : "they are"} paced only within the combined budget.`);
    else if (sum !== r.budgetMinor) notes.push(`The platform budgets add up to ${fmt(sum)}, but the combined budget is ${fmt(r.budgetMinor)}.`);
  }
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
        overview={{ currency: client.currency, rangeNote, notes }}
        platformSpend={platformSpend}
        campaignBudgets={campaignBudgets}
      />
    </section>
  );
}
