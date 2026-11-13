"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, RotateCcw } from "lucide-react";
import type { MetricSource } from "@/lib/metrics-registry";
import type { DashboardWidget } from "@/lib/dashboards/types";
import type { DashboardData, WidgetData } from "@/lib/dashboards/widget-data";
import { MAX_WIDGETS, parseWidgets } from "@/lib/dashboards/parse";
import { newWidgetId, placeNew } from "@/lib/dashboards/layout";
import { previewWidgetAction, saveDashboardWidgetsAction, type DashboardResult } from "@/server/dashboards/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdSlots } from "./widget-view";
import { WidgetLibrary, type WidgetDraft } from "./widget-library";
import { EditableGrid } from "./editable-grid";

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

export const sameWidget = (a: DashboardWidget | undefined, b: DashboardWidget) =>
  !!a && a.kind === b.kind && (a.metrics ?? []).join() === (b.metrics ?? []).join() && (a.dimension ?? "") === (b.dimension ?? "") && (a.range ?? "") === (b.range ?? "");

export const templateData = (w: DashboardWidget): WidgetData | undefined =>
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
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [pending, start] = useTransition();
  const leaving = useRef(false);

  const dirty = useMemo(() => name.trim() !== saved.name || JSON.stringify(widgets) !== JSON.stringify(saved.widgets), [name, widgets, saved]);

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
    setError(null);
    // Widgets matching the saved ones keep their data; the rest load a preview.
    for (const w of resetWidgets) if (!sameWidget(initialWidgets.find((s) => s.id === w.id), w)) preview(w);
    setAnnounce("Layout reset to the default. Save to keep it.");
  };


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
          <Button type="button" variant="outline" onClick={() => setLibrary(true)} disabled={widgets.length >= MAX_WIDGETS}>
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

      <EditableGrid widgets={widgets} onChange={setWidgets} onWidgetChanged={preview} onAnnounce={setAnnounce} data={data} currency={currency} slots={slots} clientId={clientId} linked={linked} />
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
