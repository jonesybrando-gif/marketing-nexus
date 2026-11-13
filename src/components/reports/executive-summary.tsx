import type { ReactNode } from "react";
import type { ClientReport } from "@/server/client-report";
import { clientFacingSummary, getExecutiveSummary, summaryKey, type ExecSummary } from "@/server/exec-summary";
import { SUMMARY_TITLES, summaryAsHtml, summaryAsText, summaryOutline } from "@/lib/exec-summary";
import { SummaryEditor } from "./summary-editor";
import { SummaryExpander } from "./ai-summary-section";
import { formatDate } from "@/lib/time";
import { clientNextStepLines } from "@/server/next-steps";
import { summaryChannels } from "@/server/ai/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopySummaryButton } from "./copy-summary-button";
import { RefreshWhenReady } from "./refresh-when-ready";
import { SummaryApproval } from "./summary-approval";

/** The three questions: What happened?, What does this mean?, What should we do next? */
function Sections({ summary, clientFacing }: { summary: ExecSummary; clientFacing: boolean }) {
  const sections = summaryOutline(summary, clientFacing);
  if (!sections.length) return null;
  return (
    <article className="flex max-w-[85ch] flex-col gap-4 text-[15px] leading-relaxed text-text">
      {sections.map((sec) => (
        <section key={sec.title}>
          <h3 className="mb-1 text-sm font-semibold">{sec.title}</h3>
          {sec.text && <p>{sec.text}</p>}
          {sec.labelled && (
            <dl className="flex flex-col gap-2">
              {sec.labelled.map((l) => (
                <div key={l.label} className="grid gap-x-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
                  <dt className="text-sm font-semibold text-text-2 sm:pt-0.5">{l.label}</dt>
                  <dd>{l.text}</dd>
                </div>
              ))}
            </dl>
          )}
          {sec.items.length > 0 && (
            <ol className="flex list-decimal flex-col gap-1 pl-5">
              {sec.items.map((x, i) => <li key={i} className="pl-1">{x}</li>)}
            </ol>
          )}
        </section>
      ))}
    </article>
  );
}

/**
 * One summary. Compact (the Report tab): the takeaway, then "Show full summary"
 * opens the three questions; the takeaway isn't repeated inside. Otherwise
 * (AI Insights, staff): the takeaway and the three questions together.
 */
function SummaryText({ summary, heading, pending, copyable, compact, clientFacing = false }: { summary: ExecSummary; heading: string; pending?: boolean; copyable: boolean; compact?: boolean; clientFacing?: boolean }) {
  const takeaway = summary.takeaway.trim() && <p className="max-w-[85ch] text-[15px] leading-relaxed font-medium text-text">{summary.takeaway.trim()}</p>;
  // The agency's own updates, in their words, right under the takeaway (also while collapsed).
  const notes = summary.notes?.trim() && (
    <section className="max-w-[85ch] rounded-lg border-l-2 border-brand bg-surface-2 px-3 py-2">
      <h3 className="mb-0.5 text-xs font-semibold tracking-wide text-text-2 uppercase">{SUMMARY_TITLES.notes}</h3>
      {summary.notes.trim().split(/\n{2,}/).map((p, i) => <p key={i} className="text-sm leading-relaxed whitespace-pre-line text-text">{p}</p>)}
    </section>
  );
  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
      <p className="text-xs text-text-3" aria-live="polite">
        {pending
          ? "An AI-written summary is on its way and will replace this in a moment."
          : summary.source === "ai"
            ? summary.edited ? "Written by AI from the figures in this report, edited by your team." : "Written by AI from the figures in this report."
            : summary.source === "edited"
              ? "Written by your team from the figures in this report."
              : "Worked out automatically from the figures in this report."}
        {clientFacing ? " Calls, ad results and website goals are counted separately, so the same customer can appear in more than one." : " Recommendations are suggestions; nothing has been changed in the ad accounts."}
      </p>
      {copyable && !pending && <CopySummaryButton html={summaryAsHtml(summary, heading, { clientFacing })} text={summaryAsText(summary, heading, { clientFacing })} />}
    </div>
  );
  return (
    <div className="flex flex-col gap-3" aria-busy={pending || undefined}>
      {takeaway}
      {notes}
      {compact ? (
        <SummaryExpander>
          <div className="flex flex-col gap-3">
            <Sections summary={summary} clientFacing={clientFacing} />
            {footer}
          </div>
        </SummaryExpander>
      ) : (
        <>
          <Sections summary={summary} clientFacing={clientFacing} />
          {footer}
        </>
      )}
    </div>
  );
}

/** The page's range, comparison and account filter, so an edit saves to the summary on screen. */
const reportParams = (rep: ClientReport) => ({
  range: rep.preset,
  compare: rep.compareMode,
  from: rep.range.from,
  to: rep.range.to,
  accounts: rep.accountScope?.selected?.length ? rep.accountScope.selected.join(",") : undefined,
});

/** For client-facing copies, "What we're doing next" is the agency's approved steps, never the AI's drafts. */
function withSteps(s: ExecSummary, steps: string[] | undefined): ExecSummary {
  return steps === undefined ? s : { ...s, nextSteps: steps };
}

/**
 * The executive summary for the selected date range: a one-line takeaway and
 * What happened?, What does this mean?, What should we do next?. Shows the saved AI-written summary when
 * there is one; otherwise the automatic version at once while the AI writes
 * one in the background, which then replaces it without a reload. The page
 * never waits on the AI.
 */
/** `clientFacing` (client logins, shared links): "What we're doing next" in agency voice replaces Recommendations. */
export async function ExecutiveSummary({ rep, marker, copyable = false, compact = false, title = "Executive summary", actions, bare = false, clientFacing = false }: { rep: ClientReport; marker?: ReactNode; copyable?: boolean; compact?: boolean; title?: string; actions?: ReactNode; bare?: boolean; clientFacing?: boolean }) {
  // Clients only ever read next steps a person approved; AI-drafted ones stay with the agency.
  const steps = clientFacing ? await clientNextStepLines(rep.client.id, rep.client.timezone) : undefined;
  // Clients only ever read AI-written text the agency approved; otherwise the automatic summary.
  const shown: ExecSummary & { pending?: boolean; insightId?: string; approved?: boolean } = clientFacing ? await clientFacingSummary(rep) : await getExecutiveSummary(rep, { generate: "background" });
  const { pending, insightId, approved, ...summary } = shown;
  const heading = `${rep.client.name}: performance summary, ${formatDate(rep.range.from)} – ${formatDate(rep.range.to, { month: "short", day: "numeric", year: "numeric" })}`;
  const body = (
    <>
      {copyable && !clientFacing && !pending ? (
        // Staff who see the copy controls can also edit the wording and add their own updates.
        <SummaryEditor clientId={rep.client.id} params={reportParams(rep)} insightId={insightId ?? null} summary={summary} approved={!!approved} channelNames={await summaryChannels(rep).catch(() => [])}>
          <SummaryText summary={summary} heading={heading} copyable={copyable} compact={compact} clientFacing={false} pending={pending} />
        </SummaryEditor>
      ) : (
        <SummaryText summary={withSteps(summary, steps)} heading={heading} copyable={copyable} compact={compact} clientFacing={clientFacing} pending={pending} />
      )}
      {pending && <RefreshWhenReady summaryKey={summaryKey(rep)} />}
      {!clientFacing && insightId && <SummaryApproval clientId={rep.client.id} insightId={insightId} approved={!!approved} />}
    </>
  );
  if (bare) return body;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2"><CardTitle>{title}</CardTitle>{marker}</div>
          {actions}
        </div>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
