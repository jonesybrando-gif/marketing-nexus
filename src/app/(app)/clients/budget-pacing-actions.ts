"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/server/db";
import { requireClientEdit } from "@/server/access";
import { validateNewBudget, validateRevision } from "@/lib/budget-validation";
import { parseMoneyToMinor } from "@/lib/money";
import { dateToIso, isoToDate, maxDate, minDate, monthBounds, todayInTimeZone } from "@/lib/pacing/dates";

export type SaveBudgetResult = { ok: true; amountMinor: number } | { ok: false; error: string };

const schema = z.object({
  clientId: z.string().min(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  amount: z.string(),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("revise"), budgetId: z.string().min(1) }),
    z.object({ kind: z.literal("create"), accountId: z.string().min(1) }),
  ]),
});

/**
 * Inline edit from the Budget Pacing page. Changes only Marketing Nexus's own
 * budget record for this client, platform and month — never a budget inside
 * Google, Meta or Microsoft.
 * - An existing budget gets a new revision, so its history stays in the
 *   client's budget view; the newest revision is the month's budget.
 * - A platform with spend but no budget gets a new account budget for that
 *   month, repeating monthly like budgets added on the client's budget page.
 */
export async function saveMonthlyBudget(input: unknown): Promise<SaveBudgetResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That budget couldn't be saved." };
  const { clientId, month, amount, target } = parsed.data;
  const user = await requireClientEdit(clientId);

  if (!amount.trim()) return { ok: false, error: "Enter a budget amount." };
  if (/^\s*-/.test(amount)) return { ok: false, error: "Budgets can't be negative." };
  let amountMinor: number;
  try {
    amountMinor = parseMoneyToMinor(amount);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor > 100_000_000_000) return { ok: false, error: "That amount is too large." };

  const { start, end } = monthBounds(`${month}-01`);
  try {
    if (target.kind === "revise") {
      const budget = await prisma.budget.findFirst({
        where: { id: target.budgetId, clientId, periodStart: { lte: isoToDate(end) }, periodEnd: { gte: isoToDate(start) } },
        include: { client: { select: { timezone: true } }, revisions: { orderBy: { effectiveDate: "desc" }, take: 1 } },
      });
      if (!budget) return { ok: false, error: "This budget no longer exists for that month. Reload the page." };
      const ps = dateToIso(budget.periodStart);
      const pe = dateToIso(budget.periodEnd);
      // Effective today (inside the period), and never before the latest revision, so it becomes the month's budget.
      const today = todayInTimeZone(budget.client.timezone);
      const latest = budget.revisions[0] ? dateToIso(budget.revisions[0].effectiveDate) : ps;
      const effective = maxDate(maxDate(ps, minDate(today, pe)), latest);
      const errors = validateRevision(ps, pe, effective, amountMinor);
      if (errors.length) return { ok: false, error: errors[0] };
      await prisma.budgetRevision.create({
        data: { budgetId: budget.id, amountMinor: BigInt(amountMinor), effectiveDate: isoToDate(effective), note: "Edited on Budget Pacing", createdById: user.id },
      });
    } else {
      const account = await prisma.adAccount.findFirst({ where: { id: target.accountId, clientId }, include: { client: { select: { currency: true, budgets: true } } } });
      if (!account) return { ok: false, error: "That ad account isn't linked to this client anymore. Reload the page." };
      const errors = validateNewBudget(
        { scope: "ACCOUNT", accountId: account.id, campaignId: null, periodStart: start, periodEnd: end, amountMinor },
        account.client.budgets.map((b) => ({ id: b.id, scope: b.scope, accountId: b.accountId, campaignId: b.campaignId, periodStart: dateToIso(b.periodStart), periodEnd: dateToIso(b.periodEnd) })),
      );
      if (errors.length) return { ok: false, error: errors[0] };
      await prisma.budget.create({
        data: {
          clientId,
          scope: "ACCOUNT",
          accountId: account.id,
          periodStart: isoToDate(start),
          periodEnd: isoToDate(end),
          currency: account.client.currency,
          repeatsMonthly: true,
          revisions: { create: [{ amountMinor: BigInt(amountMinor), effectiveDate: isoToDate(start), note: "Added on Budget Pacing", createdById: user.id }] },
        },
      });
    }
  } catch (e) {
    console.error("[budget-pacing] save failed", e);
    return { ok: false, error: "Couldn't save. Try again." };
  }
  revalidatePath("/budget-pacing");
  revalidatePath(`/clients/${clientId}`, "layout");
  revalidatePath("/dashboard");
  return { ok: true, amountMinor };
}
