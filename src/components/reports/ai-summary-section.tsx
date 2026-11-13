"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Sparkles } from "lucide-react";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { regenerateSummaryAction } from "@/app/(app)/clients/[id]/summary-actions";
import type { ReportParams } from "@/server/client-report";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * The Report tab's AI Executive Summary: a permanent section above the
 * widgets (not a widget), open by default; each viewer's choice is remembered.
 * The summary itself (with its approval, copy and visibility controls) is
 * rendered on the server and passed in.
 */
export function AiSummarySection({ title, marker, actions, children }: { title: string; marker?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <CollapsibleSection storageKey="ai-executive-summary" title={title} icon={<Sparkles className="h-4 w-4 shrink-0 text-brand-text" aria-hidden />} marker={marker} actions={actions}>
      {children}
    </CollapsibleSection>
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
