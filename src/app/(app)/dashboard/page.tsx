import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireAgencyStaff, visibleClientsWhere } from "@/server/access";
import { prisma } from "@/server/db";
import { loadPacing, summarize } from "@/server/pacing-service";
import { clientAttention, portfolioResults, portfolioResultsFor } from "@/server/portfolio";
import { setupChecklist } from "@/server/first-run";
import { attentionTier, attentionWeight, forecastOffBudget } from "@/lib/portfolio";
import { homeInsights } from "@/lib/home-insights";
import { comparisonRange, resolveRange } from "@/lib/date-ranges";
import { displayPacingStatus } from "@/lib/pacing/display-status";
import { todayInTimeZone } from "@/lib/pacing/dates";
import { formatDate } from "@/lib/time";
import { DemoBadge } from "@/components/status-badge";
import { ExportButtons } from "@/components/export-buttons";
import { SetupChecklist } from "@/components/setup-checklist";
import { BudgetRolloverBanner } from "@/components/dashboard/budget-rollover-banner";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Banner } from "@/components/ui/banner";
import { InsightCard } from "@/components/insight-card";
import { HomeSummary } from "@/components/dashboard/home-summary";
import { stillCounting } from "@/lib/results";
import { NeedsAttention, type AttentionClient } from "@/components/dashboard/needs-attention";
import { BudgetHealth } from "@/components/dashboard/budget-health";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home" };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireAgencyStaff();
  const { status } = await searchParams;
  // The full pacing table is Budget Pacing; old links with a status filter still land on it.
  if (status) redirect("/budget-pacing");
  // The shell streams at once; the figures load inside an in-page boundary (not a
  // route loading.tsx, which made value-returning server actions hang).
  return (
    <Suspense fallback={<div className="mx-auto max-w-[1280px]"><PageSkeleton tiles={4} cards={2} /></div>}>
      <Home user={user} />
    </Suspense>
  );
}

/**
 * Home is a starting point, not a report: four figures for the month so far,
 * the few clients to look at first, one picture of budget health and up to
 * three findings. Everything else is one click away on Clients.
 */
async function Home({ user }: { user: Awaited<ReturnType<typeof requireAgencyStaff>> }) {
  const visible = visibleClientsWhere(user);
  const agency = await prisma.agency.findUniqueOrThrow({ where: { id: user.agencyId }, select: { defaultTimezone: true } });
  const today = todayInTimeZone(agency.defaultTimezone);
  // One window for the page: this month so far, against the same days last month.
  const month = resolveRange("mtd", today);
  const lastMonth = comparisonRange(month, "previous_month")!;
  const [clients, mtd, last30] = await Promise.all([loadPacing(visible), portfolioResultsFor(visible, month, lastMonth), portfolioResults(visible, today)]);

  const checklist = user.role === "AGENCY_ADMIN" ? await setupChecklist(user.agencyId) : null;
  if (clients.length === 0) {
    return (
      <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome. Let&apos;s set up budget pacing</h1>
          <p className="text-sm text-text-2">You don&apos;t have any clients yet. Work through these steps and this page fills in.</p>
        </div>
        {checklist ? (
          <SetupChecklist steps={checklist.steps} dismissible={false} />
        ) : (
          <p className="text-sm text-text-2">No clients are assigned to you yet. Ask an administrator to assign you a client.</p>
        )}
      </div>
    );
  }

  // Who needs attention (the same rules as Clients), Critical first.
  const reasons = await clientAttention(clients, last30);
  const attention: (AttentionClient & { weight: number; spend: number })[] = clients
    .map((c) => {
      const why = reasons.get(c.client.id) ?? [];
      return { id: c.client.id, name: c.client.name, reasons: why, tier: attentionTier(why) ?? "watch", weight: attentionWeight(why), spend: last30.byClient.get(c.client.id)?.current.spendMinor ?? 0 };
    })
    .filter((c) => c.reasons.length > 0)
    .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "critical" ? -1 : 1) || b.weight - a.weight || b.spend - a.spend);
  const critical = attention.filter((c) => c.tier === "critical").length;

  // Budget health in the most common currency; amounts are never added across currencies.
  const main = mtd.currency;
  const inMain = clients.filter((c) => c.client.currency === main);
  const s = summarize(inMain);
  const counts = { onTrack: 0, over: 0, under: 0, none: 0 };
  for (const c of inMain) {
    const st = c.connectedTotal ? displayPacingStatus(c.connectedTotal).status : null;
    if (st === "ON_TARGET") counts.onTrack++;
    else if (st === "SLIGHTLY_OVER" || st === "OVERSPENDING") counts.over++;
    else if (st === "SLIGHTLY_UNDER" || st === "UNDERSPENDING") counts.under++;
    else counts.none++;
  }
  const combined = s.combined;
  const elapsedPct = combined ? combined.pctPeriodElapsed : null;

  const vs = `${formatDate(lastMonth.from, { month: "short", day: "numeric" })}–${formatDate(lastMonth.to, { day: "numeric" })}`;
  const insights = homeInsights({
    currency: main,
    totals: mtd.totals,
    clients: inMain.map((c) => ({ id: c.client.id, name: c.client.name, goal: mtd.byClient.get(c.client.id)?.goal, current: mtd.byClient.get(c.client.id)?.current ?? { spendMinor: 0, results: 0 }, previous: mtd.byClient.get(c.client.id)?.previous ?? { spendMinor: 0, results: 0 } })),
    budgets: inMain
      .filter((c) => c.connectedTotal && c.connectedTotal.phase === "ACTIVE")
      .map((c) => ({ id: c.client.id, name: c.client.name, varianceMinor: c.connectedTotal!.projectedVarianceMinor, off: forecastOffBudget(c.connectedTotal!.budgetMinor, c.connectedTotal!.projectedVarianceMinor) })),
    previousLabel: "last month",
  });

  const isDemo = clients.some((c) => c.accounts.some((a) => a.isDemo));
  const showChecklist = checklist && !checklist.dismissed;

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
          <p className="mt-1 text-sm text-text-2">
            {formatDate(month.from, { month: "long" })} so far · {clients.length} client{clients.length === 1 ? "" : "s"}
            {s.typicalAsOf && <> · data through {formatDate(s.typicalAsOf, { month: "short", day: "numeric" })}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isDemo && <DemoBadge />}
          <ExportButtons base="/api/reports/agency" />
        </div>
      </header>

      <div className="-mt-4 flex flex-col gap-3 empty:hidden">
        <BudgetRolloverBanner user={user} />
        {mtd.otherCurrencyClients > 0 && (
          <Banner tone="warning">Clients report in more than one currency ({mtd.currencies.join(", ")}). These figures cover {main} clients only; {mtd.otherCurrencyClients} {mtd.otherCurrencyClients === 1 ? "is" : "are"} left out rather than added without conversion.</Banner>
        )}
        {showChecklist && <SetupChecklist steps={checklist.steps} compact />}
      </div>

      <HomeSummary r={mtd} vs={vs} attention={attention.length} critical={critical} total={clients.length} counting={stillCounting(month.to, today)} />

      <div className="grid items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <NeedsAttention clients={attention} total={clients.length} />
        <BudgetHealth
          d={{
            currency: s.currency,
            periodName: combined ? formatDate(combined.periodStart, { month: "long" }) : "",
            budgetMinor: s.totalBudgetMinor,
            spentMinor: s.actualToDateMinor,
            projectedMinor: s.projectedMinor,
            elapsedPct,
            counts,
          }}
        />
      </div>

      {insights.length > 0 && (
        <section aria-labelledby="home-insights" className="flex flex-col gap-3">
          <h2 id="home-insights" className="text-[15px] font-semibold">Insights</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {insights.map((x) => <InsightCard key={x.eyebrow} kind="observation" eyebrow={x.eyebrow} headline={x.headline} detail={x.detail} action={x.action} />)}
          </div>
        </section>
      )}
    </div>
  );
}

