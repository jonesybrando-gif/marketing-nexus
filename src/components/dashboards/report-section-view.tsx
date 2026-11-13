"use client";

import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Plus } from "lucide-react";
import { SECTION_TYPE, type SectionType } from "@/lib/dashboards/report-sections";
import { addNewReportSectionsAction, dismissNewReportSectionsAction } from "@/server/dashboards/report-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * One section of a finished Report: a subtle heading that opens and closes
 * the section (each viewer's choice is remembered in this browser), then its
 * widgets. `defaultCollapsed` is the report's setting for the section.
 */
export function ReportSectionView({ storageKey, title, defaultCollapsed = false, children }: { storageKey: string; title: string; defaultCollapsed?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!defaultCollapsed);
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
      <h2 className="border-b border-border pb-1.5">
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} className="flex cursor-pointer items-center gap-1.5 rounded text-[15px] font-semibold tracking-tight text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
          <ChevronDown className={cn("h-4 w-4 text-text-3 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} aria-hidden />
          {title}
        </button>
      </h2>
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
