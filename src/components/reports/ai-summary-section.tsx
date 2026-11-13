"use client";

import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, RefreshCw, Sparkles } from "lucide-react";
import { regenerateSummaryAction } from "@/app/(app)/clients/[id]/summary-actions";
import type { ReportParams } from "@/server/client-report";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

const KEY = "mn:disclosure:ai-executive-summary";

/**
 * The Report tab's AI Executive Summary: a permanent section above the
 * widgets (not a widget), open by default; each viewer's open/closed choice is
 * remembered in this browser. The summary itself (with its approval, copy and
 * visibility controls) is rendered on the server and passed in.
 */
export function AiSummarySection({ title, marker, actions, children }: { title: string; marker?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const id = useId();
  useEffect(() => {
    try {
      if (window.localStorage.getItem(KEY) === "closed") setOpen(false);
    } catch {
      // Storage blocked: stays open.
    }
  }, []);
  const toggle = () =>
    setOpen((o) => {
      try {
        window.localStorage.setItem(KEY, o ? "closed" : "open");
      } catch {
        // Not remembered; still toggles.
      }
      return !o;
    });
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5">
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} className="flex min-w-0 cursor-pointer items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
          <Sparkles className="h-4 w-4 shrink-0 text-brand-text" aria-hidden />
          <h2 className="text-sm font-semibold">{title}</h2>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-text-3 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} aria-hidden />
        </button>
        {marker}
        {open && actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div id={id} hidden={!open} className="border-t border-border px-4 pt-3 pb-4">
        {children}
      </div>
    </section>
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
