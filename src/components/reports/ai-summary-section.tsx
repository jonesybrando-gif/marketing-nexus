"use client";

import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, RefreshCw, Sparkles } from "lucide-react";
import { regenerateSummaryAction } from "@/app/(app)/clients/[id]/summary-actions";
import type { ReportParams } from "@/server/client-report";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * The Report tab's AI Executive Summary: a permanent section above the
 * report's sections (not a widget). The heading, the one-line takeaway and the
 * controls always show; the three questions open with "Show full summary"
 * (see SummaryExpander). The summary is rendered on the server and passed in.
 */
export function AiSummarySection({ title, marker, actions, children }: { title: string; marker?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3 pb-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 shrink-0 text-brand-text" aria-hidden />
          {title}
          {marker}
        </h2>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="px-4 pt-1 pb-4">{children}</div>
    </section>
  );
}

/**
 * Opens and closes the full summary (What happened? / What does this mean? /
 * What should we do next?) under the takeaway. Collapsed by default; each
 * viewer's choice is remembered in this browser.
 */
export function SummaryExpander({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const key = "mn:disclosure:ai-summary-full";
  useEffect(() => {
    try {
      if (window.localStorage.getItem(key) === "open") setOpen(true);
    } catch {
      // Storage blocked: start collapsed.
    }
  }, []);
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
    <div className="flex flex-col gap-3">
      <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} className="inline-flex cursor-pointer items-center gap-1 self-start rounded text-sm font-medium text-brand-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
        <ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} aria-hidden />
        {open ? "Hide full summary" : "Show full summary"}
      </button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

/** Staff: ask the AI for a fresh summary of this range (the previous approved one keeps reaching clients until the new one is approved). */
export function RegenerateSummaryButton({ clientId, params }: { clientId: string; params: ReportParams }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      {error && <span role="alert" className="text-xs text-warning-ink">{error}</span>}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        title="Write a new AI summary for this period. It will need approval before clients see it."
        onClick={() =>
          start(async () => {
            setError(null);
            try {
              const r = await regenerateSummaryAction(clientId, params);
              if (!r.ok) return setError(r.error);
              router.refresh();
            } catch {
              setError("Couldn't regenerate. Try again.");
            }
          })
        }
      >
        <RefreshCw className={cn("h-3.5 w-3.5", pending && "animate-spin")} aria-hidden /> {pending ? "Writing…" : "Regenerate"}
      </Button>
    </span>
  );
}
