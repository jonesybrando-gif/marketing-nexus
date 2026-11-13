import { Suspense } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { requireAgencyStaff, visibleClientsWhere } from "@/server/access";
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
import { CombinedView } from "./combined-view";
import { ClientDirectory, type DirectoryClient } from "./client-directory";
import { CLIENTS_VIEW_COOKIE, parseLayout } from "@/lib/client-directory";
import type { SessionUser } from "@/lib/access";
import { setupChecklist } from "@/server/first-run";
import { SetupChecklist } from "@/components/setup-checklist";
import { BudgetRolloverBanner } from "@/components/dashboard/budget-rollover-banner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients" };

const PRESETS: RangePreset[] = ["mtd", "last_month", "last_7", "last_30", "last_90", "custom"];
type View = "performance" | "combined" | "manage" | "removed";

const VIEWS: { key: Exclude<View, "removed" | "combined">; label: string }[] = [
  { key: "performance", label: "Performance" },
  { key: "manage", label: "Manage" },
];

/**
 * /clients is the client directory: find a client and open its dashboard.
 * The agency-wide Performance table and Manage (labels, adding and removing
 * clients) stay at ?view=performance and ?view=manage (search / Cmd-K).
 * Budget Pacing moved to /budget-pacing; old ?view=budgets links redirect.
 */
export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireAgencyStaff();
  const raw = await searchParams;
  const admin = user.role === "AGENCY_ADMIN";
  if (raw.view === "budgets") redirect(raw.month ? `/budget-pacing?month=${encodeURIComponent(raw.month)}` : "/budget-pacing");
  if (!raw.view) return <Directory user={user} openNew={raw.new === "1"} />;
  const view: View = raw.view === "removed" && admin ? "removed" : raw.view === "manage" || raw.view === "combined" ? raw.view : "performance";
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
  const managers = admin ? await prisma.user.findMany({ where: { agencyId: user.agencyId, role: "ACCOUNT_MANAGER" }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [];

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{view === "removed" ? "Removed clients" : view === "combined" ? "All clients combined" : view === "manage" ? "Manage clients" : "Client performance"}</h1>
          {view !== "removed" && view !== "combined" && (
            <nav aria-label="Client views" className="inline-flex rounded-lg bg-track/50 p-0.5">
              {VIEWS.map((v) => (
                <Link
                  key={v.key}
                  href={`/clients?view=${v.key}`}
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
          {admin && view === "manage" && (
            <DialogButton label="New client" title="New client" description="Link its ad accounts afterwards from the client's Ad accounts page." defaultOpen={sp.new === "1"} icon={<Plus className="h-4 w-4" aria-hidden />}>
              <NewClientForm managers={managers} />
            </DialogButton>
          )}
        </div>
      </header>
      {dated && (
        <p className="-mt-3 text-sm text-text-2">
          {formatDate(range.from)} – {formatDate(range.to, { month: "short", day: "numeric", year: "numeric" })}
          {cmpRange && <> · compared with {formatDate(cmpRange.from)} – {formatDate(cmpRange.to)}</>}
        </p>
      )}

      <Suspense key={view} fallback={<PageSkeleton tiles={0} cards={2} />}>
        {view === "performance" ? (
          <PerformanceView user={user} today={today} range={range} cmpRange={cmpRange} preset={preset} compareMode={compareMode} initialFilter={sp.filter} />
        ) : view === "combined" ? (
          <CombinedView user={user} range={range} cmpRange={cmpRange} rangeQuery={rangeQuery} />
        ) : (
          <ManageView user={user} sp={sp as ManageSp} />
        )}
      </Suspense>
    </div>
  );
}

/** The directory: every client the user can see, A–Z, with a logo when there is one. */
async function Directory({ user, openNew }: { user: SessionUser; openNew: boolean }) {
  const admin = user.role === "AGENCY_ADMIN";
  const [clients, managers, jar, checklist] = await Promise.all([
    prisma.client.findMany({ where: visibleClientsWhere(user), select: { id: true, name: true }, orderBy: { name: "asc" } }),
    admin ? prisma.user.findMany({ where: { agencyId: user.agencyId, role: "ACCOUNT_MANAGER" }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
    cookies(),
    admin ? setupChecklist(user.agencyId).catch(() => null) : Promise.resolve(null),
  ]);
  // Only a fingerprint of each logo: the images load from /api/clients/[id]/logo, cached by version.
  const versions = clients.length
    ? await prisma.$queryRaw<{ id: string; v: string }[]>`SELECT id, md5("logoUrl") AS v FROM "Client" WHERE id IN (${Prisma.join(clients.map((c) => c.id))}) AND "logoUrl" IS NOT NULL AND "logoUrl" <> ''`
    : [];
  const version = new Map(versions.map((r) => [r.id, r.v.slice(0, 12)]));
  const rows: DirectoryClient[] = clients
    .map((c) => ({ id: c.id, name: c.name, logo: version.has(c.id) ? `/api/clients/${c.id}/logo?v=${version.get(c.id)}` : null }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <Link href="/dashboard" className="text-sm font-medium text-brand-text hover:underline">Agency overview</Link>
      </header>
      {/* Agency-wide notices that used to sit on Home: next month's budgets and first-run setup. */}
      <div className="flex flex-col gap-3 empty:hidden">
        <Suspense fallback={null}>
          <BudgetRolloverBanner user={user} />
        </Suspense>
        {checklist && !checklist.dismissed && <SetupChecklist steps={checklist.steps} compact />}
      </div>
      <ClientDirectory
        clients={rows}
        initialLayout={parseLayout(jar.get(CLIENTS_VIEW_COOKIE)?.value)}
        actions={
          admin ? (
            <DialogButton label="New Client" title="New client" description="Link its ad accounts afterwards from the client's Ad accounts page." defaultOpen={openNew} icon={<Plus className="h-4 w-4" aria-hidden />}>
              <NewClientForm managers={managers} />
            </DialogButton>
          ) : undefined
        }
      />
    </div>
  );
}
