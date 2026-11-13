import { Suspense } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@/server/db";
import { requireAgencyStaff } from "@/server/access";
import { withRememberedRange } from "@/server/remembered-range";
import { comparisonRange, resolveRange, type CompareMode, type RangePreset } from "@/lib/date-ranges";
import { todayInTimeZone } from "@/lib/pacing/dates";
import { formatDate } from "@/lib/time";
import { RangeControls } from "@/components/range-controls";
import { PageSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/components/ui/cn";
import { DialogButton } from "./client-dialogs";
import { NewClientForm } from "./new-client-form";
import { ManageView, type ManageSp } from "./manage-view";
import { PerformanceView } from "./performance-view";
import { BudgetsView, monthLabel } from "./budgets-view";
import { resolveMonth } from "@/server/budget-pacing";
import { CombinedView } from "./combined-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients" };

const PRESETS: RangePreset[] = ["mtd", "last_month", "last_7", "last_30", "last_90", "custom"];
type View = "performance" | "combined" | "budgets" | "manage" | "removed";

const VIEWS: { key: Exclude<View, "removed">; label: string }[] = [
  { key: "performance", label: "Performance" },
  { key: "budgets", label: "Budgets" },
  { key: "manage", label: "Manage" },
];

/**
 * One place for clients, three views: Performance (how each client is doing),
 * Budgets (Budget Pacing: one row per client and platform for a month) and Manage (labels, adding and
 * removing clients). Replaces the separate "All clients" and "Clients" pages.
 */
export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireAgencyStaff();
  const raw = await searchParams;
  const admin = user.role === "AGENCY_ADMIN";
  const view: View = raw.view === "removed" && admin ? "removed" : raw.view === "manage" || raw.view === "budgets" || raw.view === "combined" ? raw.view : "performance";
  const dated = view === "performance" || view === "combined";
  // Only the Performance views use a date range; the others keep their own query untouched.
  const sp = dated ? await withRememberedRange(raw) : raw;

  const agency = await prisma.agency.findUniqueOrThrow({ where: { id: user.agencyId }, select: { defaultTimezone: true } });
  const today = todayInTimeZone(agency.defaultTimezone);
  const preset: RangePreset = PRESETS.includes(sp.range as RangePreset) ? (sp.range as RangePreset) : "last_30";
  const compareMode: CompareMode = (["previous_period", "previous_month", "none"] as const).includes(sp.compare as CompareMode) ? (sp.compare as CompareMode) : "previous_period";
  let range;
  try {
    range = resolveRange(preset, today, { from: sp.from, to: sp.to });
  } catch {
    range = resolveRange("last_30", today);
  }
  const cmpRange = comparisonRange(range, compareMode);
  const rangeQuery = `range=${preset}&compare=${compareMode}${preset === "custom" ? `&from=${range.from}&to=${range.to}` : ""}`;
  const month = view === "budgets" ? resolveMonth(sp.month, today) : null;
  const managers = admin ? await prisma.user.findMany({ where: { agencyId: user.agencyId, role: "ACCOUNT_MANAGER" }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [];

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{view === "removed" ? "Removed clients" : view === "combined" ? "All clients combined" : view === "budgets" ? "Budget Pacing" : "Clients"}</h1>
          {view !== "removed" && view !== "combined" && (
            <nav aria-label="Client views" className="inline-flex rounded-lg bg-track/50 p-0.5">
              {VIEWS.map((v) => (
                <Link
                  key={v.key}
                  href={v.key === "performance" ? "/clients" : `/clients?view=${v.key}`}
                  aria-current={view === v.key ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center rounded-md px-3.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    view === v.key ? "bg-surface font-semibold text-text shadow-sm" : "font-medium text-text-2 hover:text-text",
                  )}
                >
                  {v.label}
                </Link>
              ))}
            </nav>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dated && <RangeControls preset={preset} compare={compareMode} from={range.from} to={range.to} />}
          {admin && view !== "removed" && view !== "combined" && view !== "budgets" && (
            <DialogButton label="New client" title="New client" description="Link its ad accounts afterwards from the client's Ad accounts page." defaultOpen={sp.new === "1"} icon={<Plus className="h-4 w-4" aria-hidden />}>
              <NewClientForm managers={managers} />
            </DialogButton>
          )}
        </div>
      </header>
      {month && <p className="-mt-3 text-sm text-text-2">{monthLabel(month.key)}</p>}
      {dated && (
        <p className="-mt-3 text-sm text-text-2">
          {formatDate(range.from)} – {formatDate(range.to, { month: "short", day: "numeric", year: "numeric" })}
          {cmpRange && <> · compared with {formatDate(cmpRange.from)} – {formatDate(cmpRange.to)}</>}
        </p>
      )}

      <Suspense key={view} fallback={<PageSkeleton tiles={0} cards={view === "budgets" ? 1 : 2} />}>
        {view === "performance" ? (
          <PerformanceView user={user} today={today} range={range} cmpRange={cmpRange} preset={preset} compareMode={compareMode} initialFilter={sp.filter} />
        ) : view === "combined" ? (
          <CombinedView user={user} range={range} cmpRange={cmpRange} rangeQuery={rangeQuery} />
        ) : view === "budgets" ? (
          <BudgetsView user={user} month={month!} currentKey={today.slice(0, 7)} />
        ) : (
          <ManageView user={user} sp={sp as ManageSp} />
        )}
      </Suspense>
    </div>
  );
}
