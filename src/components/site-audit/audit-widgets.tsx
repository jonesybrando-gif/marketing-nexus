import { CheckCircle2 } from "lucide-react";
import type { MetricInfo } from "@/lib/dashboards/metrics";
import type { AuditIssueLite } from "@/lib/dashboards/widget-data";
import { CATEGORY_LABEL, type Category } from "@/lib/site-audit/issues";
import { SCORE_EXPLANATION, scoreBand } from "@/lib/site-audit/score";
import { formatDate } from "@/lib/time";
import { SeriesChart } from "@/components/charts/series-chart";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";

// Site audit pieces shared by the dashboard/report widgets and the client's
// Site Audit tab. Plain components: they render the same in reports, shared
// links and the PDF-style view.

export const SCORE_METRIC: MetricInfo = {
  key: "audit.healthScore",
  source: "audit",
  label: "Site health score",
  short: "Health score",
  format: "count",
  better: "up",
  description: `Our 0–100 score. ${SCORE_EXPLANATION}`,
  plain: "Higher is better: fewer pages with technical SEO problems.",
};

const SEV_VARIANT = { error: "critical", warning: "warning", notice: "neutral" } as const;
const SEV_WORD = { error: "Error", warning: "Warning", notice: "Notice" } as const;
const day = (iso: string) => formatDate(iso.slice(0, 10), { month: "short", day: "numeric", year: "numeric" });

export function ScoreChange({ score, previous }: { score: number | null; previous: number | null }) {
  if (score === null || previous === null) return null;
  const d = score - previous;
  if (d === 0) return <span className="text-sm text-text-3">no change</span>;
  return <span className={cn("text-sm font-medium tabular", d > 0 ? "text-good-ink" : "text-critical-ink")}>{d > 0 ? "▲" : "▼"} {Math.abs(d)}</span>;
}

/** Big score, band, change and a trend chart over every crawl. */
export function AuditScoreBody({ score, previous, comparedAt, pages, errorPages, crawledAt, trend, chart = true, chartClassName = "min-h-32 flex-1" }: {
  score: number | null; previous: number | null; comparedAt: string | null; pages: number | null; errorPages: number | null; crawledAt: string;
  trend: { dates: string[]; scores: (number | null)[] }; chart?: boolean;
  /** Fills the widget's grid cell by default; pages without a fixed height pass a height. */
  chartClassName?: string;
}) {
  const band = scoreBand(score);
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <span className="text-4xl font-semibold tabular leading-none">{score ?? "—"}<span className="text-base font-normal text-text-3">/100</span></span>
        <Badge variant={band.tone === "neutral" ? "neutral" : band.tone}>{band.label}</Badge>
        <ScoreChange score={score} previous={previous} />
      </div>
      <p className="text-xs text-text-2">
        {pages ?? 0} pages checked{errorPages !== null && <> · {errorPages} with errors</>} · crawled {day(crawledAt)}
        {comparedAt && previous !== null && <> · vs {previous} on {day(comparedAt)}</>}
      </p>
      {chart && trend.dates.length > 1 && (
        <div className={chartClassName}>
          <SeriesChart dates={trend.dates} metrics={[SCORE_METRIC]} current={{ [SCORE_METRIC.key]: trend.scores }} previous={null} previousDates={null} />
        </div>
      )}
    </div>
  );
}

function ChangeBadge({ change, previous }: { change: AuditIssueLite["change"]; previous: number | null }) {
  if (change === "new") return <Badge variant="critical">new</Badge>;
  if (change === "worse") return <Badge variant="warning">worse (was {previous})</Badge>;
  if (change === "better") return <Badge variant="good">better (was {previous})</Badge>;
  if (change === "fixed") return <Badge variant="good">fixed</Badge>;
  return null;
}

/** Issues with severity, pages affected, change and how to fix (expand for fix guidance). */
export interface AuditTarget { url: string; status: number | null; pages: number }

/** Broken resources or link targets: the URL that fails, its HTTP status and how many pages use it. */
function TargetList({ targets }: { targets: AuditTarget[] }) {
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {targets.map((t) => (
        <li key={t.url} className="flex items-center gap-2">
          <a href={t.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate text-brand-text hover:underline" title={t.url}>{t.url}</a>
          <span className="shrink-0 text-text-3 tabular">{t.status ? `HTTP ${t.status}` : "no response"} · used by {t.pages} page{t.pages === 1 ? "" : "s"}</span>
        </li>
      ))}
    </ul>
  );
}

export function AuditIssueList({ rows, sampleUrls, targets, compact = false }: { rows: AuditIssueLite[]; sampleUrls?: Record<string, string[]>; targets?: Record<string, AuditTarget[]>; compact?: boolean }) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => (
        <li key={r.key} className={cn("py-2", compact ? "px-4" : "px-1")}>
          <details className="group">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
              <Badge variant={SEV_VARIANT[r.severity]} className="w-[4.5rem] justify-center">{SEV_WORD[r.severity]}</Badge>
              <span className={cn("min-w-0 flex-1 font-medium", r.change === "fixed" && "text-text-2 line-through decoration-text-3")}>{r.label}</span>
              <span className="text-xs text-text-3">{CATEGORY_LABEL[r.category as Category] ?? r.category}</span>
              <ChangeBadge change={r.change} previous={r.previous} />
              <span className="w-20 text-right text-sm font-semibold tabular">{r.change === "fixed" ? <span className="font-normal text-text-3">was {r.previous}</span> : `${r.count} ${r.count === 1 ? "page" : "pages"}`}</span>
              <span aria-hidden className="text-xs text-text-3 group-open:rotate-90">›</span>
            </summary>
            <div className="mt-2 flex flex-col gap-1.5 pl-[5.25rem] text-sm">
              <p><span className="font-medium">How to fix: </span>{r.fix}</p>
              {targets?.[r.key]?.length ? (
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-text-2">{r.key === "broken_resources" ? "Resources that failed to load" : "Links that fail"}</p>
                  <TargetList targets={targets[r.key]} />
                </div>
              ) : null}
              {targets?.[r.key]?.length ? null : sampleUrls?.[r.key]?.length ? (
                <ul className="flex flex-col gap-0.5 text-xs">
                  {sampleUrls[r.key].map((u) => <li key={u} className="truncate"><a href={u} target="_blank" rel="noreferrer noopener" className="text-brand-text hover:underline">{u}</a></li>)}
                </ul>
              ) : null}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

export function AuditFixedBody({ rows, since }: { rows: AuditIssueLite[]; since: string | null }) {
  if (!rows.length) return <p className="text-sm text-text-2">Nothing fixed since {since ? day(since) : "the previous crawl"}.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-text-2">{rows.length} issue{rows.length === 1 ? "" : "s"} no longer found since {since ? day(since) : "the previous crawl"}.</p>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-good-ink" aria-hidden />
            <span className="min-w-0 flex-1">{r.label}</span>
            <span className="text-xs text-text-3 tabular">was {r.previous} page{r.previous === 1 ? "" : "s"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AuditSummaryBody({ overview, fixes, regressions }: { overview: string; fixes: { title: string; why: string }[]; regressions: string[] }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>{overview}</p>
      {fixes.length > 0 && (
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          {fixes.map((f) => <li key={f.title}><span className="font-medium">{f.title}.</span> <span className="text-text-2">{f.why}</span></li>)}
        </ol>
      )}
      {regressions.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-critical-ink">Got worse since the last crawl</p>
          <ul className="list-disc pl-5 text-text-2">{regressions.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
