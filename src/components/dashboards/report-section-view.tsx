"use client";

import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { SECTION_TYPE, type SectionType } from "@/lib/dashboards/report-sections";
import { addNewReportSectionsAction, addReportSectionAction, dismissNewReportSectionsAction, removeReportSectionAction } from "@/server/dashboards/report-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * One section of a finished Report: a subtle heading that opens and closes
 * the section (each viewer's choice is remembered in this browser), then its
 * widgets. `defaultCollapsed` is the report's setting for the section.
 */
export function ReportSectionView({ storageKey, title, defaultCollapsed = false, remove, children }: { storageKey: string; title: string; defaultCollapsed?: boolean; remove?: { clientId: string; sectionId: string }; children: ReactNode }) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const doRemove = () =>
    start(async () => {
      const res = await removeReportSectionAction(remove!.clientId, remove!.sectionId).catch(() => ({ ok: false as const, error: "Couldn't remove the section. Try again." }));
      if (!res.ok) return setError(res.error);
      setConfirm(false);
      router.refresh();
    });
  const id = useId();
  const key = `mn:report-section:${storageKey}`;
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(key);
      if (v === "open") setOpen(true);
      if (v === "closed") setOpen(false);
    } catch {
      // Storage blocked: keep the report's default.
    }
  }, [key]);
  const toggle = () =>
    setOpen((o) => {
      try {
        window.localStorage.setItem(key, o ? "closed" : "open");
      } catch {
        // Not remembered.
      }
      return !o;
    });
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-1.5">
        <h2>
          <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} className="flex cursor-pointer items-center gap-1.5 rounded text-[15px] font-semibold tracking-tight text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
            <ChevronDown className={cn("h-4 w-4 text-text-3 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} aria-hidden />
            {title}
          </button>
        </h2>
        {remove && (
          <span className="ml-auto flex items-center gap-2">
            {confirm ? (
              <>
                <span className="text-xs text-text-2">Remove {title} from this report? The connection and its data stay.</span>
                <Button type="button" size="sm" variant="destructive" onClick={doRemove} disabled={pending}>{pending ? "Removing…" : "Remove"}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={pending}>Keep</Button>
              </>
            ) : (
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(true)} className="text-text-2 hover:text-critical-ink" aria-label={`Remove section: ${title}`}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove Section
              </Button>
            )}
          </span>
        )}
        {error && <span className="w-full text-xs text-critical-ink" role="alert">{error}</span>}
      </div>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** Offered to editors of a customized report when an integration is connected later; nothing changes without a click. */
export function NewSectionsNotice({ clientId, types }: { clientId: string; types: SectionType[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const names = types.map((t) => SECTION_TYPE[t].title);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const run = (fn: typeof addNewReportSectionsAction) =>
    start(async () => {
      const res = await fn(clientId, types).catch(() => ({ ok: false as const, error: "Couldn't update the report. Try again." }));
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm">
      <span>
        <span className="font-medium">{list}</span> {types.length === 1 ? "is" : "are"} now connected. Add {types.length === 1 ? "its section" : "their sections"} to this report?
      </span>
      <span className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={() => run(addNewReportSectionsAction)} disabled={pending}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add {types.length === 1 ? "section" : "sections"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => run(dismissNewReportSectionsAction)} disabled={pending}>Not now</Button>
      </span>
      {error && <span className="w-full text-xs text-critical-ink" role="alert">{error}</span>}
    </div>
  );
}

export interface AddOption {
  type: SectionType;
  title: string;
  description: string;
  inReport: boolean;
  connected: boolean;
  removed: boolean;
}

/**
 * Add Section at the end of the finished report: pick a section (Google Ads,
 * Meta Ads, CallRail, SEO…) and it's added with its default widgets. One
 * already in the report needs a second click to add another.
 */
export function AddSectionMenu({ clientId, options }: { clientId: string; options: AddOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [again, setAgain] = useState<SectionType | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const add = (o: AddOption) => {
    if (o.inReport && again !== o.type) return setAgain(o.type);
    start(async () => {
      const res = await addReportSectionAction(clientId, o.type).catch(() => ({ ok: false as const, error: "Couldn't add the section. Try again." }));
      if (!res.ok) return setError(res.error);
      setOpen(false);
      setAgain(null);
      router.refresh();
    });
  };
  // Connected sections not yet in the report first.
  const sorted = [...options].sort((a, b) => Number(b.connected && !b.inReport) - Number(a.connected && !a.inReport));
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-text-2">Add another section to this report.</span>
        <Button type="button" variant="outline" size="sm" onClick={() => { setOpen((o) => !o); setAgain(null); }} aria-expanded={open}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add Section
        </Button>
      </div>
      {open && (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((o) => (
            <li key={o.type}>
              <button type="button" onClick={() => add(o)} disabled={pending} className="flex h-full w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-border bg-surface px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-60">
                <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                  {o.title}
                  <span className={cn("text-xs font-normal", again === o.type ? "text-brand-text" : "text-text-3")}>
                    {again === o.type ? "Click again to add another" : o.inReport ? "In the report" : o.removed ? "Removed · restore" : !o.connected ? "Not connected" : "Add"}
                  </span>
                </span>
                <span className="text-xs text-text-3">{o.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-critical-ink" role="alert">{error}</p>}
    </div>
  );
}
