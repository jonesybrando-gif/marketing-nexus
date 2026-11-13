"use client";

import { useMemo, useState } from "react";
import { AreaChart, BarChart3, Hash, LineChart, ListOrdered, Phone, PieChart, Plug, Table2, Type, Wallet, X } from "lucide-react";
import type { MetricSource } from "@/lib/metrics-registry";
import { dimensionsFor, metricsFor, SOURCE_LABEL, SOURCE_ORDER } from "@/lib/dashboards/metrics";
import { KIND_LABEL } from "@/lib/dashboards/describe";
import { METRIC_LIMITS } from "@/lib/dashboards/parse";
import type { WidgetKind } from "@/lib/dashboards/types";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";

export type LibraryTab = MetricSource | "text";

/** What the library asks the editor to add: one widget per entry. */
export interface WidgetDraft {
  kind: WidgetKind;
  metrics?: string[];
  dimension?: string;
  text?: string;
  title?: string;
}

const KIND_ICON: Record<WidgetKind, typeof Hash> = { kpi: Hash, line: LineChart, area: AreaChart, bar: BarChart3, table: Table2, pie: PieChart, rankings: ListOrdered, calllog: Phone, formlog: Table2, text: Type, pacing: Wallet, campaigns: Table2 };

const METRIC_KINDS: WidgetKind[] = ["kpi", "line", "area", "bar", "table", "pie"];

/** Widget kinds a source offers in the library. */
export function kindsFor(tab: LibraryTab): WidgetKind[] {
  if (tab === "text") return ["text"];
  const hasMetrics = metricsFor(tab).length > 0;
  const hasDims = dimensionsFor(tab).length > 0;
  const metricKinds = hasMetrics ? METRIC_KINDS.filter((k) => hasDims || (k !== "table" && k !== "pie")) : [];
  if (tab === "ads") return [...metricKinds, "pacing", "campaigns"];
  if (tab === "rank") return ["rankings", ...metricKinds];
  if (tab === "callrail") return [...metricKinds, "calllog", "formlog"];
  return metricKinds;
}

const TABS: LibraryTab[] = [...SOURCE_ORDER, "text"];
const tabLabel = (t: LibraryTab) => (t === "text" ? "Text" : SOURCE_LABEL[t]);

/** Side panel listing widgets by source. Pick a type and metrics, then add. */
export function WidgetLibrary({ linked, templateMode, onAdd, onClose, full, initialTab = "ads", initialKind, heading }: { linked: MetricSource[]; templateMode: boolean; onAdd: (drafts: WidgetDraft[]) => void; onClose: () => void; full: boolean; initialTab?: LibraryTab; initialKind?: WidgetKind; heading?: string }) {
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const kinds = kindsFor(tab);
  const [kind, setKind] = useState<WidgetKind | null>(initialKind && kinds.includes(initialKind) ? initialKind : kinds[0] ?? null);
  const [picked, setPicked] = useState<string[]>([]);
  const [dimension, setDimension] = useState("");
  const metrics = tab === "text" ? [] : metricsFor(tab);
  const dims = tab === "text" ? [] : dimensionsFor(tab);
  const limits = kind ? METRIC_LIMITS[kind] : undefined;
  // KPI: each picked metric becomes its own tile.
  const max = kind === "kpi" ? 12 : limits?.max ?? 0;
  const needsDim = kind === "table" || kind === "pie";
  const allowsDim = needsDim || kind === "bar";
  const dim = needsDim ? dimension || dims[0]?.dimension || "" : dimension;
  const notLinked = !templateMode && tab !== "text" && !linked.includes(tab);

  const chooseTab = (t: LibraryTab) => {
    setTab(t);
    setKind(kindsFor(t)[0] ?? null);
    setPicked([]);
    setDimension("");
  };
  const chooseKind = (k: WidgetKind) => {
    setKind(k);
    const lim = k === "kpi" ? 12 : METRIC_LIMITS[k]?.max ?? 0;
    setPicked((p) => p.slice(0, lim));
  };
  const toggle = (key: string) =>
    setPicked((p) => (p.includes(key) ? p.filter((x) => x !== key) : max === 1 ? [key] : p.length >= max ? p : [...p, key]));

  const ready = !!kind && (!limits || picked.length >= limits.min) && (!needsDim || !!dim) && !full;
  const add = () => {
    if (!kind || !ready) return;
    if (kind === "kpi") onAdd(picked.map((m) => ({ kind, metrics: [m] })));
    else if (limits) onAdd([{ kind, metrics: picked, ...(allowsDim && dim ? { dimension: dim } : {}) }]);
    else if (kind === "text") onAdd([{ kind, text: "## Heading\nWrite a note for the client here." }]);
    else onAdd([{ kind }]);
    setPicked([]);
  };

  const hint = useMemo(() => {
    if (!kind) return null;
    if (kind === "kpi") return "Each metric becomes its own KPI tile with change and sparkline.";
    if (kind === "line" || kind === "bar") return `Daily values${kind === "bar" ? " (or a breakdown)" : ""}; up to ${max} metrics, switchable on the chart.`;
    if (kind === "table") return `Top rows by the first metric; up to ${max} columns.`;
    if (kind === "pie") return "Share of one metric by a breakdown.";
    if (kind === "rankings") return "Tracked keyword positions and their change.";
    if (kind === "calllog") return "The most recent calls: date, caller, source, phone number, answered, first call, keywords, campaign and recording.";
    if (kind === "formlog") return "The most recent form submissions: date, name, form URL, referrer and first submission.";
    if (kind === "pacing") return "The budget pacing chart and figures for the current period.";
    if (kind === "campaigns") return "The sortable campaign table for the selected range.";
    return "A heading or note. Supports # headings, - bullets and **bold**.";
  }, [kind, max]);

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-border bg-surface shadow-xl" aria-label="Add a widget">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{heading ?? "Add a widget"}</h2>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close widget library"><X className="h-4 w-4" aria-hidden /></Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-36 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2" aria-label="Sources">
          {TABS.map((t) => (
            <button key={t} type="button" onClick={() => chooseTab(t)} aria-current={tab === t ? "true" : undefined} className={cn("flex items-center justify-between gap-1 rounded-md px-2.5 py-1.5 text-left text-sm cursor-pointer", tab === t ? "bg-surface-2 font-medium text-text ring-1 ring-border" : "text-text-2 hover:text-text")}>
              <span className="truncate">{tabLabel(t)}</span>
              {!templateMode && t !== "text" && !linked.includes(t) && <Plug className="h-3 w-3 shrink-0 text-text-3" aria-label="not connected" />}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {notLinked && <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-text-2">{tab === "ads" ? "No ad accounts are linked to this client." : `${tabLabel(tab)} isn't connected for this client.`} Widgets show a “Connect” message until it is.</p>}
          {kinds.length === 0 ? (
            <p className="text-sm text-text-3">No {tabLabel(tab)} metrics are available yet.</p>
          ) : (
            <>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-xs font-medium text-text-2">Widget type</legend>
                <div className="grid grid-cols-2 gap-1.5">
                  {kinds.map((k) => {
                    const Icon = KIND_ICON[k];
                    return (
                      <button key={k} type="button" aria-pressed={kind === k} onClick={() => chooseKind(k)} className={cn("flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs cursor-pointer", kind === k ? "border-brand bg-surface-2 font-medium text-text" : "border-border text-text-2 hover:text-text")}>
                        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> {KIND_LABEL[k]}
                      </button>
                    );
                  })}
                </div>
                {hint && <p className="text-xs text-text-3">{hint}</p>}
              </fieldset>
              {limits && (
                <fieldset className="flex flex-col gap-1">
                  <legend className="mb-1.5 text-xs font-medium text-text-2">Metrics {max > 1 && <span className="font-normal text-text-3">({picked.length}/{max})</span>}</legend>
                  {metrics.map((m) => (
                    <label key={m.key} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-surface-2" title={m.description}>
                      <input type={max === 1 ? "radio" : "checkbox"} name="lib-metric" className="mt-0.5" checked={picked.includes(m.key)} onChange={() => toggle(m.key)} disabled={!picked.includes(m.key) && picked.length >= max && max > 1} />
                      <span className="min-w-0">{m.label}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              {allowsDim && dims.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="lib-dim">Breakdown{!needsDim && <span className="font-normal text-text-3"> (optional)</span>}</Label>
                  <Select id="lib-dim" value={dim} onChange={(e) => setDimension(e.target.value)}>
                    {!needsDim && <option value="">By day</option>}
                    {dims.map((d) => <option key={d.dimension} value={d.dimension}>{d.label}</option>)}
                  </Select>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
        <span className="text-xs text-text-3">{full ? "This dashboard is full (40 widgets)." : ""}</span>
        <Button type="button" onClick={add} disabled={!ready}>{kind === "kpi" && picked.length > 1 ? `Add ${picked.length} KPIs` : "Add to dashboard"}</Button>
      </div>
    </aside>
  );
}
