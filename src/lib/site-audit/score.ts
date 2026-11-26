// The Site Auditor health score: our own, so it is stable and explainable
// (DataForSEO's onpage_score is stored alongside for reference).
//
//   score = 100 − 100 × (1.0 × share of pages with an error
//                        + 0.4 × share of pages with a warning
//                        + 0.1 × share of pages with a notice)
//
// clamped to 0–100 and rounded. A page with both an error and a warning counts
// in both shares, so a site where every page has errors and warnings scores 0.
// Site-wide checks (no sitemap, redirect loops, blocked pages) are listed as
// issues but don't move the score: they aren't a share of crawled pages.

import { SEVERITY_WEIGHT } from "./issues";

export function healthScore(input: { pages: number; errorPages: number; warningPages: number; noticePages: number }): number | null {
  if (!input.pages || input.pages <= 0) return null;
  const share = (n: number) => Math.min(Math.max(n, 0), input.pages) / input.pages;
  const penalty = SEVERITY_WEIGHT.error * share(input.errorPages) + SEVERITY_WEIGHT.warning * share(input.warningPages) + SEVERITY_WEIGHT.notice * share(input.noticePages);
  return Math.round(Math.min(100, Math.max(0, 100 - 100 * penalty)));
}

/** Words for a score band, for headers and reports. */
export function scoreBand(score: number | null): { label: string; tone: "good" | "warning" | "critical" | "neutral" } {
  if (score === null) return { label: "No score yet", tone: "neutral" };
  // A site whose every page has only warnings scores 60 at most: "Needs work", not "Poor".
  if (score >= 80) return { label: "Healthy", tone: "good" };
  if (score >= 50) return { label: "Needs work", tone: "warning" };
  return { label: "Poor", tone: "critical" };
}
