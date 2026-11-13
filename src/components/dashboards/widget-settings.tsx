"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import { PRESET_LABEL, type RangePreset } from "@/lib/date-ranges";
import { dimensionsFor, metricsFor, SOURCE_LABEL, SOURCE_ORDER, sourceOf } from "@/lib/dashboards/metrics";
import type { MetricSource } from "@/lib/metrics-registry";
import { KIND_LABEL, widgetTitle } from "@/lib/dashboards/describe";
import { GRID_COLS, METRIC_LIMITS, MIN_SIZE, parseWidgets } from "@/lib/dashboards/parse";
import type { DashboardWidget, WidgetKind } from "@/lib/dashboards/types";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

const METRIC_KINDS: WidgetKind[] = ["kpi", "line", "area", "bar", "table", "pie"];
const RANGES: RangePreset[] = ["mtd", "last_month", "last_7", "last_30", "last_90"];

/**
 * Per-widget settings: title, data source, display style, metrics, breakdown,
 * date range (or text), and remove. `linked` = the client's connected sources;
 * the source list offers only those (plus the widget's current one), so a
 * widget can switch to any metric the client actually has. Undefined (agency
 * templates) offers every source.
 */
export function WidgetSettings({ widget, linked, onApply, onRemove, onClose }: { widget: DashboardWidget; linked?: MetricSource[]; onApply: (w: DashboardWidget) => void; onRemove: () => void; onClose: () => void }) {
  const [draft, setDraft] = useState<DashboardWidget>(widget);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const source = sourceOf(draft.metrics?.[0] ?? "");
  const metricWidget = METRIC_KINDS.includes(draft.kind);
  const metrics = source ? metricsFor(source) : [];
  const dims = source ? dimensionsFor(source) : [];
  const limit = METRIC_LIMITS[draft.kind];
  const needsDim = draft.kind === "table" || draft.kind === "pie";
  const allowsDim = needsDim || draft.kind === "bar";
  const sources = SOURCE_ORDER.filter((s) => s !== "rank" && metricsFor(s).length > 0 && (!linked || linked.includes(s) || s === source));
  const setSource = (s: MetricSource) => {
    const first = metricsFor(s)[0]?.key;
    if (!first) return;
    const sDims = dimensionsFor(s);
    // Keep the display style when the new source supports it; breakdown styles need a breakdown.
    const kind = (draft.kind === "table" || draft.kind === "pie") && sDims.length === 0 ? "kpi" : draft.kind;
    const min = MIN_SIZE[kind];
    set({
      kind,
      metrics: [first],
      w: Math.max(draft.w, min.w),
      h: Math.max(draft.h, min.h),
      dimension: kind === "table" || kind === "pie" ? sDims[0]?.dimension : undefined,
    });
  };

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<DashboardWidget>) => { setDraft((d) => ({ ...d, ...patch })); setError(null); };
  const setKind = (kind: WidgetKind) => {
    const min = MIN_SIZE[kind];
    const max = METRIC_LIMITS[kind]?.max ?? 0;
    const w = Math.max(draft.w, min.w);
    set({
      kind,
      w,
      h: Math.max(draft.h, min.h),
      x: Math.min(draft.x, GRID_COLS - w),
      metrics: (draft.metrics ?? []).slice(0, max),
      dimension: kind === "table" || kind === "pie" ? draft.dimension || dims[0]?.dimension : kind === "bar" ? draft.dimension : undefined,
    });
  };
  const toggleMetric = (key: string) => {
    const cur = draft.metrics ?? [];
    const max = limit?.max ?? 1;
    if (max === 1) return set({ metrics: [key] });
    set({ metrics: cur.includes(key) ? cur.filter((k) => k !== key) : cur.length >= max ? cur : [...cur, key] });
  };
  const apply = () => {
    const candidate: DashboardWidget = { ...draft, title: draft.title?.trim() || undefined };
    if (!candidate.dimension) delete candidate.dimension;
    if (!candidate.range) delete candidate.range;
    if (!candidate.title) delete candidate.title;
    if (!candidate.hideChange || candidate.kind !== "kpi") delete candidate.hideChange;
    const r = parseWidgets([candidate]);
    if (!r.ok) return setError(r.error);
    onApply(r.widgets[0]);
  };

  return (
    <div ref={ref} role="dialog" aria-label={`Settings for ${widgetTitle(widget) || KIND_LABEL[widget.kind]}`} className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg border border-border bg-surface p-3 shadow-lg">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{KIND_LABEL[draft.kind]}{source && <span className="font-normal text-text-3"> · {SOURCE_LABEL[source]}</span>}</p>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close settings"><X className="h-4 w-4" aria-hidden /></Button>
      </div>
      {draft.kind !== "text" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`t-${widget.id}`}>Title</Label>
          <Input id={`t-${widget.id}`} value={draft.title ?? ""} maxLength={120} placeholder={widgetTitle({ ...draft, title: undefined })} onChange={(e) => set({ title: e.target.value })} />
        </div>
      )}
      {draft.kind === "text" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`x-${widget.id}`}>Text</Label>
          <textarea id={`x-${widget.id}`} value={draft.text ?? ""} maxLength={5000} rows={7} onChange={(e) => set({ text: e.target.value })} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" />
          <p className="text-xs text-text-3"># heading · - bullet · **bold**</p>
        </div>
      )}
      {metricWidget && sources.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`s-${widget.id}`}>Data source</Label>
          <Select id={`s-${widget.id}`} value={source ?? ""} onChange={(e) => setSource(e.target.value as MetricSource)}>
            {sources.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </Select>
        </div>
      )}
      {metricWidget && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`k-${widget.id}`}>Display as</Label>
          <Select id={`k-${widget.id}`} value={draft.kind} onChange={(e) => setKind(e.target.value as WidgetKind)}>
            {METRIC_KINDS.filter((k) => dims.length > 0 || (k !== "table" && k !== "pie")).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </Select>
        </div>
      )}
      {metricWidget && metrics.length > 0 && (
        <fieldset className="flex flex-col gap-0.5">
          <legend className="mb-1 text-xs font-medium text-text-2">Metric{(limit?.max ?? 1) > 1 && "s"} {(limit?.max ?? 1) > 1 && <span className="font-normal text-text-3">({draft.metrics?.length ?? 0}/{limit?.max})</span>}</legend>
          <div className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
            {metrics.map((m) => (
              <label key={m.key} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-surface-2">
                <input type={(limit?.max ?? 1) === 1 ? "radio" : "checkbox"} name={`m-${widget.id}`} checked={draft.metrics?.includes(m.key) ?? false} onChange={() => toggleMetric(m.key)} />
                {m.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {draft.kind === "kpi" && (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={!draft.hideChange} onChange={(e) => set({ hideChange: e.target.checked ? undefined : true })} />
          Show change vs the comparison period
        </label>
      )}
      {allowsDim && dims.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`d-${widget.id}`}>Breakdown</Label>
          <Select id={`d-${widget.id}`} value={draft.dimension ?? ""} onChange={(e) => set({ dimension: e.target.value || undefined })}>
            {!needsDim && <option value="">By day</option>}
            {dims.map((d) => <option key={d.dimension} value={d.dimension}>{d.label}</option>)}
          </Select>
        </div>
      )}
      {draft.kind !== "text" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`r-${widget.id}`}>Date range</Label>
          <Select id={`r-${widget.id}`} value={draft.range ?? ""} onChange={(e) => set({ range: e.target.value || undefined })}>
            <option value="">Same as the page</option>
            {RANGES.map((r) => <option key={r} value={r}>{PRESET_LABEL[r]}</option>)}
          </Select>
        </div>
      )}
      {error && <p className="text-xs text-critical-ink" role="alert">{error}</p>}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        {confirmRemove ? (
          <span className="flex items-center gap-1">
            <Button type="button" variant="destructive" size="sm" onClick={onRemove}>Remove</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>Keep</Button>
          </span>
        ) : (
          <Button type="button" variant="ghost" size="sm" className="text-critical-ink" onClick={() => setConfirmRemove(true)}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove</Button>
        )}
        <span className="flex gap-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" onClick={apply}>Apply</Button>
        </span>
      </div>
    </div>
  );
}
