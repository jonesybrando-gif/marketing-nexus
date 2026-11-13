// Changes against the comparison period, in words. One rule set for KPI
// tiles, dashboard widgets, the PDF and the automatic summary, so a reader who
// knows nothing about advertising gets the same verdict everywhere:
//
//   - Spend and other "neutral" metrics never get a verdict: spending more is
//     neither good nor bad on its own.
//   - A change smaller than MIN_CHANGE_PCT reads "about the same" (normal
//     variation), whatever its direction.
//   - Counts (clicks, leads…) and figures built on results (cost per lead,
//     conversion rate…) read "too few to compare" when either period has fewer
//     than MIN_SAMPLE of what they count.
//   - While platforms are still counting recent results (see `stillCounting`
//     in ./results.ts), result metrics get no verdict ("still counting").

/** Changes smaller than this (in %) are normal variation. */
export const MIN_CHANGE_PCT = 5;
/** Fewer results (or clicks, for click-based metrics) than this in either period can't be compared. */
export const MIN_SAMPLE = 10;

export type Verdict = "better" | "worse" | "same" | "few" | "counting" | "neutral";
export type Tone = "good" | "bad" | "neutral";

export interface ChangeInput {
  changePct: number | null;
  better: "up" | "down" | "neutral";
  /** What the metric rests on in each period (e.g. leads for cost per lead). Omit when sample size doesn't apply. */
  sample?: { current: number; previous: number } | null;
  /** True for result metrics while recent results are still being counted. */
  stillCounting?: boolean;
}

/** The verdict on a change, and the colour that goes with it (null when there is no comparison). */
export function changeVerdict(i: ChangeInput): { verdict: Verdict | null; tone: Tone | null } {
  if (i.changePct === null || !Number.isFinite(i.changePct)) return { verdict: null, tone: null };
  if (i.sample && (i.sample.current < MIN_SAMPLE || i.sample.previous < MIN_SAMPLE)) return { verdict: "few", tone: "neutral" };
  if (Math.abs(i.changePct) < MIN_CHANGE_PCT) return { verdict: "same", tone: "neutral" };
  if (i.better === "neutral") return { verdict: "neutral", tone: "neutral" };
  if (i.stillCounting) return { verdict: "counting", tone: "neutral" };
  const good = i.changePct > 0 === (i.better === "up");
  return { verdict: good ? "better" : "worse", tone: good ? "good" : "bad" };
}

const pctWords = (p: number) => `${Math.round(Math.abs(p))}%`;

/**
 * The change line under a figure, e.g. "Up 8% from $5,790 · better", and the
 * full sentence for screen readers. `previousText` is the formatted previous
 * value; `label` names the metric in the spoken sentence.
 */
/**
 * The short form for small tiles: "↑ 93% vs. previous period",
 * "↓ 33% vs. previous month", "— No significant change", "— Too few to
 * compare". The full wording (changeWords) goes in the tooltip.
 */
export function shortChangeWords(verdict: Verdict | null, changePct: number | null, vsLabel: string): string {
  if (verdict === null || changePct === null) return "";
  if (verdict === "few") return "— Too few to compare";
  if (verdict === "same" || Math.round(Math.abs(changePct)) === 0) return "— No significant change";
  return `${changePct > 0 ? "↑" : "↓"} ${pctWords(changePct)} vs. ${vsLabel}`;
}

export function changeWords(verdict: Verdict | null, changePct: number | null, previousText: string, label: string): { text: string; aria: string } {
  if (verdict === null || changePct === null) return { text: "", aria: "" };
  if (verdict === "few") return { text: `Too few to compare (was ${previousText})`, aria: `${label}: too few to compare with the previous period (${previousText}).` };
  if (verdict === "same") return { text: `About the same as ${previousText}`, aria: `${label}: about the same as the previous period (${previousText}), normal variation.` };
  const dir = changePct > 0 ? "Up" : "Down";
  const base = `${dir} ${pctWords(changePct)} from ${previousText}`;
  switch (verdict) {
    case "better":
      return { text: `${base} · better`, aria: `${label}: ${base.toLowerCase()}, which is better.` };
    case "worse":
      return { text: `${base} · worse`, aria: `${label}: ${base.toLowerCase()}, which is worse.` };
    case "counting":
      return { text: `${base} · still counting`, aria: `${label}: ${base.toLowerCase()}; recent results are still being counted, so this may still change.` };
    case "neutral":
      return { text: base, aria: `${label}: ${base.toLowerCase()}, neither good nor bad on its own.` };
  }
}
