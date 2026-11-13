import type { ReactNode } from "react";
import type { ClientReport } from "@/server/client-report";
import { clientFacingSummary, getExecutiveSummary, summaryKey, type ExecSummary } from "@/server/exec-summary";
import { summaryAsHtml, summaryAsText, summaryOutline } from "@/lib/exec-summary";
import { SummaryExpander } from "./ai-summary-section";
import { formatDate } from "@/lib/time";
import { clientNextStepLines } from "@/server/next-steps";
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
  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
      <p className="text-xs text-text-3" aria-live="polite">
        {pending ? "An AI-written summary is on its way and will replace this in a moment." : summary.source === "ai" ? "Written by AI from the figures in this report." : "Worked out automatically from the figures in this report."}
        {clientFacing ? " Calls, ad results and website goals are counted separately, so the same customer can appear in more than one." : " Recommendations are suggestions; nothing has been changed in the ad accounts."}
      </p>
      {copyable && !pending && <CopySummaryButton html={summaryAsHtml(summary, heading, { clientFacing })} text={summaryAsText(summary, heading, { clientFacing })} />}
    </div>
  );
  return (
    <div className="flex flex-col gap-3" aria-busy={pending || undefined}>
      {takeaway}
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
      <SummaryText summary={withSteps(summary, steps)} heading={heading} copyable={copyable} compact={compact} clientFacing={clientFacing} pending={pending} />
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
