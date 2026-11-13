"use client";

import { useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import { formatMetric, type MetricInfo } from "@/lib/dashboards/metrics";
import { formatDate } from "@/lib/time";
import { isAdditiveMetric, summarizeSeries } from "@/lib/chart-summary";
import { ChartSummary, ChartTable, MetricToggle } from "./chart-table";

/**
 * Daily values of one or more metrics (one shown at a time, chosen with the
 * tabs), with the comparison period dashed and aligned day-by-day. The same
 * look as TrendChart, for any dashboard metric. Fills its parent's height.
 */
export function SeriesChart({
  dates,
  metrics,
  current,
  previous,
  previousDates,
  currency = "USD",
  type = "line",
}: {
  dates: string[];
  metrics: MetricInfo[];
  current: Record<string, (number | null)[]>;
  previous: Record<string, (number | null)[]> | null;
  previousDates: string[] | null;
  currency?: string;
  type?: "line" | "bar" | "area";
}) {
  const [selected, setSelected] = useState(metrics[0]?.key ?? "");
  const m = metrics.find((x) => x.key === selected) ?? metrics[0];
  if (!m) return null;
  const data = dates.map((date, i) => ({
    date,
    current: current[m.key]?.[i] ?? null,
    previous: previous?.[m.key]?.[i] ?? null,
    previousDate: previousDates?.[i] ?? null,
  }));
  const fmt = (v: number | null) => formatMetric(m, v, currency);
  const summary = summarizeSeries({
    label: m.label,
    dates,
    values: data.map((d) => d.current),
    // Additive metrics compare whole-period totals; the comparison series is aligned day by day.
    previous: previous ? previous[m.key] ?? null : null,
    additive: isAdditiveMetric(m.key),
    count: m.format === "count",
    format: (v) => fmt(v),
  });

  function Tip({ active, payload }: TooltipProps<number, string>) {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload as (typeof data)[number];
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-sm">
        <div className="flex justify-between gap-4"><span className="text-text-2">{formatDate(p.date)}</span><span className="font-medium tabular">{formatMetric(m, p.current, currency)}</span></div>
        {p.previousDate && <div className="flex justify-between gap-4"><span className="text-text-3">{formatDate(p.previousDate)}</span><span className="tabular text-text-2">{formatMetric(m, p.previous, currency)}</span></div>}
      </div>
    );
  }

  const axes = (
    <>
      <CartesianGrid stroke="var(--grid)" vertical={false} />
      <XAxis dataKey="date" tickFormatter={(d) => formatDate(d)} tick={{ fill: "var(--text-3)", fontSize: 11 }} axisLine={{ stroke: "var(--border)" }} tickLine={false} minTickGap={24} />
      <YAxis tickFormatter={(v) => formatMetric(m, v, currency, { axis: true })} tick={{ fill: "var(--text-3)", fontSize: 11 }} axisLine={false} tickLine={false} width={56} reversed={m.format === "position"} />
    </>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {(metrics.length > 1 || previous) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {metrics.length > 1 ? (
            <MetricToggle options={metrics.map((x) => ({ key: x.key, label: x.short }))} value={m.key} onChange={setSelected} />
          ) : <span />}
          {previous && (
            <div className="flex gap-3 text-xs text-text-3">
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded bg-[var(--series-actual)]" /> Selected</span>
              <span className="flex items-center gap-1.5"><span className="h-0 w-3 border-t-2 border-dashed border-[var(--series-planned)]" /> Comparison</span>
            </div>
          )}
        </div>
      )}
      <ChartSummary text={summary} className="mb-1 line-clamp-2" />
      <div className="min-h-0 flex-1" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          {type === "bar" ? (
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
              {axes}
              <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
              {previous && <Bar dataKey="previous" fill="var(--series-planned)" fillOpacity={0.35} radius={[2, 2, 0, 0]} isAnimationActive={false} />}
              <Bar dataKey="current" fill="var(--series-actual)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
            </BarChart>
          ) : type === "area" ? (
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              {axes}
              <Tooltip content={<Tip />} cursor={{ stroke: "var(--text-3)", strokeWidth: 1 }} />
              {previous && <Line dataKey="previous" stroke="var(--series-planned)" strokeWidth={2} strokeDasharray="4 4" dot={false} isAnimationActive={false} connectNulls />}
              <Area dataKey="current" stroke="var(--series-actual)" strokeWidth={2} fill="var(--series-actual)" fillOpacity={0.15} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} connectNulls />
            </AreaChart>
          ) : (
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              {axes}
              <Tooltip content={<Tip />} cursor={{ stroke: "var(--text-3)", strokeWidth: 1 }} />
              {previous && <Line dataKey="previous" stroke="var(--series-planned)" strokeWidth={2} strokeDasharray="4 4" dot={false} isAnimationActive={false} connectNulls />}
              <Line dataKey="current" stroke="var(--series-actual)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} connectNulls />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      <ChartTable
        caption={`${m.label} by day`}
        columns={previous ? ["Date", m.label, "Comparison date", "Comparison"] : ["Date", m.label]}
        rows={data.map((d) => (previous ? [formatDate(d.date), fmt(d.current), d.previousDate ? formatDate(d.previousDate) : "—", fmt(d.previous)] : [formatDate(d.date), fmt(d.current)]))}
        className="mt-1 shrink-0"
        overlay
      />
    </div>
  );
}
