"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { PlayCircle, Plug } from "lucide-react";
import { formatMetric } from "@/lib/dashboards/metrics";
import { widgetTitle } from "@/lib/dashboards/describe";
import type { DashboardWidget } from "@/lib/dashboards/types";
import type { CallLogRow, FormLogRow, WidgetData } from "@/lib/dashboards/widget-data";
import { changeWords, shortChangeWords } from "@/lib/change";
import { InfoTip } from "@/components/ui/info-tip";
import { SeriesChart } from "@/components/charts/series-chart";
import { BreakdownBarChart, MetricPieChart } from "@/components/charts/breakdown-charts";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/components/ui/cn";
import { TextContent } from "./text-content";


/** Server-rendered ad sections (budget pacing, campaign table) reused as widgets. */
export interface AdSlots {
  pacing?: ReactNode;
  campaigns?: ReactNode;
}

export interface WidgetViewProps {
  widget: DashboardWidget;
  /** undefined while loading (editor previews). */
  data: WidgetData | undefined;
  currency: string;
  slots?: AdSlots;
  /** Staff get a "Connect" link on not-connected empty states. */
  staff?: boolean;
  /** "grid": fill the grid cell on tablets and up, natural height on phones. "always": fill the parent (editor). */
  fill?: "grid" | "always";
}

/** One widget as it appears on a dashboard: a card with its title and content. */
export function WidgetView({ widget, data, currency, slots, staff = false, fill = "grid" }: WidgetViewProps) {
  const title = widgetTitle(widget);
  const fillCls = fill === "always" ? "h-full overflow-hidden" : "md:h-full";
  if ((widget.kind === "pacing" || widget.kind === "campaigns") && data?.kind === widget.kind) {
    const slot = slots?.[widget.kind];
    return <div className={cn("flex flex-col gap-3", fill === "always" ? "h-full overflow-hidden" : "md:h-full md:overflow-auto")}>{slot ?? <Placeholder text="Shown with the client's data." />}</div>;
  }
  if (widget.kind === "kpi" && data?.kind === "kpi") return <KpiWidget title={title} data={data} currency={currency} fillCls={fillCls} hideChange={widget.hideChange} />;
  const chart = widget.kind === "line" || widget.kind === "area" || widget.kind === "bar" || widget.kind === "pie";
  return (
    <section aria-label={title || "Note"} className={cn("flex min-w-0 flex-col rounded-xl border border-border bg-surface", chart && fill === "grid" && "h-72", fillCls, widget.kind === "text" && "border-transparent bg-transparent")}>
      {title && (
        <header className="px-4 pt-3 pb-2">
          <h3 className="truncate text-sm font-semibold" title={title}>{title}</h3>
        </header>
      )}
      <div className={cn("min-h-0 flex-1 px-4 pb-3", !title && "pt-3", (widget.kind === "table" || widget.kind === "rankings" || widget.kind === "calllog" || widget.kind === "formlog") && "overflow-auto px-0", widget.kind === "text" && "overflow-auto")}>
        <WidgetBody widget={widget} data={data} currency={currency} staff={staff} />
      </div>
    </section>
  );
}

function WidgetBody({ widget, data, currency, staff }: { widget: DashboardWidget; data: WidgetData | undefined; currency: string; staff: boolean }) {
  if (widget.kind === "text") return <TextContent text={widget.text ?? ""} />;
  if (!data) return <Skeleton className="h-full min-h-16 w-full" />;
  if (data.kind === "empty") return <EmptyState data={data} staff={staff} />;
  switch (data.kind) {
    case "series":
      return <SeriesChart dates={data.dates} metrics={data.metrics} current={data.current} previous={data.previous} previousDates={data.previousDates} currency={currency} type={widget.kind === "bar" ? "bar" : widget.kind === "area" ? "area" : "line"} />;
    case "breakdown":
      if (widget.kind === "pie") return <MetricPieChart rows={data.rows} metric={data.metrics[0]} currency={currency} />;
      if (widget.kind === "bar") return <BreakdownBarChart rows={data.rows} metric={data.metrics[0]} currency={currency} />;
      return (
        <Table>
          <THead>
            <tr>
              <TH className="pl-4">{data.dimensionLabel}</TH>
              {data.metrics.map((m, i) => <TH key={m.key} className={cn("text-right", i === data.metrics.length - 1 && "pr-4")}>{m.short}</TH>)}
            </tr>
          </THead>
          <TBody>
            {data.rows.map((r, ri) => (
              <TR key={`${r.label}-${ri}`}>
                <TD className="max-w-72 truncate pl-4" title={r.label}>{r.label}</TD>
                {data.metrics.map((m, i) => <TD key={m.key} className={cn("text-right", i === data.metrics.length - 1 && "pr-4")}>{formatMetric(m, r.values[m.key], currency)}</TD>)}
              </TR>
            ))}
          </TBody>
        </Table>
      );
    case "rankings":
      return (
        <Table>
          <THead>
            <tr>
              <TH className="pl-4">Keyword</TH>
              <TH className="text-right">Position</TH>
              {data.hasComparison && <TH className="text-right">Change</TH>}
              <TH className="pr-4">Ranking page</TH>
            </tr>
          </THead>
          <TBody>
            {data.rows.map((r) => {
              const change = r.position !== null && r.previous !== null ? r.previous - r.position : null;
              return (
                <TR key={`${r.keyword}-${r.location ?? ""}`}>
                  <TD className="max-w-64 truncate pl-4" title={r.keyword}>{r.keyword}{r.location && <span className="block text-xs text-text-3">{r.location}</span>}</TD>
                  <TD className="text-right font-medium">{r.position === null ? "—" : r.position}</TD>
                  {data.hasComparison && (
                    <TD className={cn("text-right", change === null || change === 0 ? "text-text-3" : change > 0 ? "text-good-ink" : "text-critical-ink")}>
                      {change === null ? (r.previous === null && r.position !== null ? "new" : "—") : change === 0 ? "0" : `${change > 0 ? "▲" : "▼"} ${Math.abs(change)}`}
                    </TD>
                  )}
                  <TD className="max-w-64 truncate pr-4 text-xs text-text-3" title={r.url ?? undefined}>{r.url ? r.url.replace(/^https?:\/\/(www\.)?/, "") : "—"}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      );
    case "calllog":
      return <CallLog rows={data.rows} total={data.total} timeZone={data.timeZone} />;
    case "formlog":
      return <FormLog rows={data.rows} total={data.total} timeZone={data.timeZone} />;
    default:
      return null;
  }
}

function callTime(iso: string, timeZone: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).format(new Date(iso));
  }
}

/** "+15125550100" → "(512) 555-0100"; anything else as stored. */
function phone(n: string | null): string {
  if (!n) return "—";
  const d = n.replace(/\D/g, "");
  const us = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return us.length === 10 ? `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}` : n;
}

function YesNo({ yes }: { yes: boolean }) {
  return <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", yes ? "bg-good-bg text-good-ink" : "bg-critical-bg text-critical-ink")}>{yes ? "Yes" : "No"}</span>;
}

function LogFooter({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  return <p className="px-4 pt-2 text-xs text-text-3">Showing {shown.toLocaleString("en-US")} of {total.toLocaleString("en-US")} {noun}{total > shown ? " (latest first)" : ""}.</p>;
}

/** Recent calls, newest first, in the same columns as AgencyAnalytics' CallRail call table. */
function CallLog({ rows, total, timeZone }: { rows: CallLogRow[]; total: number; timeZone: string | null }) {
  const withRecordings = rows.some((r) => r.recordingUrl);
  return (
    <div className="flex flex-col">
      <Table>
        <THead>
          <tr>
            <TH className="pl-4">Date</TH>
            <TH>Name</TH>
            <TH>Source</TH>
            <TH>Phone number</TH>
            <TH>Answered</TH>
            <TH>First call</TH>
            <TH>Keywords</TH>
            <TH className={cn(!withRecordings && "pr-4")}>Campaign</TH>
            {withRecordings && <TH className="pr-4">Recording</TH>}
          </tr>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.id}>
              <TD className="pl-4 whitespace-nowrap text-text-2">{callTime(r.startedAt, timeZone)}</TD>
              <TD className="max-w-48 truncate font-medium" title={r.callerName ?? undefined}>{r.callerName || "Unknown caller"}{r.status === "voicemail" && <span className="ml-1.5 text-xs font-normal text-text-3">voicemail</span>}</TD>
              <TD className="max-w-44 truncate" title={r.source ?? undefined}>{r.source || "—"}</TD>
              <TD className="whitespace-nowrap tabular">{phone(r.callerNumber)}</TD>
              <TD><YesNo yes={r.status === "answered"} /></TD>
              <TD><YesNo yes={r.firstCall} /></TD>
              <TD className="max-w-44 truncate text-text-2" title={r.keyword ?? undefined}>{r.keyword || "—"}</TD>
              <TD className={cn("max-w-44 truncate text-text-2", !withRecordings && "pr-4")} title={r.campaign ?? undefined}>{r.campaign || "—"}</TD>
              {withRecordings && (
                <TD className="pr-4">
                  {r.recordingUrl ? (
                    <a href={r.recordingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
                      <PlayCircle className="h-3.5 w-3.5" aria-hidden /> Listen
                    </a>
                  ) : <span className="text-text-3">—</span>}
                </TD>
              )}
            </TR>
          ))}
        </TBody>
      </Table>
      <LogFooter shown={rows.length} total={total} noun="calls" />
    </div>
  );
}

/** Recent form submissions, in the same columns as AgencyAnalytics' CallRail forms table. */
function FormLog({ rows, total, timeZone }: { rows: FormLogRow[]; total: number; timeZone: string | null }) {
  return (
    <div className="flex flex-col">
      <Table>
        <THead>
          <tr>
            <TH className="pl-4">Date</TH>
            <TH>Name</TH>
            <TH>Form URL</TH>
            <TH>Referrer</TH>
            <TH>Referring URL</TH>
            <TH className="pr-4">First submission</TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.id}>
              <TD className="pl-4 whitespace-nowrap text-text-2">{callTime(r.submittedAt, timeZone)}</TD>
              <TD className="max-w-48 truncate font-medium" title={r.name ?? undefined}>{r.name || "—"}</TD>
              <TD className="max-w-56 truncate text-text-2" title={r.formUrl ?? undefined}>{r.formUrl || "—"}</TD>
              <TD className="max-w-44 truncate" title={r.referrer ?? undefined}>{r.referrer || "—"}</TD>
              <TD className="max-w-56 truncate text-text-2" title={r.referringUrl ?? undefined}>{r.referringUrl ? r.referringUrl.replace(/^https?:\/\/(www\.)?/, "") : "—"}</TD>
              <TD className="pr-4"><YesNo yes={r.firstForm} /></TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <LogFooter shown={rows.length} total={total} noun="submissions" />
    </div>
  );
}

/** Good news green, bad news red, neutral grey: decided per metric (lower cost per conversion is good). */
const TONE_TEXT = { good: "text-good-ink", bad: "text-critical-ink", neutral: "text-text-2" } as const;

function KpiWidget({ title, data, currency, fillCls, hideChange = false }: { title: string; data: Extract<WidgetData, { kind: "kpi" }>; currency: string; fillCls: string; hideChange?: boolean }) {
  // Same wording as the report tiles: "Up 8% from 120 · better", "About the same as 120", "Too few to compare".
  const verdict = data.verdict ?? (data.tone === "good" ? "better" : data.tone === "bad" ? "worse" : data.metric.better === "neutral" ? "neutral" : "same");
  const words = changeWords(verdict, data.changePct, formatMetric(data.metric, data.previous, currency), data.metric.label);
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface px-4 py-3", fillCls)}>
      <h3 className="flex min-w-0 items-center gap-1 text-xs leading-tight text-text-3">
        <span className="truncate">{title}</span>
        <InfoTip label={data.metric.label} text={data.metric.plain ?? data.metric.description} />
      </h3>
      <p className="truncate text-xl font-semibold tabular">{formatMetric(data.metric, data.value, currency)}</p>
      {!hideChange && <p className="flex min-w-0 items-center gap-1 text-xs tabular">
        {data.changePct === null ? (
          <span className="text-text-3" title={data.notTracked ? "None of the included ad accounts report this, so there's nothing to show." : undefined}>{data.notTracked ? "Not tracked for this client" : data.value === null ? "Not reported" : data.hasComparison ? "No comparison data" : "No comparison"}</span>
        ) : (
          // Short label on the tile; the full wording ("Up 93% from 14 · better") on hover and for screen readers.
          <span className={cn("truncate", verdict === "few" || verdict === "same" ? "text-text-3" : TONE_TEXT[data.tone ?? "neutral"])} title={words.text}>
            <span aria-hidden>{shortChangeWords(verdict, data.changePct, data.vsLabel ?? "previous period")}</span>
            <span className="sr-only">{words.aria}</span>
          </span>
        )}
      </p>}
      <FluidSparkline values={data.spark} />
    </section>
  );
}

/** A sparkline that stretches to the card's width and remaining height. */
function FluidSparkline({ values }: { values: (number | null)[] }) {
  const pts = values.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => p.v !== null && Number.isFinite(p.v));
  if (pts.length < 2) return null;
  const min = Math.min(...pts.map((p) => p.v));
  const span = Math.max(...pts.map((p) => p.v)) - min || 1;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * 100;
  const y = (v: number) => 28 - ((v - min) / span) * 26;
  const d = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-auto h-6 min-h-6 w-full md:h-auto md:max-h-16 md:flex-1" aria-hidden>
      <path d={d} fill="none" stroke="var(--series-actual)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function EmptyState({ data, staff }: { data: Extract<WidgetData, { kind: "empty" }>; staff: boolean }) {
  const connect = data.reason === "not_connected";
  const href = data.source === "ads" ? null : "/integrations";
  return (
    <div className="flex h-full min-h-16 flex-col items-center justify-center gap-1.5 rounded-lg bg-surface-2 px-3 py-4 text-center">
      {connect && <Plug className="h-4 w-4 text-text-3" aria-hidden />}
      <p className="text-xs text-text-2">{connect && !staff ? "Not connected yet" : data.message}</p>
      {connect && staff && href && <Link href={href} className="text-xs font-medium text-brand-text hover:underline">Go to Integrations</Link>}
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return <div className="flex h-full min-h-24 items-center justify-center rounded-xl border border-dashed border-border text-xs text-text-3">{text}</div>;
}
