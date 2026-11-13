import Link from "next/link";
import { formatMoney, formatPct } from "@/lib/money";

export interface BudgetHealthData {
  currency: string;
  periodName: string;
  budgetMinor: number;
  spentMinor: number;
  projectedMinor: number;
  /** Share of the period elapsed, 0–100, for the "where spend should be" marker. */
  elapsedPct: number | null;
  counts: { onTrack: number; over: number; under: number; none: number };
}

/**
 * Home: one sentence and one bar for the agency's budgets this period —
 * spent, projected, and where spend should be today — plus how many clients
 * are on track, over or under. The detail is on Clients › Budgets.
 */
export function BudgetHealth({ d }: { d: BudgetHealthData }) {
  const money = (m: number) => formatMoney(m, d.currency, { whole: true });
  const variance = d.projectedMinor - d.budgetMinor;
  const pct = (m: number) => (d.budgetMinor > 0 ? Math.min(100, (m / d.budgetMinor) * 100) : 0);
  const spentPct = pct(d.spentMinor);
  const projectedPct = pct(d.projectedMinor);
  const within = d.budgetMinor > 0 && Math.abs(variance) <= d.budgetMinor * 0.05;
  const headline = d.budgetMinor <= 0 ? "No budgets set" : within ? "On track for budget" : `Projected ${money(Math.abs(variance))} ${variance > 0 ? "over" : "under"} budget`;
  const counts: [string, number][] = [["On track", d.counts.onTrack], ["Over", d.counts.over], ["Under", d.counts.under], ["No budget", d.counts.none]];
  return (
    <section aria-labelledby="budget-health" className="flex flex-col gap-4 rounded-xl border border-border bg-surface px-5 py-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="budget-health" className="text-[15px] font-semibold">Budget health{d.periodName && ` · ${d.periodName}`}</h2>
        <Link href="/budget-pacing" className="text-[13px] font-medium text-brand-text hover:underline">Open budgets</Link>
      </div>
      <div>
        <p className="text-xl font-semibold tracking-tight tabular">{headline}</p>
        {d.budgetMinor > 0 && (
          <p className="mt-1 text-sm text-text-2 tabular">
            {money(d.spentMinor)} spent of {money(d.budgetMinor)}. On this pace the period ends near {money(d.projectedMinor)} ({formatPct(d.budgetMinor ? (d.projectedMinor / d.budgetMinor) * 100 : null, 0)}). Projections are estimates.
          </p>
        )}
      </div>
      {d.budgetMinor > 0 && (
        <div>
          <div className="relative h-3 rounded-full bg-track/60" role="img" aria-label={`Spent ${Math.round(spentPct)}% of budget; projected ${Math.round((d.projectedMinor / d.budgetMinor) * 100)}%${d.elapsedPct !== null ? `; ${Math.round(d.elapsedPct)}% of the period has passed` : ""}.`}>
            {projectedPct > spentPct && (
              <div
                className="absolute inset-y-0 rounded-r-full"
                style={{ left: `${spentPct}%`, width: `${projectedPct - spentPct}%`, background: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--series-actual) 45%, transparent) 0 4px, color-mix(in srgb, var(--series-actual) 20%, transparent) 4px 8px)" }}
              />
            )}
            <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--series-actual)]" style={{ width: `${spentPct}%` }} />
            {d.elapsedPct !== null && <div className="absolute -top-1 -bottom-1 w-0.5 rounded bg-text" style={{ left: `${Math.min(100, d.elapsedPct)}%` }} />}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-2" aria-hidden>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[var(--series-actual)]" /> Spent</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[color-mix(in_srgb,var(--series-actual)_35%,transparent)]" /> Projected</span>
            {d.elapsedPct !== null && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-0.5 bg-text" /> Where spend should be today</span>}
          </div>
        </div>
      )}
      <dl className="grid grid-cols-4 gap-3 border-t border-border pt-4">
        {counts.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-text-2">{k}</dt>
            <dd className="text-lg font-semibold tabular">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
