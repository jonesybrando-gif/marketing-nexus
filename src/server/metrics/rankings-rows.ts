// Pure row building for keyword rank tables (no DB access). Used by
// ./rankings.ts; kept separate so it can be unit-tested without Prisma.
import { addDays, type IsoDate } from "@/lib/pacing/dates";
import { shortLocationName } from "@/lib/rankings";

export interface KeywordRankRow {
  keywordId: string;
  keyword: string;
  device: "desktop" | "mobile";
  locationCode: number;
  /** Display name, e.g. "Dublin, California" ("United States" for the country). */
  locationName: string;
  /** Checks are paused for this item (history still shown). */
  paused: boolean;
  /** Latest organic position on or before `to`; null = not in the top 100 (or not checked yet). */
  position: number | null;
  /** Date of that latest check, or null if never checked. */
  checkedOn: IsoDate | null;
  /** position − position `changeDays` earlier. Negative = moved up (better). Null when either is missing. */
  change: number | null;
  /** Same, vs 7 and 30 days earlier. */
  change7: number | null;
  change30: number | null;
  /** True when it ranks now but did not on the comparison day `changeDays` earlier. */
  newlyRanked: boolean;
  /** Best (lowest) position ever recorded, or null. */
  best: number | null;
  /** Ranking URL at the latest check. */
  url: string | null;
  /** SERP item types present at the latest check (e.g. "local_pack", "people_also_ask"). */
  serpFeatures: string[];
  /** One entry per day of the window, oldest first; position null = not ranked / not checked. */
  history: { date: IsoDate; position: number | null }[];
}

export interface KeywordRankTableOptions {
  /** Last day of the window (client's local date). Default: today in the client's time zone. */
  to?: IsoDate;
  /** Days of history returned per row. Default 30. */
  days?: number;
  /** Comparison for `change`, in days. Default 7. */
  changeDays?: number;
  /** Max rows (sorted by position, unranked last). Default all. */
  limit?: number;
  /** Only items at this DataForSEO location. */
  locationCode?: number;
}

export interface RankPoint { keywordId: string; date: IsoDate; position: number | null; url: string | null; serpFeatures: unknown }

/** Position on `date`, or on the closest earlier check within 3 days (checks can skip a day). */
function positionAround(byDate: Map<IsoDate, RankPoint>, date: IsoDate): { found: boolean; position: number | null } {
  for (let i = 0; i <= 3; i++) {
    const p = byDate.get(addDays(date, -i));
    if (p) return { found: true, position: p.position };
  }
  return { found: false, position: null };
}

/** Pure: builds table rows from keywords and their rank points. Exported for tests. */
export function buildKeywordRankRows(
  keywords: { id: string; keyword: string; device: string; locationCode: number; locationName?: string | null; active?: boolean }[],
  points: RankPoint[],
  best: Map<string, number | null>,
  opts: Required<Pick<KeywordRankTableOptions, "to" | "days" | "changeDays">> & { limit?: number },
): KeywordRankRow[] {
  const byKw = new Map<string, Map<IsoDate, RankPoint>>();
  for (const p of points) {
    if (p.date > opts.to) continue;
    const m = byKw.get(p.keywordId) ?? new Map<IsoDate, RankPoint>();
    m.set(p.date, p);
    byKw.set(p.keywordId, m);
  }
  const windowDays: IsoDate[] = [];
  for (let i = opts.days - 1; i >= 0; i--) windowDays.push(addDays(opts.to, -i));
  const rows = keywords.map((k): KeywordRankRow => {
    const m = byKw.get(k.id) ?? new Map<IsoDate, RankPoint>();
    const latestDate = [...m.keys()].sort().at(-1) ?? null;
    const latest = latestDate ? m.get(latestDate)! : null;
    const delta = (days: number) => {
      if (!latest || latest.position === null) return null;
      const prev = positionAround(m, addDays(latest.date, -days));
      return prev.found && prev.position !== null ? latest.position - prev.position : null;
    };
    const cmp = latest ? positionAround(m, addDays(latest.date, -opts.changeDays)) : { found: false, position: null };
    return {
      keywordId: k.id,
      keyword: k.keyword,
      device: k.device === "mobile" ? "mobile" : "desktop",
      locationCode: k.locationCode,
      locationName: shortLocationName(k.locationName, k.locationCode),
      paused: k.active === false,
      position: latest?.position ?? null,
      checkedOn: latest?.date ?? null,
      change: delta(opts.changeDays),
      change7: delta(7),
      change30: delta(30),
      newlyRanked: !!latest && latest.position !== null && cmp.found && cmp.position === null,
      best: best.get(k.id) ?? null,
      url: latest?.url ?? null,
      serpFeatures: Array.isArray(latest?.serpFeatures) ? (latest!.serpFeatures as unknown[]).filter((x): x is string => typeof x === "string") : [],
      history: windowDays.map((date) => ({ date, position: m.get(date)?.position ?? null })),
    };
  });
  rows.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.keyword.localeCompare(b.keyword) || a.locationName.localeCompare(b.locationName) || a.device.localeCompare(b.device));
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}
