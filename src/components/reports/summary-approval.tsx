"use client";

import { useActionState } from "react";
import { CheckCircle2 } from "lucide-react";
import { approveSummaryAction, type ApprovalState } from "@/app/(app)/clients/[id]/summary-actions";
import { Button } from "@/components/ui/button";

/**
 * Agency only. AI-written summaries reach clients (client logins, shared
 * links, client PDFs and scheduled emails) only once someone approves them;
 * until then clients see the summary built directly from the figures.
 */
export function SummaryApproval({ clientId, insightId, approved }: { clientId: string; insightId: string; approved: boolean }) {
  const [state, act, pending] = useActionState<ApprovalState, FormData>(approveSummaryAction.bind(null, clientId, insightId), undefined);
  return (
    <form action={act} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
      <input type="hidden" name="approve" value={approved ? "0" : "1"} />
      {approved ? (
        <>
          <span className="flex items-center gap-1.5 font-medium text-good-ink"><CheckCircle2 className="h-4 w-4" aria-hidden /> Approved for client reports</span>
          <Button type="submit" size="sm" variant="ghost" disabled={pending}>Withdraw</Button>
        </>
      ) : (
        <>
          <span className="text-text-2">Clients see the automatic summary until you approve this one.</span>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>{pending ? "Approving…" : "Approve for client reports"}</Button>
        </>
      )}
      {state?.error && <span role="alert" className="text-warning-ink">{state.error}</span>}
    </form>
  );
}
