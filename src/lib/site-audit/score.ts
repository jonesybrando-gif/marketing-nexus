// The Site Auditor health score: our own, so it is stable and explainable
// (DataForSEO's onpage_score is stored alongside for reference).
//
// Each distinct kind of issue found costs points, by severity:
//
//   error up to 10 points, warning up to 4, notice up to 1
//   cost = weight × (0.25 + 0.75 × share of pages affected)
//   score = 100 − sum of costs, clamped to 0–100 and rounded
//
// An issue on a single page costs a quarter of its weight; on every page, all
// of it. So one problem repeated on every page (a footer link, a template tag)
// costs at most 10 points instead of zeroing the score, and the score only
// nears 0 when there are many different serious problems. Site-wide yes/no
// checks (no sitemap) count as affecting every page; lists of URLs that aren't
// crawled pages (redirect loops, blocked pages) use their count over pages.

import { ISSUE_BY_KEY, type Severity } from "./issues";

export const SCORE_WEIGHTS: Record<Severity, number> = { error: 10, warning: 4, notice: 1 };
/** Share of the weight an issue costs as soon as it's found at all. */
export const PRESENCE_SHARE = 0.25;

export interface ScoredIssue {
  key: string;
  severity: Severity;
  /** Pages affected (site-wide checks: occurrences). */
  count: number;
}

/** Points one kind of issue takes off the score. */
export function issueCost(issue: ScoredIssue, pages: number): number {
  if (issue.count <= 0) return 0;
  const presence = ISSUE_BY_KEY[issue.key]?.presence === true;
  const share = presence ? 1 : Math.min(1, issue.count / Math.max(pages, 1));
  return SCORE_WEIGHTS[issue.severity] * (PRESENCE_SHARE + (1 - PRESENCE_SHARE) * share);
}

/** 0–100, or null when nothing was crawled. */
export function healthScore(input: { pages: number; issues: ScoredIssue[] }): number | null {
  if (!input.pages || input.pages <= 0) return null;
  const cost = input.issues.reduce((sum, i) => sum + issueCost(i, input.pages), 0);
  return Math.round(Math.min(100, Math.max(0, 100 - cost)));
}

/** One line for the tab and reports. */
export const SCORE_EXPLANATION = "Each kind of issue found costs points: an error up to 10, a warning up to 4, a notice up to 1. An issue on one page costs a quarter of that; on every page, all of it.";

/** Words for a score band, for headers and reports. */
export function scoreBand(score: number | null): { label: string; tone: "good" | "warning" | "critical" | "neutral" } {
  if (score === null) return { label: "No score yet", tone: "neutral" };
  if (score >= 80) return { label: "Healthy", tone: "good" };
  if (score >= 50) return { label: "Needs work", tone: "warning" };
  return { label: "Poor", tone: "critical" };
}
