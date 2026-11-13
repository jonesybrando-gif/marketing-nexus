import Link from "next/link";
import { isAccountDisconnected, isAccountRetired } from "@/lib/account-health";
import type { ReactNode } from "react";
import { AlertTriangle, CalendarRange, EyeOff, Plug, RefreshCw, Unplug } from "lucide-react";
import type { PacingRow } from "@/server/pacing-service";
import type { ClientReport, ReportParams } from "@/server/client-report";
import type { PlatformKey } from "@/lib/platforms";
import { PRESET_LABEL } from "@/lib/date-ranges";
import { derive, type MetricTotals } from "@/lib/metrics";
import { ALL_KPI_KEYS, dailyKpiValue, KPI_BY_KEY, kpiValues, untrackedKpis, type KpiKey, type KpiValue } from "@/lib/kpis";
import { stillCounting } from "@/lib/results";
import { pacingHeadline } from "@/lib/at-a-glance";
import { displayPacingStatus } from "@/lib/pacing/display-status";
import { InfoTip } from "@/components/ui/info-tip";
import { DetailDisclosure } from "./detail-disclosure";
import type { SectionKey } from "@/lib/report-template";
import { formatMoney, formatNumber, formatPct } from "@/lib/money";
import { formatDate, relativeTime } from "@/lib/time";
import { PLATFORM_LABEL } from "@/lib/platforms";
import { formatCustomerId } from "@/server/integrations/google-ads/gaql";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { KpiCard, kpiNote } from "@/components/kpi/kpi-card";
import { KpiEditor } from "./kpi-editor";
import { NoBudgetBadge, NotConnectedBadge, StaleBadge, StatusBadge } from "@/components/status-badge";
import { PlatformLabel } from "@/components/platform-badge";
import { PacingChart } from "@/components/charts/pacing-chart";
import { TrendChart } from "@/components/charts/trend-chart";
import { RefreshAccountButton } from "@/components/refresh-account-button";
import { CampaignTable, type CampaignRow } from "./campaign-table";

// The building blocks of a client report. The client page arranges them in
// tabs for staff; the client-facing report (client logins and shared links)
// shows them on one page. `staff` adds internal detail only.

export const TREND_EXTRAS: KpiKey[] = ["spend", "conversions", "leads", "costPerLead", "clicks", "impressions", "conversionRate"];

/** Shown to staff on sections the client-facing report leaves out. */
export function HiddenFromClient() {
  return <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-xs font-normal text-text-3"><EyeOff className="h-3 w-3" aria-hidden /> Hidden from client report</span>;
}

/** Marker for staff when the client-facing report leaves a section out. */
export function hiddenMarker(rep: Pick<ClientReport, "template">, staff: boolean) {
  return function marker(k: SectionKey) {
    return staff && !rep.template.sections[k] ? <HiddenFromClient /> : null;
  };
}

/**
 * The full KPI tiles, collapsed by default under "Advertising detail" so the
 * page opens on At a glance. Each viewer's open/closed choice is remembered.
 */
export function AdvertisingDetail({ rep, marker, editable = false }: { rep: ClientReport; marker?: ReactNode; editable?: boolean }) {
  return (
    <DetailDisclosure storageKey="advertising-detail" title="Advertising detail" hint="Clicks, conversions, costs and more from the ad platforms">
      <KpiSection rep={rep} marker={marker} editable={editable} />
    </DetailDisclosure>
  );
}

/**
 * `editable` (staff who may edit the client) adds the inline "Edit KPIs" editor.
 * Tiles the client doesn't track (no real conversion values, no leads) are
 * hidden; staff can still add them back with Edit KPIs.
 */
export function KpiSection({ rep, marker, editable = false }: { rep: ClientReport; marker?: ReactNode; editable?: boolean }) {
  const { template, perf, cmpPerf, client } = rep;
  const t = perf.totals;
  const counting = stillCounting(rep.range.to, rep.today);
  const hidden = untrackedKpis(t, cmpPerf?.totals ?? null);
  // The editor previews any catalogue KPI, so it gets every value; the static view only the chosen ones.
  const kvs = kpiValues(editable ? ALL_KPI_KEYS : template.kpis.filter((k) => !hidden.has(k)), t, cmpPerf?.totals ?? null, { stillCounting: counting });
  const trend = (k: KpiKey) => perf.byDate.map((d) => dailyKpiValue(d, k));
  const chip = (k: KpiKey) => (k === "spend" && t.hasEstimatedCost ? "Estimated" : undefined);
  return (
    <section aria-label="Key metrics" className="flex flex-col gap-2">
      {editable ? (
        <KpiEditor
          clientId={client.id}
          kpis={template.kpis}
          values={Object.fromEntries(kvs.map((kv) => [kv.key, kv])) as Record<KpiKey, KpiValue>}
          trends={Object.fromEntries(ALL_KPI_KEYS.map((k) => [k, trend(k)])) as Record<KpiKey, (number | null)[]>}
          currency={client.currency}
          marker={marker}
          hidden={[...hidden]}
          chips={t.hasEstimatedCost ? { spend: "Estimated" } : {}}
        />
      ) : (
        <>
          {marker}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {kvs.map((kv) => <KpiCard key={kv.key} kv={kv} currency={client.currency} trend={trend(kv.key)} note={kpiNote(kv)} chip={chip(kv.key)} />)}
          </div>
        </>
      )}
      {t.hasEstimatedCost && <p className="text-xs text-warning-ink">Spend includes an estimate for Google Local Services ads, which don&apos;t report exact daily spend.</p>}
      {counting && <p className="text-xs text-text-3">The last few days may still rise as ad platforms finish counting results, so result changes aren&apos;t judged yet.</p>}
      {noActivity(rep) && client.accounts.length > 0 && <p className="text-xs text-text-3">No advertising activity was recorded from {formatDate(rep.range.from)} to {formatDate(rep.range.to)}. Try a different date range, or check the accounts under Setup.</p>}
    </section>
  );
}

export function NoteSection({ rep, marker }: { rep: ClientReport; marker?: ReactNode }) {
  const text = rep.template.summary.trim();
  if (!text) return null;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2"><CardTitle>Note</CardTitle>{marker}</div>
      </CardHeader>
      <CardContent><p className="max-w-[80ch] whitespace-pre-line text-sm text-text-2">{text}</p></CardContent>
    </Card>
  );
}

/** True when the budget period is one calendar month. */
function isCalendarMonth(rep: ClientReport): boolean {
  const { start, end } = rep.pacing.period;
  return start.endsWith("-01") && formatDate(start, { month: "long", year: "numeric" }) === formatDate(end, { month: "long", year: "numeric" });
}

/** "This month · October 2026" for a calendar month, else the period's dates. */
export function pacingPeriodLabel(rep: ClientReport): string {
  const { start, end } = rep.pacing.period;
  const monthly = isCalendarMonth(rep);
  const current = start <= rep.today && rep.today <= end;
  if (monthly) return `${current ? "This month · " : ""}${formatDate(start, { month: "long", year: "numeric" })}`;
  return `${current ? "Current period · " : ""}${formatDate(start)} – ${formatDate(end, { month: "short", day: "numeric", year: "numeric" })}`;
}

const lineName = (r: PacingRow, staff: boolean) => (r.level === "CLIENT" ? (staff ? "Combined client budget" : "Total budget") : r.label);

export function PacingSection({ rep, staff, basePath, query, marker, showLines = true }: { rep: ClientReport; staff: boolean; basePath: string; query: Record<string, string | undefined>; marker?: ReactNode; showLines?: boolean }) {
  const { pacing, client, preset, range } = rep;
  const c = client.currency;
  const total = pacing.total;
  const allLines: PacingRow[] = [...pacing.rows, ...pacing.subRows];
  const selectedKey = query.line && pacing.seriesByKey[query.line] ? query.line : null;
  const selectedRow = selectedKey ? allLines.find((r) => r.key === selectedKey) ?? null : null;
  const shown = selectedRow?.result ?? total;
  const shownSeries = selectedKey ? pacing.seriesByKey[selectedKey] : total?.series;
  const lineHref = (key: string | null) => {
    const q = new URLSearchParams(Object.entries(query).filter(([k, v]) => k !== "line" && v) as [string, string][]);
    if (key) q.set("line", key);
    return `${basePath}?${q.toString()}`;
  };
  // The report's range and the budget period can differ (e.g. "Last month" vs this month's budget).
  const differentPeriod = range.from > pacing.period.end || range.to < pacing.period.start || preset !== "mtd";
  const caveats = [...new Set(allLines.flatMap((r) => r.warnings))];
  // Clients don't need the combined line as a second chip (it is the total) or lines with no budget behind them.
  const chipLines = allLines.filter((r) => pacing.seriesByKey[r.key] && (staff || (r.level !== "CLIENT" && r.level !== "UNBUDGETED" && !r.notConnected)));
  const unit = isCalendarMonth(rep) ? "month" : "period";
  const periodName = isCalendarMonth(rep) ? formatDate(pacing.period.start, { month: "long" }) : "this budget period";
  // The badge is the worse of spend so far and the month-end forecast.
  const display = shown ? displayPacingStatus(shown) : null;
  const m = (v: number) => formatMoney(v, c, { whole: true });
  // Clients see four plain figures; staff keep every figure, in plain words.
  const facts: [string, string][] = shown
    ? staff
      ? [
          ["Spent so far", m(shown.actualToDateMinor)],
          ["Budget", m(shown.budgetMinor)],
          ["Left to spend", m(shown.remainingBudgetMinor)],
          [`Estimated ${unit}-end`, `${m(shown.projectedMinor)} (${shown.projectedVarianceMinor >= 0 ? "+" : "−"}${m(Math.abs(shown.projectedVarianceMinor))})`],
          ["Spending pace", shown.pacingPct === null ? "—" : `${formatPct(shown.pacingPct, 0)} of plan`],
          ["Planned by now", m(shown.expectedToDateMinor)],
          [`Budget used vs ${unit} elapsed`, `${formatPct(shown.pctBudgetConsumed, 0)} vs ${formatPct(shown.pctPeriodElapsed, 0)}`],
          ["Daily spend needed to land on budget", shown.requiredDailyMinor === null ? "—" : `${m(shown.requiredDailyMinor)} a day for ${shown.remainingActiveDays} days`],
          ["Daily spend lately (7-day average)", m(shown.currentDailyRateMinor)],
        ]
      : [
          ["Spent", m(shown.actualToDateMinor)],
          ["Budget", m(shown.budgetMinor)],
          ["Left", m(shown.remainingBudgetMinor)],
          [`Estimated ${unit}-end`, m(shown.projectedMinor)],
        ]
    : [];
  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Budget pacing · {pacingPeriodLabel(rep)}</CardTitle>
              {marker}
            </div>
            {display && <StatusBadge status={display.status} />}
          </div>
          {shown && <p className="max-w-[75ch] text-sm text-text">{pacingHeadline(shown, c, periodName)}</p>}
          {display?.forecastNote && <p className="text-xs text-text-2">{display.forecastNote}.</p>}
          <CardDescription>
            {shown?.asOf ? <>Complete data through {formatDate(shown.asOf)}. Today&apos;s partial spend is excluded.</> : "No complete days of data in this period yet."}
          </CardDescription>
          {differentPeriod && (
            <p className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-md bg-surface-2 px-2 py-0.5 text-xs text-text-2">
              <CalendarRange className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
              Pacing covers the current budget period, not the {PRESET_LABEL[preset].toLowerCase()} range used elsewhere on this page.
            </p>
          )}
          {(staff ? allLines.length > 1 : chipLines.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1 text-xs" aria-label="Pacing level">
              <Link href={lineHref(null)} className={`rounded-md px-2.5 py-1 ${!selectedKey ? "bg-surface-2 font-medium ring-1 ring-border" : "text-text-2 hover:text-text"}`}>{staff ? "Client total" : "Total"}</Link>
              {chipLines.map((r) => (
                <Link key={r.key} href={lineHref(r.key)} className={`rounded-md px-2.5 py-1 ${selectedKey === r.key ? "bg-surface-2 font-medium ring-1 ring-border" : "text-text-2 hover:text-text"}`}>
                  {r.level === "CLIENT" ? (staff ? "Combined budget" : "Total budget") : r.label}
                </Link>
              ))}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {shown && shownSeries ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
              <PacingChart series={shownSeries} budgetMinor={shown.budgetMinor} asOf={shown.asOf} currency={c} height={300} notes={notesFor(rep, staff)} />
              <dl className="grid grid-cols-2 content-start gap-x-4 gap-y-3 text-sm lg:grid-cols-1">
                {facts.map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-text-3">{k}</dt>
                    <dd className="font-medium tabular">{v}</dd>
                  </div>
                ))}
                {staff && selectedRow && (
                  <div className="col-span-2 rounded-lg bg-surface-2 p-3 text-xs lg:col-span-1">
                    <p className="font-medium text-text">{selectedRow.action.headline}</p>
                    <p className="text-text-2">{selectedRow.action.detail}</p>
                  </div>
                )}
              </dl>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 py-2">
              <p className="text-sm text-text-2">No budget is set for this period{staff ? ". Add a monthly budget to get pacing, month-end forecasts, daily spend targets and alerts." : "."}</p>
              {staff && <Link className={buttonVariants({ size: "sm" })} href={`/clients/${client.id}/budgets`}>Add a budget</Link>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Data notes (time zones, estimated spend…) are for staff only, folded into one line. */}
      {staff && caveats.length > 0 && (
        <details className="group w-fit max-w-full rounded-lg border border-border bg-warning-bg px-3 py-1.5 text-xs text-warning-ink">
          <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {caveats.length} data note{caveats.length === 1 ? "" : "s"}
            <span className="font-normal text-text-3">· team only</span>
          </summary>
          <ul className="mt-1.5 mb-1 list-disc space-y-0.5 pl-5">{caveats.map((w) => <li key={w}>{w}</li>)}</ul>
        </details>
      )}

      {showLines && allLines.length > (staff ? 0 : 1) && <BudgetLinesCard rep={rep} staff={staff} />}
    </>
  );
}

/**
 * Every budget line for the period. Staff see sub-allocations, unbudgeted
 * accounts and recommendations; the client-facing version is a plain "Budget"
 * table without internal terms.
 */
export function BudgetLinesCard({ rep, staff }: { rep: ClientReport; staff: boolean }) {
  const { pacing, client } = rep;
  const c = client.currency;
  const sub = new Set(pacing.subRows);
  const lines: PacingRow[] = staff ? [...pacing.rows, ...pacing.subRows] : [...pacing.rows, ...pacing.subRows].filter((r) => r.level !== "UNBUDGETED" && !r.notConnected);
  if (lines.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{staff ? "Budget lines" : "Budget"}</CardTitle>
        <CardDescription>
          {staff
            ? "Lines marked “sub-allocation” are paced individually but already included in a parent budget, so they are not added to the client total."
            : "Each budget and how it is tracking this period."}
        </CardDescription>
      </CardHeader>
      {/* Phones: one card per budget. */}
      <ul className="flex flex-col gap-2 px-3 md:hidden">
        {lines.map((r) => (
          <li key={r.key + (sub.has(r) ? ":sub" : "")} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{lineName(r, staff)}</p>
                <p className="text-xs text-text-3">{r.platforms.map((p) => PLATFORM_LABEL[p]).join(" + ")}{staff && sub.has(r) && " · sub-allocation"}</p>
              </div>
              {r.notConnected ? <NotConnectedBadge /> : r.result ? <StatusBadge status={displayPacingStatus(r.result).status} /> : <NoBudgetBadge />}
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div><dt className="text-text-3">Spent</dt><dd className="font-medium tabular">{r.notConnected ? "—" : formatMoney(r.result?.actualToDateMinor ?? r.unbudgetedSpendMinor, c, { whole: true })}</dd></div>
              <div><dt className="text-text-3">of</dt><dd className="font-medium tabular">{r.result ? formatMoney(r.result.budgetMinor, c, { whole: true }) : "—"}</dd></div>
              <div><dt className="text-text-3">Estimated end</dt><dd className="font-medium tabular">{r.result && !r.notConnected ? formatMoney(r.result.projectedMinor, c, { whole: true }) : "—"}</dd></div>
            </dl>
            {staff && <p className="mt-2 text-xs text-text-2">{r.action.headline}. {r.action.detail}</p>}
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
      <Table>
        <THead>
          <tr>
            <TH className="pl-5">{staff ? "Line" : "Budget"}</TH><TH>Status</TH><TH className="text-right">Amount</TH><TH className="text-right">Spent</TH>
            {staff ? (
              <><TH className="text-right">Spending pace</TH><TH className="text-right">Estimated end</TH><TH className="text-right" title="Remaining budget ÷ remaining days in the period, including today. An average: weighted budgets plan more on some days.">Avg. needed per day</TH><TH className="pr-5">Recommendation</TH></>
            ) : (
              <><TH className="text-right">Left</TH><TH className="pr-5 text-right">Estimated end</TH></>
            )}
          </tr>
        </THead>
        <TBody>
          {lines.map((r) => {
            const isSub = sub.has(r);
            return (
              <TR key={r.key + (isSub ? ":sub" : "")}>
                <TD className="pl-5">
                  <div className="font-medium">{lineName(r, staff)}</div>
                  <div className="text-xs text-text-3">{r.platforms.map((p) => PLATFORM_LABEL[p]).join(" + ")}{staff && isSub && " · sub-allocation"}{r.level === "UNBUDGETED" && " · not budgeted"}</div>
                </TD>
                <TD>{r.notConnected ? <NotConnectedBadge label={r.accounts.length ? "Awaiting first sync" : "Not connected"} /> : r.result ? <StatusBadge status={displayPacingStatus(r.result).status} /> : <NoBudgetBadge />}</TD>
                <TD className="text-right">{r.result ? formatMoney(r.result.budgetMinor, c, { whole: true }) : "—"}</TD>
                <TD className="text-right">{r.notConnected ? "—" : formatMoney(r.result?.actualToDateMinor ?? r.unbudgetedSpendMinor, c, { whole: true })}</TD>
                {staff ? (
                  <>
                    <TD className="text-right">{r.result && !r.notConnected && r.result.pacingPct !== null ? `${formatPct(r.result.pacingPct, 0)} of plan` : "—"}</TD>
                    <TD className="text-right">{r.result && !r.notConnected ? formatMoney(r.result.projectedMinor, c, { whole: true }) : "—"}</TD>
                    <TD className="text-right">{r.result?.requiredDailyMinor != null && !r.notConnected ? formatMoney(r.result.requiredDailyMinor, c, { whole: true }) : "—"}</TD>
                    <TD className="pr-5 text-xs text-text-2 whitespace-normal min-w-64">{r.action.headline}. {r.action.detail}</TD>
                  </>
                ) : (
                  <>
                    <TD className="text-right">{r.result && !r.notConnected ? formatMoney(r.result.remainingBudgetMinor, c, { whole: true }) : "—"}</TD>
                    <TD className="pr-5 text-right">{r.result && !r.notConnected ? `${formatMoney(r.result.projectedMinor, c, { whole: true })} (estimate)` : "—"}</TD>
                  </>
                )}
              </TR>
            );
          })}
        </TBody>
      </Table>
      </div>
      <div className="h-3" />
    </Card>
  );
}

/** Spend and results per ad account. With `status`, adds sync state and refresh (staff setup view). */
export function PlatformSection({ rep, staff, marker, status = false, title = "Platform breakdown" }: { rep: ClientReport; staff: boolean; marker?: ReactNode; status?: boolean; title?: string }) {
  const { client, perf, pacing, preset } = rep;
  const c = client.currency;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2"><CardTitle>{title}</CardTitle>{marker}</div>
        <CardDescription>{PRESET_LABEL[preset]} · each ad platform counts conversions in its own way.</CardDescription>
      </CardHeader>
      {/* Phones (report view): one card per account with the headline numbers. The setup view keeps the scrolling table for its sync controls. */}
      {!status && (
        <ul className="flex flex-col gap-2 px-3 md:hidden" aria-label="Ad accounts">
          {client.accounts.map((a) => {
            const m: MetricTotals | undefined = perf.byAccount[a.id];
            const x = m ? derive(m) : null;
            return (
              <li key={a.id} className="rounded-lg border border-border p-3">
                <PlatformLabel platform={a.platform} />
                <p className="truncate text-xs text-text-3">{a.name}</p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-text-3">Ad spend</dt><dd className="font-medium tabular">{m ? formatMoney(m.costMinor, c, { whole: true }) : "—"}{!a.spendIsVerified && <span className="block font-normal text-warning-ink">estimated</span>}</dd></div>
                  <div><dt className="text-text-3">Conversions</dt><dd className="font-medium tabular">{m ? formatNumber(m.conversions, 0) : "—"}</dd></div>
                  <div><dt className="text-text-3">Cost per conversion</dt><dd className="font-medium tabular">{x?.costPerConversionMinor == null ? "—" : formatMoney(x.costPerConversionMinor, c)}</dd></div>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
      <div className={status ? undefined : "hidden md:block"}>
      <Table>
        <THead>
          <tr>
            <TH className="pl-5">Account</TH>
            {(["spend", "impressions", "clicks", "ctr", "cpc", "conversions", "costPerConversion", "leads", "roas"] as const).map((k) => (
              <TH key={k} className={k === "roas" && !status ? "pr-5 text-right" : "text-right"}><KpiHead k={k} /></TH>
            ))}
            {status && <TH className="pr-5">Data status</TH>}
          </tr>
        </THead>
        <TBody>
          {client.accounts.map((a) => {
            const m: MetricTotals | undefined = perf.byAccount[a.id];
            const x = m ? derive(m) : null;
            const meta = pacing.accounts.find((p) => p.id === a.id)!;
            const lsa = a.platform === "GOOGLE_LSA";
            return (
              <TR key={a.id}>
                <TD className="pl-5">
                  <PlatformLabel platform={a.platform} />
                  <div className="text-xs text-text-3">{a.name} · {a.platform === "GOOGLE_ADS" && /^\d{10}$/.test(a.externalId) ? formatCustomerId(a.externalId) : a.externalId}</div>
                </TD>
                <TD className="text-right font-medium">{m ? formatMoney(m.costMinor, c, { whole: true }) : "—"}{!a.spendIsVerified && <div className="text-xs font-normal text-warning-ink">estimated</div>}</TD>
                <TD className="text-right">{lsa ? "n/a" : m ? formatNumber(m.impressions) : "—"}</TD>
                <TD className="text-right">{lsa ? "n/a" : m ? formatNumber(m.clicks) : "—"}</TD>
                <TD className="text-right">{lsa ? "n/a" : formatPct(x?.ctr ?? null, 2)}</TD>
                <TD className="text-right">{lsa || x?.cpcMinor == null ? (lsa ? "n/a" : "—") : formatMoney(x.cpcMinor, c)}</TD>
                <TD className="text-right">{m ? formatNumber(m.conversions, 0) : "—"}</TD>
                <TD className="text-right">{x?.costPerConversionMinor == null ? "—" : formatMoney(x.costPerConversionMinor, c)}</TD>
                <TD className="text-right">{m && (m.leads || m.leadsReported) ? formatNumber(m.leads) : "—"}</TD>
                <TD className={status ? "text-right" : "pr-5 text-right"}>{x?.roas == null || lsa ? "—" : `${x.roas.toFixed(2)}×`}</TD>
                {status && (
                  <TD className="pr-5 text-xs">
                    <div className="flex flex-col items-start gap-1">
                      {isAccountRetired(a) ? <span className="text-text-3">No longer synced</span> : isAccountDisconnected(a) ? <StaleBadge label="Disconnected" /> : !meta.lastSuccessfulSyncAt ? <StaleBadge label="Not synced yet" /> : meta.stale ? <StaleBadge /> : <span className="text-text-2">Synced {relativeTime(meta.lastSuccessfulSyncAt).toLowerCase()}</span>}
                      {meta.dataCompleteThrough && <span className="text-text-3">Complete through {formatDate(meta.dataCompleteThrough)}</span>}
                      {a.timezone && a.timezone !== client.timezone && <span className="text-warning-ink">Account time zone: {a.timezone}</span>}
                      {a.isDemo ? <span className="text-info-ink">Demo data</span> : staff && a.connectionId && <RefreshAccountButton accountId={a.id} />}
                      {staff && a.syncRuns[0]?.status === "FAILED" && <span className="flex items-start gap-1 text-critical-ink whitespace-normal max-w-56"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{a.syncRuns[0].error}</span>}
                    </div>
                  </TD>
                )}
              </TR>
            );
          })}
        </TBody>
      </Table>
      </div>
      {client.accounts.some((a) => a.platform === "GOOGLE_LSA") && (
        <p className="px-5 pt-3 text-xs text-text-3">
          Google Local Services Ads: spend shown is <strong className="font-medium text-text-2">estimated</strong> from charged leads × lead cost, because the LSA reporting API does not provide verified daily ad spend. Treat it as an estimate, not billed spend.
        </p>
      )}
      <div className="h-4" />
    </Card>
  );
}

/** A table header with the KPI's full name and its ⓘ definition. */
function KpiHead({ k }: { k: KpiKey }) {
  const def = KPI_BY_KEY[k];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {def.label}
      <InfoTip label={def.label} text={def.plain} align="end" />
    </span>
  );
}

/** Chart notes a viewer may see: all of them for staff, only client-visible ones otherwise. */
export const notesFor = (rep: ClientReport, staff: boolean) => rep.notes.filter((n) => staff || n.clientVisible).map((n) => ({ date: n.date, text: n.text }));

export function TrendsSection({ rep, marker, metrics, title = "Performance trends", staff = false }: { rep: ClientReport; marker?: ReactNode; metrics?: KpiKey[]; title?: string; staff?: boolean }) {
  const { range, cmpRange, perf, cmpPerf, template, client } = rep;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2"><CardTitle>{title}</CardTitle>{marker}</div>
        <CardDescription>Daily values, {formatDate(range.from)} – {formatDate(range.to)}{cmpRange && " with the comparison period (dashed) aligned day-by-day"}.</CardDescription>
      </CardHeader>
      <CardContent>
        {noActivity(rep) ? (
          <p className="py-6 text-center text-sm text-text-3">No activity in this period, so there is nothing to chart yet.</p>
        ) : (
        <TrendChart current={perf.byDate} comparison={cmpPerf?.byDate ?? null} currency={client.currency} metrics={metrics ?? [...new Set([...template.trendKpis, ...TREND_EXTRAS])]} notes={notesFor(rep, staff)} />
        )}
      </CardContent>
    </Card>
  );
}

export function campaignRows(rep: ClientReport, platform?: PlatformKey): CampaignRow[] {
  // Only the accounts the page adds up (the account selector, one currency), and one platform when asked.
  const ids = rep.accountScope?.ids;
  return rep.client.accounts.filter((a) => (!ids || ids.includes(a.id)) && (!platform || a.platform === platform)).flatMap((a) =>
    a.campaigns.map((cmp) => {
      const m = rep.perf.byCampaign[cmp.id];
      return {
        id: cmp.id,
        name: cmp.name,
        platform: a.platform,
        status: cmp.status,
        costMinor: m?.costMinor ?? 0,
        clicks: m?.clicks ?? 0,
        conversions: m?.conversions ?? 0,
        conversionValueMinor: m?.conversionValueMinor ?? 0,
        impressions: m?.impressions ?? 0,
        leads: m?.leads ?? 0,
        accountId: a.id,
        accountName: a.name,
      };
    }),
  );
}

export function CampaignsSection({ rep, staff, basePath, marker, detail, description, platform }: { rep: ClientReport; staff: boolean; basePath: string; marker?: ReactNode; detail?: { clientId: string; params: ReportParams }; description?: string; platform?: PlatformKey }) {
  const { preset, range } = rep;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2"><CardTitle>Campaigns</CardTitle>{marker}</div>
          {staff && <Link href={`${basePath}/campaigns?range=${preset}&from=${range.from}&to=${range.to}`} className="text-sm font-medium text-brand-text hover:underline">Add or remove campaigns</Link>}
        </div>
        <CardDescription>{description ?? `${PRESET_LABEL[preset]} · sorted by spend. Click a column to re-sort.`}</CardDescription>
      </CardHeader>
      <CampaignTable rows={campaignRows(rep, platform)} currency={rep.client.currency} detail={detail} />
      <div className="h-4" />
    </Card>
  );
}

/**
 * Previous months: budget, actual spend, variance and the final result. `bare`
 * drops the card and heading (inside the Budgets tab's "View budget history").
 */
export function HistorySection({ rep, marker, hideEmpty = false, bare = false }: { rep: ClientReport; marker?: ReactNode; hideEmpty?: boolean; bare?: boolean }) {
  const c = rep.client.currency;
  const rows = hideEmpty ? rep.history.filter((h) => h.total) : rep.history;
  if (rows.length === 0) return bare ? <p className="text-sm text-text-3">No budgets were set for previous months yet.</p> : null;
  const body = (
    <>
      {/* Phones: one card per month. */}
      <ul className="flex flex-col gap-2 px-3 md:hidden" aria-label="Previous months">
        {rows.map((h) => {
          const r = h.total;
          return (
            <li key={h.period.start} className="rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{formatDate(h.period.start, { month: "long", year: "numeric" })}</p>
                {r ? <StatusBadge status={r.status} /> : <NoBudgetBadge />}
              </div>
              {r && (
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-text-3">Spent</dt><dd className="font-medium tabular">{formatMoney(r.actualToDateMinor, c, { whole: true })}</dd></div>
                  <div><dt className="text-text-3">of</dt><dd className="font-medium tabular">{formatMoney(r.budgetMinor, c, { whole: true })}</dd></div>
                  <div><dt className="text-text-3">Used</dt><dd className="font-medium tabular">{formatPct(r.pctBudgetConsumed)}</dd></div>
                </dl>
              )}
            </li>
          );
        })}
      </ul>
      <div className="hidden md:block">
      <Table>
        <THead>
          <tr><TH className="pl-5">Month</TH><TH className="text-right">Budget</TH><TH className="text-right">Actual spend</TH><TH className="text-right">Variance</TH><TH className="text-right">Budget used</TH><TH className="pr-5">Final status</TH></tr>
        </THead>
        <TBody>
          {rows.map((h) => {
            const r = h.total;
            return (
              <TR key={h.period.start}>
                <TD className="pl-5">{formatDate(h.period.start, { month: "long", year: "numeric" })}</TD>
                <TD className="text-right">{r ? formatMoney(r.budgetMinor, c, { whole: true }) : "—"}</TD>
                <TD className="text-right">{r ? formatMoney(r.actualToDateMinor, c, { whole: true }) : "—"}</TD>
                <TD className="text-right">{r ? `${r.actualToDateMinor - r.budgetMinor >= 0 ? "+" : "−"}${formatMoney(Math.abs(r.actualToDateMinor - r.budgetMinor), c, { whole: true })}` : "—"}</TD>
                <TD className="text-right">{r ? formatPct(r.pctBudgetConsumed) : "—"}</TD>
                <TD className="pr-5">{r ? <StatusBadge status={r.status} /> : <NoBudgetBadge />}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      </div>
    </>
  );
  if (bare) return <div className="-mx-4 -mb-4">{body}</div>;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2"><CardTitle>Historical budget performance</CardTitle>{marker}</div>
        <CardDescription>Final spend against budget for previous months.</CardDescription>
      </CardHeader>
      {body}
      <div className="h-4" />
    </Card>
  );
}

/**
 * "Synced 59 min ago · complete through Oct 20" for the report header. Turns
 * amber (for staff) when any account is stale, disconnected or failing.
 */
export function DataFreshness({ rep, staff, setupHref }: { rep: Pick<ClientReport, "client" | "pacing">; staff: boolean; setupHref?: string }) {
  const { client, pacing } = rep;
  const metas = pacing.accounts;
  if (metas.length === 0) {
    return staff ? (
      <Link href={setupHref ?? `/clients/${client.id}/accounts`} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs text-text-2 hover:text-text">
        <Unplug className="h-3.5 w-3.5" aria-hidden /> No ad accounts linked
      </Link>
    ) : null;
  }
  const syncs = metas.map((a) => a.lastSuccessfulSyncAt).filter((s): s is string => !!s).sort();
  const through = metas.map((a) => a.dataCompleteThrough).filter((d): d is string => !!d).sort();
  const problems = client.accounts.filter((a) => {
    const m = metas.find((x) => x.id === a.id);
    if (isAccountRetired(a)) return false;
    return isAccountDisconnected(a) || a.syncRuns[0]?.status === "FAILED" || (m && !m.isDemo && (m.stale || !m.lastSuccessfulSyncAt));
  });
  const warn = staff && problems.length > 0;
  const parts = [
    syncs.length ? `Synced ${relativeTime(syncs[0]).toLowerCase()}` : "Not synced yet",
    through.length ? `complete through ${formatDate(through[0])}` : null,
    warn ? `${problems.length} account${problems.length === 1 ? "" : "s"} need${problems.length === 1 ? "s" : ""} attention` : null,
  ].filter(Boolean);
  const cls = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${warn ? "bg-warning-bg text-warning-ink" : "border border-border bg-surface-2 text-text-2"}`;
  const Icon = warn ? AlertTriangle : RefreshCw;
  const body = (
    <>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {parts.join(" · ")}
    </>
  );
  return staff && setupHref ? (
    <Link href={setupHref} className={`${cls} hover:underline`} title={syncs.length > 1 ? "Oldest sync across this client's accounts" : undefined}>{body}</Link>
  ) : (
    <span className={cls}>{body}</span>
  );
}

/** Empty state for a client with no ad accounts: says what to do next instead of showing $0 everywhere. */
export function NoAccountsState({ rep, staff }: { rep: ClientReport; staff: boolean }) {
  const href = `/clients/${rep.client.id}/accounts`;
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <Plug className="mt-0.5 h-5 w-5 shrink-0 text-text-3" aria-hidden />
          <div>
            <p className="font-medium">{staff ? `No ad accounts are linked to ${rep.client.name} yet` : "Your report is being set up"}</p>
            <p className="text-sm text-text-2">
              {staff ? "Connect Google Ads, Meta, Microsoft Advertising or Local Services Ads and link this client's account. About 13 months of history imports automatically." : "Figures appear here once your agency connects your advertising accounts."}
            </p>
          </div>
        </div>
        {staff && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link href={href} className={buttonVariants()}>Connect Google Ads</Link>
            <Link href={href} className={buttonVariants({ variant: "outline" })}>Other platforms</Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** True when the report's range has no spend, clicks, impressions, conversions or leads at all. */
export function noActivity(rep: ClientReport): boolean {
  const t = rep.perf.totals;
  return t.costMinor === 0 && t.clicks === 0 && t.impressions === 0 && t.conversions === 0 && t.leads === 0;
}
