"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, BarChart3, ChevronDown, Hash, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { MetricSource } from "@/lib/metrics-registry";
import type { PlatformKey } from "@/lib/platforms";
import type { DashboardWidget } from "@/lib/dashboards/types";
import type { DashboardData } from "@/lib/dashboards/widget-data";
import { MAX_WIDGETS, parseWidgets } from "@/lib/dashboards/parse";
import { newWidgetId, placeNew } from "@/lib/dashboards/layout";
import { allWidgets, availableSectionTypes, MAX_SECTIONS, newSection, SECTION_TYPE, SECTION_TYPES, type ReportLayout, type ReportSection, type SectionType } from "@/lib/dashboards/report-sections";
import { previewWidgetAction, type DashboardResult } from "@/server/dashboards/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import type { AdSlots } from "./widget-view";
import { WidgetLibrary, type LibraryTab, type WidgetDraft } from "./widget-library";
import { EditableGrid } from "./editable-grid";
import { sameWidget } from "./dashboard-editor";

/** The library tab that matches a section (its main data source). */
const TAB_OF: Record<SectionType, LibraryTab> = { google_ads: "ads", meta_ads: "ads", microsoft_ads: "ads", lsa: "ads", ads: "ads", callrail: "callrail", seo: "gsc", ga4: "ga4", pacing: "ads" };

type Target = { sectionId: string; kind: "kpi" | "line" } | null;

/**
 * Edit Report: the report's sections in order, each with its own widget grid
 * and an options menu (Add Metric, Add Chart, Move Up/Down, Remove Section).
 * Add Section, Save Changes, Cancel and Reset to Default sit at the top.
 * Nothing is saved until Save Changes; leaving with changes asks first.
 */
export function ReportEditor({
  layout: initial,
  defaults,
  data: initialData,
  currency,
  slots,
  clientId,
  linked,
  rangeParams,
  doneHref,
  saveAction,
  slotsByPlatform = {},
}: {
  layout: ReportLayout;
  defaults: ReportLayout;
  data: DashboardData;
  currency: string;
  slots?: AdSlots;
  clientId: string;
  linked: MetricSource[];
  rangeParams: { range?: string; compare?: string; from?: string; to?: string };
  doneHref: string;
  saveAction: (layout: ReportLayout) => Promise<DashboardResult>;
  /** Campaign tables limited to one platform, for Google Ads / Meta Ads… sections. */
  slotsByPlatform?: Partial<Record<PlatformKey, AdSlots>>;
}) {
  const router = useRouter();
  const [layout, setLayout] = useState(initial);
  const [data, setData] = useState<DashboardData>(initialData);
  const [target, setTarget] = useState<Target>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  /** A type already in the report that was clicked once: a second click adds another instance. */
  const [confirmDup, setConfirmDup] = useState<SectionType | null>(null);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [pending, start] = useTransition();
  const leaving = useRef(false);
  const dirty = useMemo(() => JSON.stringify(layout) !== JSON.stringify(initial), [layout, initial]);
  const total = allWidgets(layout).length;
  const available = availableSectionTypes(linked);
  const initialWidgets = useMemo(() => allWidgets(initial), [initial]);

  const preview = useCallback(
    (w: DashboardWidget, platform?: PlatformKey) => {
      if (w.kind === "text") return setData((d) => ({ ...d, [w.id]: { kind: "text" } }));
      if (w.kind === "pacing" || w.kind === "campaigns") {
        const kind = w.kind;
        return setData((d) => ({ ...d, [w.id]: { kind } }));
      }
      setData((d) => {
        const n = { ...d };
        delete n[w.id];
        return n;
      });
      previewWidgetAction(clientId, w, rangeParams, platform)
        .then((res) => setData((d) => ({ ...d, [w.id]: res })))
        .catch(() => setData((d) => ({ ...d, [w.id]: { kind: "empty", reason: "no_data", source: null, message: "Preview unavailable. It will load after saving." } })));
    },
    [clientId, rangeParams],
  );

  // A new date range: saved widgets get fresh data from the page; refresh the others.
  const rangeKey = JSON.stringify(rangeParams);
  const firstRange = useRef(rangeKey);
  useEffect(() => {
    if (firstRange.current === rangeKey) return;
    firstRange.current = rangeKey;
    setData(initialData);
    for (const s of layout.sections) for (const w of s.widgets) if (!sameWidget(initialWidgets.find((x) => x.id === w.id), w)) preview(w, SECTION_TYPE[s.type].platform);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  // Unsaved-changes protection: closing the tab, and links to other pages.
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
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
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

  // Close the open menus on Escape or a click elsewhere.
  useEffect(() => {
    if (!menu && !addOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as HTMLElement).closest("[data-report-menu]")) {
        setMenu(null);
        setAddOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu, addOpen]);

  const go = (href: string) => {
    leaving.current = true;
    router.push(href);
    router.refresh();
  };

  const setSection = (id: string, patch: (s: ReportSection) => ReportSection) => setLayout((l) => ({ ...l, sections: l.sections.map((s) => (s.id === id ? patch(s) : s)) }));

  const move = (id: string, dir: -1 | 1) => {
    setLayout((l) => {
      const i = l.sections.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= l.sections.length) return l;
      const sections = [...l.sections];
      [sections[i], sections[j]] = [sections[j], sections[i]];
      return { ...l, sections };
    });
    setMenu(null);
    setAnnounce(dir < 0 ? "Section moved up." : "Section moved down.");
    requestAnimationFrame(() => document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  const removeSection = (id: string) => {
    setLayout((l) => {
      const gone = l.sections.find((s) => s.id === id);
      const sections = l.sections.filter((s) => s.id !== id);
      // The last section of a type removed on purpose: never add it back automatically.
      const removed = gone && !sections.some((s) => s.type === gone.type) ? [...new Set([...l.removed, gone.type])] : l.removed;
      return { ...l, sections, removed };
    });
    setMenu(null);
    setAnnounce("Section removed. The integration stays connected; add the section back any time with Add Section.");
  };

  const addSection = (type: SectionType) => {
    if (layout.sections.some((s) => s.type === type) && confirmDup !== type) return setConfirmDup(type);
    setConfirmDup(null);
    if (layout.sections.length >= MAX_SECTIONS) return setError(`A report can have up to ${MAX_SECTIONS} sections.`);
    const s = newSection(type, layout.sections, linked);
    if (total + s.widgets.length > MAX_WIDGETS) return setError(`A report can have up to ${MAX_WIDGETS} widgets. Remove some first.`);
    setLayout((l) => ({ ...l, sections: [...l.sections, s], removed: l.removed.filter((t) => t !== type) }));
    s.widgets.forEach((w) => preview(w, SECTION_TYPE[type].platform));
    setAddOpen(false);
    setError(null);
    setAnnounce(`${s.title} section added at the end.`);
    requestAnimationFrame(() => document.getElementById(`section-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const addWidgets = (drafts: WidgetDraft[]) => {
    if (!target) return;
    const section = layout.sections.find((s) => s.id === target.sectionId);
    if (!section) return;
    let next = section.widgets;
    const added: DashboardWidget[] = [];
    for (const dft of drafts) {
      if (total + added.length >= MAX_WIDGETS) break;
      const w = { ...dft, ...placeNew(next, dft.kind, newWidgetId()) } as DashboardWidget;
      const ok = parseWidgets([w]);
      if (!ok.ok) {
        setError(ok.error);
        continue;
      }
      next = [...next, ok.widgets[0]];
      added.push(ok.widgets[0]);
    }
    if (!added.length) return;
    setSection(section.id, (s) => ({ ...s, widgets: next }));
    added.forEach((w) => preview(w, SECTION_TYPE[section.type].platform));
    setError(null);
    setAnnounce(`${added.length} widget${added.length === 1 ? "" : "s"} added to ${section.title}.`);
    requestAnimationFrame(() => document.getElementById(`widget-${added[0].id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  const reset = () => {
    setLayout(defaults);
    setError(null);
    for (const s of defaults.sections) for (const w of s.widgets) if (!sameWidget(initialWidgets.find((x) => x.id === w.id), w)) preview(w, SECTION_TYPE[s.type].platform);
    setAnnounce("Report reset to the default sections. Save Changes to keep it.");
  };

  const save = () =>
    start(async () => {
      setError(null);
      try {
        const res = await saveAction(layout);
        if (!res.ok) return setError(res.error);
        go(doneHref);
      } catch {
        setError("The report couldn't be saved. Check your connection and try again.");
      }
    });
  const cancel = () => (dirty ? setLeaveTo(doneHref) : go(doneHref));

  const targetSection = target ? layout.sections.find((s) => s.id === target.sectionId) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <p className="text-sm font-semibold">Editing the Report</p>
          <span className="hidden text-xs text-text-3 sm:inline">
            {layout.sections.length} section{layout.sections.length === 1 ? "" : "s"} · {total}/{MAX_WIDGETS} widgets{dirty && " · unsaved changes"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative" data-report-menu>
            <Button type="button" variant="outline" onClick={() => { setAddOpen((o) => !o); setConfirmDup(null); }} aria-expanded={addOpen} aria-haspopup="menu">
              <Plus className="h-4 w-4" aria-hidden /> Add Section
            </Button>
            {addOpen && (
              <div role="menu" className="absolute right-0 z-40 mt-1 flex w-80 flex-col gap-0.5 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
                {SECTION_TYPES.map((d) => {
                  const inReport = layout.sections.some((s) => s.type === d.type);
                  const connected = available.includes(d.type);
                  return (
                    <button key={d.type} type="button" role="menuitem" onClick={() => addSection(d.type)} className="flex cursor-pointer flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-surface-2">
                      <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                        {d.title}
                        <span className={cn("text-xs font-normal", confirmDup === d.type ? "text-brand-text" : "text-text-3")}>{confirmDup === d.type ? "Click again to add a second one" : inReport ? "Already in the report" : !connected ? "Not connected" : layout.removed.includes(d.type) ? "Removed · restore" : ""}</span>
                      </span>
                      <span className="text-xs text-text-3">{d.description}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
            <RotateCcw className="h-4 w-4" aria-hidden /> Reset to Default
          </Button>
          <Button type="button" variant="ghost" onClick={cancel} disabled={pending}>Cancel</Button>
          <Button type="button" onClick={save} disabled={pending || !dirty}>{pending ? "Saving…" : "Save Changes"}</Button>
        </div>
        {error && <p className="w-full text-sm text-critical-ink" role="alert">{error}</p>}
      </div>
      <p className="text-xs text-text-3 md:hidden">Editing works best on a larger screen. On phones, widgets stack in order from top-left.</p>

      {layout.sections.length === 0 && (
        <button type="button" onClick={() => setAddOpen(true)} data-report-menu className="flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-border px-6 py-12 text-center hover:bg-surface">
          <Plus className="h-5 w-5 text-text-3" aria-hidden />
          <span className="text-sm font-medium">Add a section</span>
          <span className="text-xs text-text-3">Paid Media, CallRail, SEO, Google Analytics or Budget Pacing.</span>
        </button>
      )}

      {layout.sections.map((s, i) => (
        <section key={s.id} id={`section-${s.id}`} aria-label={s.title} className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`title-${s.id}`} className="sr-only">Section title</label>
            <Input id={`title-${s.id}`} value={s.title} maxLength={80} onChange={(e) => setSection(s.id, (x) => ({ ...x, title: e.target.value }))} className="h-8 max-w-xs font-semibold" />
            <span className="text-xs text-text-3">{SECTION_TYPE[s.type].title !== s.title ? SECTION_TYPE[s.type].title : ""}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => removeSection(s.id)} className="ml-auto text-text-2 hover:text-critical-ink" aria-label={`Remove section: ${s.title}`}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove Section
            </Button>
            <label className="flex items-center gap-1.5 text-xs text-text-2">
              <input type="checkbox" checked={!!s.collapsed} onChange={(e) => setSection(s.id, (x) => ({ ...x, collapsed: e.target.checked || undefined }))} />
              Start collapsed
            </label>
            <div className="relative" data-report-menu>
              <Button type="button" variant="outline" size="sm" onClick={() => setMenu(menu === s.id ? null : s.id)} aria-expanded={menu === s.id} aria-haspopup="menu" aria-label={`Options for ${s.title}`}>
                <MoreHorizontal className="h-4 w-4" aria-hidden /> Options <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
              {menu === s.id && (
                <div role="menu" className="absolute right-0 z-40 mt-1 flex w-48 flex-col gap-0.5 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
                  <MenuItem icon={<Hash className="h-4 w-4" />} label="Add Metric" onClick={() => { setTarget({ sectionId: s.id, kind: "kpi" }); setMenu(null); }} />
                  <MenuItem icon={<BarChart3 className="h-4 w-4" />} label="Add Chart" onClick={() => { setTarget({ sectionId: s.id, kind: "line" }); setMenu(null); }} />
                  <MenuItem icon={<ArrowUp className="h-4 w-4" />} label="Move Section Up" disabled={i === 0} onClick={() => move(s.id, -1)} />
                  <MenuItem icon={<ArrowDown className="h-4 w-4" />} label="Move Section Down" disabled={i === layout.sections.length - 1} onClick={() => move(s.id, 1)} />
                  <MenuItem icon={<Trash2 className="h-4 w-4" />} label="Remove Section" danger onClick={() => removeSection(s.id)} />
                </div>
              )}
            </div>
          </div>
          {s.widgets.length === 0 ? (
            <button type="button" onClick={() => setTarget({ sectionId: s.id, kind: "kpi" })} className="cursor-pointer rounded-lg border border-dashed border-border px-4 py-6 text-sm text-text-2 hover:bg-surface">
              This section is empty. Add a metric or chart.
            </button>
          ) : (
            <EditableGrid
              widgets={s.widgets}
              onChange={(ws) => setSection(s.id, (x) => ({ ...x, widgets: ws }))}
              onWidgetChanged={(w) => preview(w, SECTION_TYPE[s.type].platform)}
              onAnnounce={setAnnounce}
              data={data}
              currency={currency}
              slots={(SECTION_TYPE[s.type].platform && slotsByPlatform[SECTION_TYPE[s.type].platform!]) || slots}
              clientId={clientId}
              linked={linked}
              minRows={1}
            />
          )}
        </section>
      ))}
      {layout.sections.length > 0 && (
        <button type="button" data-report-menu onClick={() => { setAddOpen(true); setConfirmDup(null); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-4 py-3 text-sm font-medium text-text-2 hover:bg-surface hover:text-text">
          <Plus className="h-4 w-4" aria-hidden /> Add Section
        </button>
      )}
      <p className="sr-only" aria-live="polite">{announce}</p>

      {targetSection && (
        <WidgetLibrary
          key={`${targetSection.id}-${target!.kind}`}
          heading={`Add to ${targetSection.title}`}
          linked={linked}
          templateMode={false}
          initialTab={TAB_OF[targetSection.type]}
          initialKind={target!.kind}
          onAdd={addWidgets}
          onClose={() => setTarget(null)}
          full={total >= MAX_WIDGETS}
        />
      )}

      {leaveTo && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center" role="presentation" onClick={() => setLeaveTo(null)}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="leave-title" className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <p id="leave-title" className="font-semibold">Discard unsaved changes?</p>
            <p className="text-sm text-text-2">Your changes to this report haven&apos;t been saved.</p>
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

function MenuItem({ icon, label, onClick, disabled = false, danger = false }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40", danger ? "text-critical-ink hover:bg-critical-bg" : "text-text hover:bg-surface-2")}
    >
      <span aria-hidden className="text-text-3">{icon}</span>
      {label}
    </button>
  );
}
