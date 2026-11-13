import { Suspense } from "react";
import { prisma } from "@/server/db";
import { requireAgencyStaff } from "@/server/access";
import { resolveMonth } from "@/server/budget-pacing";
import { todayInTimeZone } from "@/lib/pacing/dates";
import { PageSkeleton } from "@/components/ui/skeleton";
import { BudgetsView, monthLabel } from "../clients/budgets-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Budget Pacing" };

/** Budget Pacing: one row per client and platform for a month (was Clients › Budgets). */
export default async function BudgetPacingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireAgencyStaff();
  const sp = await searchParams;
  const agency = await prisma.agency.findUniqueOrThrow({ where: { id: user.agencyId }, select: { defaultTimezone: true } });
  const today = todayInTimeZone(agency.defaultTimezone);
  const month = resolveMonth(sp.month, today);
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Budget Pacing</h1>
      </header>
      <p className="-mt-3 text-sm text-text-2">{monthLabel(month.key)}</p>
      <Suspense key={month.key} fallback={<PageSkeleton tiles={0} cards={1} />}>
        <BudgetsView user={user} month={month} currentKey={today.slice(0, 7)} />
      </Suspense>
    </div>
  );
}
