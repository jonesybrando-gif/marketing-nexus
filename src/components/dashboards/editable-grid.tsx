"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { GripVertical, Settings2, X } from "lucide-react";
import type { MetricSource } from "@/lib/metrics-registry";
import type { DashboardWidget } from "@/lib/dashboards/types";
import type { DashboardData } from "@/lib/dashboards/widget-data";
import { GRID_COLS } from "@/lib/dashboards/parse";
import { moveWidget, resizeWidget, sortByPosition } from "@/lib/dashboards/layout";
import { KIND_LABEL, widgetTitle } from "@/lib/dashboards/describe";
import { cn } from "@/components/ui/cn";
import { WidgetView, type AdSlots } from "./widget-view";
import { WidgetSettings } from "./widget-settings";

export const ROW = 64;
export const GAP = 12;

type Drag = { id: string; mode: "move" | "resize"; px: number; py: number; base: DashboardWidget[]; orig: DashboardWidget };

/**
 * One editable widget grid: drag the handle to move a widget, drag the corner
 * to resize, change it in the settings popover or remove it. Keyboard: arrows
 * move the focused handle, Shift+arrows resize. Controlled: the parent owns
 * the widgets (a dashboard, or one section of a client's Report).
 */
export function EditableGrid({
  widgets,
  onChange,
  onWidgetChanged,
  onAnnounce,
  data,
  currency,
  slots,
  clientId,
  linked,
  minRows = 3,
}: {
  widgets: DashboardWidget[];
  onChange: (next: DashboardWidget[]) => void;
  /** A widget's data source or metrics changed (load a fresh preview). */
  onWidgetChanged: (w: DashboardWidget) => void;
  onAnnounce: (text: string) => void;
  data: DashboardData;
  currency: string;
  slots?: AdSlots;
  clientId: string | null;
  linked: MetricSource[];
  /** Empty rows kept below the last widget, room to drag into. */
  minRows?: number;
}) {
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const col = width > 0 ? (width - GAP * (GRID_COLS - 1)) / GRID_COLS : 0;
  const rect = (w: Pick<DashboardWidget, "x" | "y" | "w" | "h">) => ({ left: w.x * (col + GAP), top: w.y * (ROW + GAP), width: w.w * col + (w.w - 1) * GAP, height: w.h * ROW + (w.h - 1) * GAP });

  const onPointerDown = (e: ReactPointerEvent, id: string, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    const orig = widgets.find((w) => w.id === id);
    if (!orig) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSettingsFor(null);
    setDrag({ id, mode, px: e.clientX, py: e.clientY, base: widgets, orig });
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag || !col) return;
    const dc = Math.round((e.clientX - drag.px) / (col + GAP));
    const dr = Math.round((e.clientY - drag.py) / (ROW + GAP));
    const o = drag.orig;
    onChange(drag.mode === "move" ? moveWidget(drag.base, drag.id, o.x + dc, o.y + dr) : resizeWidget(drag.base, drag.id, o.w + dc, o.h + dr));
  };
  const onPointerUp = () => {
    if (!drag) return;
    const w = widgets.find((x) => x.id === drag.id);
    if (w) onAnnounce(drag.mode === "move" ? `Moved to column ${w.x + 1}, row ${w.y + 1}.` : `Resized to ${w.w} columns by ${w.h} rows.`);
    setDrag(null);
  };
  const onHandleKey = (e: ReactKeyboardEvent, id: string) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const w = widgets.find((x) => x.id === id)!;
    const next = e.shiftKey ? resizeWidget(widgets, id, w.w + d[0], w.h + d[1]) : moveWidget(widgets, id, w.x + d[0], w.y + d[1]);
    onChange(next);
    const n = next.find((x) => x.id === id)!;
    onAnnounce(e.shiftKey ? `${n.w} columns by ${n.h} rows.` : `Column ${n.x + 1}, row ${n.y + 1}.`);
  };

  const applySettings = (w: DashboardWidget) => {
    const before = widgets.find((x) => x.id === w.id);
    let next = widgets.map((x) => (x.id === w.id ? w : x));
    if (before && (before.w !== w.w || before.h !== w.h || before.x !== w.x)) next = resizeWidget(moveWidget(next, w.id, w.x, w.y), w.id, w.w, w.h);
    onChange(next);
    setSettingsFor(null);
    const same = before && before.kind === w.kind && (before.metrics ?? []).join() === (w.metrics ?? []).join() && (before.dimension ?? "") === (w.dimension ?? "") && (before.range ?? "") === (w.range ?? "");
    if (!same) onWidgetChanged(w);
  };
  const remove = (id: string) => {
    onChange(widgets.filter((w) => w.id !== id));
    setSettingsFor(null);
    onAnnounce("Widget removed.");
  };

  const bottom = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  const height = (bottom + minRows) * (ROW + GAP);
  const ordered = sortByPosition(widgets);
  const active = drag?.id;

  return (
    <div
      ref={gridRef}
      className={cn("relative", drag && "select-none")}
      style={{ height: widgets.length ? height : 0, backgroundImage: drag && col ? `repeating-linear-gradient(to right, var(--grid) 0 ${col}px, transparent ${col}px ${col + GAP}px)` : undefined, backgroundSize: drag ? `100% ${ROW + GAP}px` : undefined }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {col > 0 &&
        ordered.map((w) => {
          const r = rect(w);
          const title = widgetTitle(w) || KIND_LABEL[w.kind];
          return (
            <div
              key={w.id}
              id={`widget-${w.id}`}
              className={cn("group absolute", active === w.id ? "z-20" : "z-0 transition-[left,top,width,height] duration-150", settingsFor === w.id && "z-30")}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height } as CSSProperties}
            >
              <div className={cn("relative h-full overflow-hidden rounded-xl ring-brand/50", w.kind === "text" && "border border-dashed border-border", active === w.id ? "opacity-90 ring-2 shadow-lg" : "group-hover:ring-1 group-focus-within:ring-1")}>
                <div className="pointer-events-none h-full overflow-hidden">
                  <WidgetView widget={w} data={data[w.id]} currency={currency} slots={slots} staff fill="always" />
                </div>
                <div className="absolute inset-x-0 top-0 flex items-center gap-1 bg-gradient-to-b from-surface via-surface/95 to-transparent px-1.5 pt-1 pb-3 opacity-90 group-hover:opacity-100">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-move touch-none items-center gap-1 rounded px-1 py-0.5 text-left text-xs text-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    aria-label={`Move ${title}. Arrow keys move, Shift+arrow keys resize.`}
                    onPointerDown={(e) => onPointerDown(e, w.id, "move")}
                    onKeyDown={(e) => onHandleKey(e, w.id)}
                  >
                    <GripVertical className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate font-medium">{title}</span>
                  </button>
                  <button type="button" className="cursor-pointer rounded p-1 text-text-2 hover:bg-surface-2 hover:text-text" aria-label={`Settings for ${title}`} aria-expanded={settingsFor === w.id} onClick={() => setSettingsFor(settingsFor === w.id ? null : w.id)}>
                    <Settings2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button type="button" className="cursor-pointer rounded p-1 text-text-2 hover:bg-critical-bg hover:text-critical-ink" aria-label={`Remove ${title}`} onClick={() => remove(w.id)}>
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                <span role="presentation" className="absolute right-0 bottom-0 h-5 w-5 cursor-se-resize touch-none" onPointerDown={(e) => onPointerDown(e, w.id, "resize")}>
                  <span className="absolute right-1.5 bottom-1.5 h-2.5 w-2.5 border-r-2 border-b-2 border-text-3 group-hover:border-brand" />
                </span>
              </div>
              {settingsFor === w.id && (
                <div className={cn("absolute top-9 z-30", r.left + 320 > width ? "right-0" : "left-0")}>
                  <WidgetSettings widget={w} linked={clientId ? linked : undefined} onApply={applySettings} onRemove={() => remove(w.id)} onClose={() => setSettingsFor(null)} />
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
