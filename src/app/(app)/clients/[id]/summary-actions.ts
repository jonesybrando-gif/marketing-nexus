"use server";

import { revalidatePath } from "next/cache";
import { requireClientEdit } from "@/server/access";
import { parseSummaryEdit, regenerateExecutiveSummary, saveSummaryEdit, setSummaryApproval, wantsAiSummary } from "@/server/exec-summary";
import { loadClientReport, type ReportParams } from "@/server/client-report";

export type ApprovalState = { error?: string } | undefined;

/** Approves (or withdraws) an AI-written summary for the client's reports. */
export async function approveSummaryAction(clientId: string, insightId: string, _prev: ApprovalState, form: FormData): Promise<ApprovalState> {
  const user = await requireClientEdit(clientId);
  const ok = await setSummaryApproval(clientId, insightId, user.id, form.get("approve") === "1");
  if (!ok) return { error: "That summary is no longer available. Refresh the page." };
  revalidatePath(`/clients/${clientId}`);
  return {};
}

export type RegenerateResult = { ok: true } | { ok: false; error: string };

/** Writes a fresh AI executive summary for the report's range, comparison and account filter. */
export async function regenerateSummaryAction(clientId: string, params: ReportParams): Promise<RegenerateResult> {
  await requireClientEdit(clientId);
  const p = params && typeof params === "object" ? params : {};
  const rep = await loadClientReport(clientId, { range: p.range, compare: p.compare, from: p.from, to: p.to, accounts: p.accounts });
  if (!wantsAiSummary(rep)) return { ok: false, error: "AI summaries are turned off for this client's report." };
  const ok = await regenerateExecutiveSummary(rep);
  if (!ok) return { ok: false, error: "The AI couldn't write a new summary just now. Try again in a few minutes." };
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

export type EditSummaryResult = { ok: true } | { ok: false; error: string };

/**
 * Saves the agency's edits to the executive summary and its notes ("Updates
 * from our team") for the report's range, comparison and account filter.
 * Editing an approved summary changes what clients see; an edited automatic
 * summary still needs approval before it reaches clients.
 */
export async function editSummaryAction(clientId: string, params: ReportParams, insightId: string | null, edit: unknown): Promise<EditSummaryResult> {
  const user = await requireClientEdit(clientId);
  const parsed = parseSummaryEdit(edit);
  if (!parsed.ok) return parsed;
  const p = params && typeof params === "object" ? params : {};
  const rep = await loadClientReport(clientId, { range: p.range, compare: p.compare, from: p.from, to: p.to, accounts: p.accounts });
  await saveSummaryEdit(rep, user.id, typeof insightId === "string" && insightId ? insightId : null, { summary: parsed.summary, notes: parsed.notes });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}
