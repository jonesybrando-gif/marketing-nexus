"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { MessageSquarePlus, Pencil } from "lucide-react";
import { editSummaryAction } from "@/app/(app)/clients/[id]/summary-actions";
import type { ReportParams } from "@/server/client-report";
import { MAX_STEPS, SUMMARY_TITLES, type SummaryWithNotes } from "@/lib/exec-summary";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";

const area = "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

/**
 * Agency only: "Edit summary" rewrites the summary's wording, "Add update"
 * opens the same form at the notes ("Updates from our team"), which show
 * under the takeaway. Shows `children` (the summary) while not editing.
 */
export function SummaryEditor({ clientId, params, insightId, summary, approved, channelNames = [], children }: { clientId: string; params: ReportParams; insightId: string | null; summary: SummaryWithNotes; approved: boolean; channelNames?: string[]; children: ReactNode }) {
  const router = useRouter();
  const [editing, setEditing] = useState<false | "all" | "notes">(false);
  const [draft, setDraft] = useState(() => toDraft(summary, channelNames));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const open = (mode: "all" | "notes") => {
    setDraft(toDraft(summary, channelNames));
    setError(null);
    setEditing(mode);
  };
  const set = (k: keyof typeof draft, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const setChannel = (i: number, v: string) => setDraft((d) => ({ ...d, channels: d.channels.map((c, j) => (j === i ? { ...c, update: v } : c)) }));
  const setStep = (i: number, v: string) => setDraft((d) => ({ ...d, steps: d.steps.map((x, j) => (j === i ? v : x)) }));
  const save = () =>
    start(async () => {
      setError(null);
      const steps = draft.steps.map((x) => x.trim()).filter(Boolean);
      const res = await editSummaryAction(clientId, params, insightId, { takeaway: draft.takeaway, happened: draft.happened, channels: draft.channels.filter((c) => c.update.trim()), meaning: draft.meaning, recommendations: steps, nextSteps: summary.nextSteps, notes: draft.notes }).catch(() => ({ ok: false as const, error: "Couldn't save. Check your connection and try again." }));
      if (!res.ok) return setError(res.error);
      setEditing(false);
      router.refresh();
    });

  if (!editing) {
    return (
      <div className="flex flex-col gap-3">
        {children}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => open("all")}>
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit summary
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => open("notes")}>
            <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden /> {summary.notes?.trim() ? "Edit update" : "Add update"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {editing === "all" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="es-takeaway">Takeaway (shown while the summary is collapsed)</Label>
            <textarea id="es-takeaway" rows={2} maxLength={600} value={draft.takeaway} onChange={(e) => set("takeaway", e.target.value)} autoFocus className={area} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="es-happened">{SUMMARY_TITLES.happened}</Label>
            <textarea id="es-happened" rows={4} maxLength={1500} value={draft.happened} onChange={(e) => set("happened", e.target.value)} className={area} />
          </div>
          {draft.channels.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{SUMMARY_TITLES.channels}</legend>
              {draft.channels.map((c, i) => (
                <div key={c.channel} className="flex flex-col gap-1">
                  <Label htmlFor={`es-ch-${i}`} className="text-xs text-text-2">{c.channel}</Label>
                  <textarea id={`es-ch-${i}`} rows={2} maxLength={600} value={c.update} onChange={(e) => setChannel(i, e.target.value)} className={area} placeholder="Leave empty to leave this channel out" />
                </div>
              ))}
            </fieldset>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="es-meaning">{SUMMARY_TITLES.meaning}</Label>
            <textarea id="es-meaning" rows={4} maxLength={1500} value={draft.meaning} onChange={(e) => set("meaning", e.target.value)} className={area} />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">{SUMMARY_TITLES.next}</legend>
            {draft.steps.map((x, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="pt-2 text-sm text-text-3 tabular">{i + 1}.</span>
                <textarea aria-label={`Step ${i + 1}`} rows={2} maxLength={400} value={x} onChange={(e) => setStep(i, e.target.value)} className={area} placeholder={i === 0 ? "What to do and why it matters" : "Optional"} />
              </div>
            ))}
            <p className="text-xs text-text-3">Up to {MAX_STEPS}. Clients see the next steps you approve under Next steps, not these.</p>
          </fieldset>
        </>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="es-notes">{SUMMARY_TITLES.notes}</Label>
        <textarea id="es-notes" rows={3} maxLength={2000} value={draft.notes} onChange={(e) => set("notes", e.target.value)} autoFocus={editing === "notes"} className={area} placeholder="Anything the figures don't show: a new landing page went live, the office was closed for a holiday, a promotion started…" />
        <p className="text-xs text-text-3">Shown under the takeaway, in your words. Kept when the AI summary is regenerated.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={pending}>Cancel</Button>
        <span className="text-xs text-text-3">{approved ? "This summary is approved, so clients will see your changes." : "Clients see it once you approve it for client reports."}</span>
      </div>
      {error && <p className="text-sm text-critical-ink" role="alert">{error}</p>}
    </form>
  );
}

/** Every channel the client tracks gets a box (empty when the summary doesn't cover it yet), plus any extra the summary has. */
function toDraft(s: SummaryWithNotes, channelNames: string[]) {
  const have = s.channels ?? [];
  const names = [...channelNames, ...have.map((c) => c.channel).filter((n) => !channelNames.includes(n))];
  const steps = [...s.recommendations.slice(0, MAX_STEPS)];
  while (steps.length < MAX_STEPS) steps.push("");
  return { takeaway: s.takeaway, happened: s.happened, channels: names.map((channel) => ({ channel, update: have.find((c) => c.channel === channel)?.update ?? "" })), meaning: s.meaning, steps, notes: s.notes ?? "" };
}
