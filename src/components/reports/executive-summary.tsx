import type { ReactNode } from "react";
import type { ClientReport } from "@/server/client-report";
import { clientFacingSummary, getExecutiveSummary, summaryKey, type ExecSummary } from "@/server/exec-summary";
import { OVERVIEW_TITLE, summaryAsHtml, summaryAsText, summaryOutline } from "@/lib/exec-summary";
import { formatDate } from "@/lib/time";
import { clientNextStepLines } from "@/server/next-steps";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopySummaryButton } from "./copy-summary-button";
import { RefreshWhenReady } from "./refresh-when-ready";
import { SummaryApproval } from "./summary-approval";

/** The summary's structure: Performance overview, What the data tells us, Recommended next steps. */
function Outline({ summary, clientFacing, limit, firstParagraphOnly = false }: { summary: ExecSummary; clientFacing: boolean; limit?: number; firstParagraphOnly?: boolean }) {
  const paras = summary.overview.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <article className="flex max-w-[85ch] flex-col gap-3 text-[15px] leading-relaxed text-text">
      <section>
        <h3 className="mb-1 text-sm font-semibold">{OVERVIEW_TITLE}</h3>
        {(firstParagraphOnly ? paras.slice(0, 1) : paras).map((para, i) => <p key={i} className={i ? "mt-2" : undefined}>{para}</p>)}
      </section>
      {summaryOutline(summary, clientFacing, limit).map((sec) => {
        const List = sec.numbered ? "ol" : "ul";
        return (
          <section key={sec.title}>
            <h3 className="mb-1 text-sm font-semibold">{sec.title}</h3>
            <List className={`flex flex-col gap-1 pl-5 ${sec.numbered ? "list-decimal" : "list-disc"}`}>
              {sec.items.map((x, i) => <li key={i} className="pl-1">{x}</li>)}
            </List>
          </section>
        );
      })}
    </article>
  );
}

/** One continuous section, laid out like a written memo so it reads (and copies) cleanly. */
function SummaryText({ summary, heading, pending, copyable, compact, clientFacing = false }: { summary: ExecSummary; heading: string; pending?: boolean; copyable: boolean; compact?: boolean; clientFacing?: boolean }) {
  // Compact: the overview's first paragraph and up to three items per section; the rest behind "Read full summary".
  const LIMIT = 3;
  const paras = summary.overview.split(/\n{2,}/).filter((p) => p.trim()).length;
  const trimmed = compact && (paras > 1 || summaryOutline(summary, clientFacing).some((sec) => sec.items.length > LIMIT));
  return (
    <div className="flex flex-col gap-3" aria-busy={pending || undefined}>
      {compact ? (
        <>
          <Outline summary={summary} clientFacing={clientFacing} limit={LIMIT} firstParagraphOnly />
          {trimmed && (
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-brand-text hover:underline">
                <span className="group-open:hidden">Read full summary</span>
                <span className="hidden group-open:inline">Hide full summary</span>
              </summary>
              <div className="mt-3"><Outline summary={summary} clientFacing={clientFacing} /></div>
            </details>
          )}
        </>
      ) : (
        <Outline summary={summary} clientFacing={clientFacing} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-xs text-text-3" aria-live="polite">
          {pending ? "An AI-written summary is on its way and will replace this in a moment." : summary.source === "ai" ? "Written by AI from the figures in this report." : "Worked out automatically from the figures in this report."}
          {clientFacing ? " Results are counted by each ad platform, so a customer may be counted by more than one platform." : " Recommendations are suggestions; nothing has been changed in the ad accounts."}
        </p>
        {copyable && !pending && <CopySummaryButton html={summaryAsHtml(summary, heading)} text={summaryAsText(summary, heading)} />}
      </div>
    </div>
  );
}

/** For client-facing copies, "What we're doing next" is the agency's approved steps, never the AI's drafts. */
function withSteps(s: ExecSummary, steps: string[] | undefined): ExecSummary {
  return steps === undefined ? s : { ...s, nextSteps: steps };
}

/**
 * An overview of the selected date range, what's working, what isn't, and
 * recommendations, as one section. Shows the saved AI-written summary when
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
