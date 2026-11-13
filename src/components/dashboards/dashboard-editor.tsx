"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { GripVertical, Plus, RotateCcw, Settings2, X } from "lucide-react";
import type { MetricSource } from "@/lib/metrics-registry";
import type { DashboardWidget } from "@/lib/dashboards/types";
import type { DashboardData, WidgetData } from "@/lib/dashboards/widget-data";
import { GRID_COLS, MAX_WIDGETS, parseWidgets } from "@/lib/dashboards/parse";
import { moveWidget, newWidgetId, placeNew, resizeWidget, sortByPosition } from "@/lib/dashboards/layout";
import { KIND_LABEL, widgetTitle } from "@/lib/dashboards/describe";
import { previewWidgetAction, saveDashboardWidgetsAction, type DashboardResult } from "@/server/dashboards/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { WidgetView, type AdSlots } from "./widget-view";
import { WidgetLibrary, type WidgetDraft } from "./widget-library";
import { WidgetSettings } from "./widget-settings";

const ROW = 64;
const GAP = 12;

export interface DashboardEditorProps {
  /** The saved dashboard; may be null when `saveAction` saves elsewhere (e.g. a client's Report). */
  dashboardId: string | null;
  name: string;
  widgets: DashboardWidget[];
  data: DashboardData;
  currency: string;
  slots?: AdSlots;
  /** null for agency templates: no client data, widgets show placeholders. */
  clientId: string | null;
  linked: MetricSource[];
  /** The page's range and comparison, for previews of new or changed widgets. */
  rangeParams: { range?: string; compare?: string; from?: string; to?: string };
  /** Where Save and Cancel go. */
  doneHref: string;
  /** Saves the widgets instead of the dashboard row (a bound server action). */
  saveAction?: (widgets: DashboardWidget[]) => Promise<DashboardResult>;
  /** Fixed heading in place of the name field (the name then isn't editable). */
  heading?: string;
  /** Default layout offered by "Reset to default" (applied to the draft; saved with Save). */
  resetWidgets?: DashboardWidget[];
}

type Drag = { id: string; mode: "move" | "resize"; px: number; py: number; base: DashboardWidget[]; orig: DashboardWidget };

const sameWidget = (a: DashboardWidget | undefined, b: DashboardWidget) =>
  !!a && a.kind === b.kind && (a.metrics ?? []).join() === (b.metrics ?? []).join() && (a.dimension ?? "") === (b.dimension ?? "") && (a.range ?? "") === (b.range ?? "");

const templateData = (w: DashboardWidget): WidgetData | undefined =>
  w.kind === "text" ? { kind: "text" } : w.kind === "pacing" || w.kind === "campaigns" ? { kind: w.kind } : { kind: "empty", reason: "no_data", source: null, message: "Shows each client's data once applied." };

/**
 * Edit mode for a dashboard: drag the handle to move a widget, drag the
 * corner to resize, add widgets from the library, change them in the settings
 * popover, then Save or Cancel. Keyboard: arrows move the focused handle,
 * Shift+arrows resize. Unsaved changes are protected on leaving.
 */
export function DashboardEditor({ dashboardId, name: initialName, widgets: initialWidgets, data: initialData, currency, slots, clientId, linked, rangeParams, doneHref, saveAction, heading, resetWidgets }: DashboardEditorProps) {
  const router = useRouter();
  const [saved, setSaved] = useState({ widgets: initialWidgets, name: initialName });
  const [widgets, setWidgets] = useState(initialWidgets);
  const [name, setName] = useState(initialName);
  const [data, setData] = useState<DashboardData>(() => (clientId ? initialData : Object.fromEntries(initialWidgets.map((w) => [w.id, templateData(w)!]))));
  const [library, setLibrary] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [pending, start] = useTransition();
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const leaving = useRef(false);

  const dirty = useMemo(() => name.trim() !== saved.name || JSON.stringify(widgets) !== JSON.stringify(saved.widgets), [name, widgets, saved]);

  // Grid width → column width.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const col = width > 0 ? (width - GAP * (GRID_COLS - 1)) / GRID_COLS : 0;
  const rect = (w: Pick<DashboardWidget, "x" | "y" | "w" | "h">) => ({ left: w.x * (col + GAP), top: w.y * (ROW + GAP), width: w.w * col + (w.w - 1) * GAP, height: w.h * ROW + (w.h - 1) * GAP });

  // Previews for added or changed widgets (saved ones come with the page).
  const preview = useCallback(
    (w: DashboardWidget) => {
      if (!clientId) return setData((d) => ({ ...d, [w.id]: templateData(w)! }));
      if (w.kind === "text") return setData((d) => ({ ...d, [w.id]: { kind: "text" } }));
      setData((d) => {
        const n = { ...d };
        delete n[w.id];
        return n;
      });
      previewWidgetAction(clientId, w, rangeParams)
        .then((res) => setData((d) => ({ ...d, [w.id]: res })))
        .catch(() => setData((d) => ({ ...d, [w.id]: { kind: "empty", reason: "no_data", source: null, message: "Preview unavailable. It will load after saving." } })));
    },
    [clientId, rangeParams],
  );

  // A new range from the date picker: saved widgets get fresh server data; refresh the rest.
  const rangeKey = JSON.stringify(rangeParams);
  const firstRange = useRef(rangeKey);
  useEffect(() => {
    if (firstRange.current === rangeKey || !clientId) return;
    firstRange.current = rangeKey;
    setData(initialData);
    for (const w of widgets) if (!sameWidget(initialWidgets.find((s) => s.id === w.id), w)) preview(w);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  // Unsaved-changes protection: browser close/reload, and in-app links.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download") || a.closest("[data-editor-allow-nav]")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      // Range changes stay on this page and keep the draft.
      if (url.pathname === location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(url.pathname + url.search + url.hash);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  const go = (href: string) => {
    leaving.current = true;
    router.push(href);
    router.refresh();
  };

  // --- Drag to move / resize (pointer events: mouse, pen and touch) ---
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
    setWidgets(drag.mode === "move" ? moveWidget(drag.base, drag.id, o.x + dc, o.y + dr) : resizeWidget(drag.base, drag.id, o.w + dc, o.h + dr));
  };
  const onPointerUp = () => {
    if (!drag) return;
    const w = widgets.find((x) => x.id === drag.id);
    if (w) setAnnounce(drag.mode === "move" ? `Moved to column ${w.x + 1}, row ${w.y + 1}.` : `Resized to ${w.w} columns by ${w.h} rows.`);
    setDrag(null);
  };
  const onHandleKey = (e: ReactKeyboardEvent, id: string) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const w = widgets.find((x) => x.id === id)!;
    const next = e.shiftKey ? resizeWidget(widgets, id, w.w + d[0], w.h + d[1]) : moveWidget(widgets, id, w.x + d[0], w.y + d[1]);
    setWidgets(next);
    const n = next.find((x) => x.id === id)!;
    setAnnounce(e.shiftKey ? `${n.w} columns by ${n.h} rows.` : `Column ${n.x + 1}, row ${n.y + 1}.`);
  };

  // --- Add, change, remove ---
  const add = (drafts: WidgetDraft[]) => {
    let next = widgets;
    const added: DashboardWidget[] = [];
    for (const dft of drafts) {
      if (next.length >= MAX_WIDGETS) break;
      const box = placeNew(next, dft.kind, newWidgetId());
      const w = { ...dft, ...box } as DashboardWidget;
      const ok = parseWidgets([w]);
      if (!ok.ok) {
        setError(ok.error);
        continue;
      }
      next = [...next, ok.widgets[0]];
      added.push(ok.widgets[0]);
    }
    if (!added.length) return;
    setWidgets(next);
    setError(null);
    added.forEach(preview);
    setAnnounce(`${added.length} widget${added.length === 1 ? "" : "s"} added.`);
    // Show the first new widget.
    requestAnimationFrame(() => document.getElementById(`widget-${added[0].id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  const applySettings = (w: DashboardWidget) => {
    const before = widgets.find((x) => x.id === w.id);
    let next = widgets.map((x) => (x.id === w.id ? w : x));
    if (before && (before.w !== w.w || before.h !== w.h || before.x !== w.x)) next = resizeWidget(moveWidget(next, w.id, w.x, w.y), w.id, w.w, w.h);
    setWidgets(next);
    setSettingsFor(null);
    if (!sameWidget(before, w)) preview(w);
  };
  const remove = (id: string) => {
    setWidgets((ws) => ws.filter((w) => w.id !== id));
    setSettingsFor(null);
    setAnnounce("Widget removed.");
  };

  const save = () =>
    start(async () => {
      setError(null);
      try {
        const res = saveAction ? await saveAction(widgets) : dashboardId ? await saveDashboardWidgetsAction(dashboardId, widgets, name) : { ok: false as const, error: "Nothing to save to." };
        if (!res.ok) return setError(res.error);
        setSaved({ widgets, name: name.trim() });
        go(doneHref);
      } catch {
        setError("The dashboard couldn't be saved. Check your connection and try again.");
      }
    });
  const cancel = () => (dirty ? setLeaveTo(doneHref) : go(doneHref));
  const reset = () => {
    if (!resetWidgets) return;
    setWidgets(resetWidgets);
    setSettingsFor(null);
    setError(null);
    // Widgets matching the saved ones keep their data; the rest load a preview.
    for (const w of resetWidgets) if (!sameWidget(initialWidgets.find((s) => s.id === w.id), w)) preview(w);
    setAnnounce("Layout reset to the default. Save to keep it.");
  };

  const bottom = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  const height = (bottom + 3) * (ROW + GAP);
  const ordered = sortByPosition(widgets);
  const active = drag?.id;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {heading ? (
            <p className="text-sm font-semibold">{heading}</p>
          ) : (
            <>
              <label htmlFor="dash-name" className="sr-only">Dashboard name</label>
              <Input id="dash-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="max-w-sm font-medium" />
            </>
          )}
          <span className="hidden text-xs text-text-3 sm:inline">{widgets.length}/{MAX_WIDGETS} widgets{dirty && " · unsaved changes"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => { setLibrary(true); setSettingsFor(null); }} disabled={widgets.length >= MAX_WIDGETS}>
            <Plus className="h-4 w-4" aria-hidden /> Add widget
          </Button>
          {resetWidgets && (
            <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Reset to default
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={cancel} disabled={pending}>Cancel</Button>
          <Button type="button" onClick={save} disabled={pending || !dirty || !name.trim()}>{pending ? "Saving…" : "Save"}</Button>
        </div>
        {error && <p className="w-full text-sm text-critical-ink" role="alert">{error}</p>}
      </div>
      <p className="text-xs text-text-3 md:hidden">Editing works best on a larger screen. On phones, widgets stack in order from top-left.</p>

      {widgets.length === 0 && (
        <button type="button" onClick={() => setLibrary(true)} className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-border px-6 py-12 text-center hover:bg-surface cursor-pointer">
          <Plus className="h-5 w-5 text-text-3" aria-hidden />
          <span className="text-sm font-medium">Add your first widget</span>
          <span className="text-xs text-text-3">KPIs, charts and tables from ads, GA4, Search Console, Business Profile, CallRail, social and rankings.</span>
        </button>
      )}

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
                  {/* Edit chrome: drag handle, settings and remove. */}
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
                    <button type="button" className="rounded p-1 text-text-2 hover:bg-surface-2 hover:text-text cursor-pointer" aria-label={`Settings for ${title}`} aria-expanded={settingsFor === w.id} onClick={() => { setSettingsFor(settingsFor === w.id ? null : w.id); setLibrary(false); }}>
                      <Settings2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button type="button" className="rounded p-1 text-text-2 hover:bg-critical-bg hover:text-critical-ink cursor-pointer" aria-label={`Remove ${title}`} onClick={() => remove(w.id)}>
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                  <span
                    role="presentation"
                    className="absolute right-0 bottom-0 h-5 w-5 cursor-se-resize touch-none"
                    onPointerDown={(e) => onPointerDown(e, w.id, "resize")}
                  >
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
      <p className="sr-only" aria-live="polite">{announce}</p>

      {library && <WidgetLibrary linked={linked} templateMode={!clientId} onAdd={add} onClose={() => setLibrary(false)} full={widgets.length >= MAX_WIDGETS} />}

      {leaveTo && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center" role="presentation" onClick={() => setLeaveTo(null)}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="leave-title" className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <p id="leave-title" className="font-semibold">Discard unsaved changes?</p>
            <p className="text-sm text-text-2">Your changes to this dashboard haven&apos;t been saved.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" autoFocus onClick={() => setLeaveTo(null)}>Keep editing</Button>
              <Button type="button" variant="destructive" onClick={() => go(leaveTo)}>Discard changes</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
