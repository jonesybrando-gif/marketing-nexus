import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { SIMPLE_TONE, type SimpleStatus, type SimpleTone } from "@/lib/pacing/simple";
import type { BudgetOverview } from "@/lib/pacing/overview";
import { MetricCard } from "@/components/ui/metric-card";
import { cn } from "@/components/ui/cn";

const PILL: Record<SimpleTone, string> = {
  red: "bg-critical-bg text-critical-ink",
  amber: "bg-warning-bg text-warning-ink",
  green: "bg-good-bg text-good-ink",
  gray: "bg-surface-2 text-text-2",
};
const DOT: Record<SimpleTone, string> = { red: "bg-critical", amber: "bg-dot-watch", green: "bg-good", gray: "bg-text-3/60" };

/** "On track" / "Underpacing" / "Overpacing" / "Over budget" / "Not enough data", with its reason on hover. */
export function PacingStatus({ status, label, message, className }: { status: SimpleStatus; label: string; message?: string; className?: string }) {
  const tone = SIMPLE_TONE[status];
  return (
    <span title={message} className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", PILL[tone], className)}>
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", DOT[tone])} />
      {label}
      {message && <span className="sr-only">: {message}</span>}
    </span>
  );
}

/**
 * One bar for the month: spend so far (fill), where spend should be by now
 * (solid tick) and where it is heading at the current rate (dashed tick).
 * The bar's full width is the monthly budget; anything past it is clipped
 * and said in words.
 */
export function BudgetProgressBar({ o }: { o: BudgetOverview }) {
  if (o.budgetMinor === null || o.budgetMinor <= 0) return null;
  const money = (m: number) => formatMoney(m, o.currency, { whole: true });
  const pctOf = (m: number) => (m / o.budgetMinor!) * 100;
  const used = o.spentMinor !== null ? pctOf(o.spentMinor) : null;
  const expected = o.expectedMinor !== null ? pctOf(o.expectedMinor) : null;
  const projected = o.projectedMinor !== null ? pctOf(o.projectedMinor) : null;
  const tone = SIMPLE_TONE[o.status];
  const fill = tone === "red" ? "bg-critical" : tone === "amber" ? "bg-dot-watch" : tone === "green" ? "bg-good" : "bg-text-3/60";
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const summary = [
    used !== null ? `${Math.round(used)}% of the budget used` : "Spend not known yet",
    expected !== null ? `about ${Math.round(expected)}% expected by now` : null,
    projected !== null ? `heading for ${money(o.projectedMinor!)} (${Math.round(projected)}%) by month end` : null,
  ].filter(Boolean).join(", ");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {used !== null ? <>{Math.round(used)}% used</> : <span className="text-text-3">Spend not known yet</span>}
          {o.elapsedFraction !== null && <span className="font-normal text-text-3"> · {Math.round(o.elapsedFraction * 100)}% of the month elapsed</span>}
        </p>
        <PacingStatus status={o.status} label={o.label} message={o.message} />
      </div>
      <div role="img" aria-label={summary} className="relative h-3 rounded-full bg-surface-2">
        {used !== null && <div className={cn("absolute inset-y-0 left-0 rounded-full", fill)} style={{ width: `${clamp(used)}%` }} />}
        {expected !== null && (
          <span aria-hidden className="absolute -top-1 -bottom-1 w-0.5 rounded bg-text" style={{ left: `calc(${clamp(expected)}% - 1px)` }} />
        )}
        {projected !== null && (
          <span aria-hidden className="absolute -top-1 -bottom-1 w-0 border-l-2 border-dashed border-text-2" style={{ left: `calc(${clamp(projected)}% - 1px)` }} />
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-2">
        {expected !== null && (
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className="h-3 w-0.5 rounded bg-text" /> Expected by now: {money(o.expectedMinor!)}</li>
        )}
        {projected !== null && (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-3 w-0 border-l-2 border-dashed border-text-2" /> Projected month end: {money(o.projectedMinor!)}
            {projected > 100.5 && <span className="text-critical-ink"> ({money(o.projectedMinor! - o.budgetMinor)} over)</span>}
          </li>
        )}
        {o.asOf && <li className="text-text-3">Based on data through {formatDate(o.asOf)}</li>}
      </ul>
    </div>
  );
}

/** Monthly Budget, Spent to Date and Remaining, then the progress bar and any data caveats. */
export function BudgetOverviewPanel({ o, monthLabel, rangeNote, offPace = 0, extraNotes = [] }: { o: BudgetOverview; monthLabel: string; rangeNote?: string | null; offPace?: number; extraNotes?: string[] }) {
  const money = (m: number) => formatMoney(m, o.currency, { whole: true });
  const notes = [
    o.status === "ON_PACE" && offPace > 0 ? `Overall spend is on track, but ${offPace === 1 ? "1 account is" : `${offPace} accounts are`} off pace; see the table below.` : null,
    o.incomplete ? "Spend is missing for at least one budgeted account, so Spent to Date is partial." : null,
    o.unbudgetedSpendMinor > 0 ? `${money(o.unbudgetedSpendMinor)} was spent on accounts with no budget this month; it isn't counted above.` : null,
    ...extraNotes,
    rangeNote ?? null,
  ].filter((n): n is string => !!n);
  return (
    <section aria-label={`${monthLabel} budget`} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard size="md" label="Monthly budget" info={`The total budget set for ${monthLabel} across this client's accounts.`} value={o.budgetMinor === null ? "—" : money(o.budgetMinor)} change={<span className="text-text-3">{o.budgetMinor === null ? "No budget set" : monthLabel}</span>} />
        <MetricCard size="md" label="Spent to date" info="Spend on budgeted accounts this month, as reported by the ad platforms." value={o.spentMinor === null ? "—" : money(o.spentMinor)} change={<span className="text-text-3">{o.spentMinor === null ? "No spend data yet" : o.asOf ? `Through ${formatDate(o.asOf)}${o.incomplete ? " · partial" : ""}` : o.incomplete ? "Partial" : ""}</span>} />
        <MetricCard
          size="md"
          label="Remaining"
          info="Monthly budget minus spent to date."
          value={o.remainingMinor === null ? "—" : o.remainingMinor < 0 ? `-${money(-o.remainingMinor)}` : money(o.remainingMinor)}
          valueTone={o.remainingMinor !== null && o.remainingMinor < 0 ? "critical" : undefined}
          change={<span className="text-text-3">{o.remainingMinor !== null && o.remainingMinor < 0 ? "Over budget" : o.budgetMinor && o.remainingMinor !== null ? `${Math.round((o.remainingMinor / o.budgetMinor) * 100)}% of the budget left` : ""}</span>}
        />
      </div>
      {o.budgetMinor !== null && o.budgetMinor > 0 && (
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <BudgetProgressBar o={o} />
        </div>
      )}
      {notes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-text-3">
          {notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </section>
  );
}
