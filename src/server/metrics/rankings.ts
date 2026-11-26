import "server-only";
import { prisma } from "../db";
import { addDays, dateToIso, isoToDate, todayInTimeZone } from "@/lib/pacing/dates";

// Exact keyword ranks (DataForSEO) for the dashboard "rankings" widget, the
// client's Rankings page, reports and the AI assistant. Reads KeywordRank, the
// per-keyword daily positions; daily summaries (avg position, top 10, …) are
// in MetricDaily as "rank.*" metrics and are read through ./query.ts.

export { buildKeywordRankRows, type KeywordRankRow, type KeywordRankTableOptions, type RankPoint } from "./rankings-rows";
import { buildKeywordRankRows, type KeywordRankRow, type KeywordRankTableOptions } from "./rankings-rows";

/**
 * Rows for the "rankings" widget: every tracked item of the client (one row
 * per keyword, location and device; paused items included, archived ones not)
 * with its latest position, change, best position, ranking URL, SERP features
 * and daily history.
 *
 *   const rows = await keywordRankTable(clientId, { days: 30, limit: 50 });
 *
 * Callers must already have checked that the user may view the client.
 */
export async function keywordRankTable(clientId: string, opts: KeywordRankTableOptions = {}): Promise<KeywordRankRow[]> {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 400);
  const changeDays = Math.min(Math.max(opts.changeDays ?? 7, 1), 400);
  let to = opts.to;
  if (!to) {
    const c = await prisma.client.findUnique({ where: { id: clientId }, select: { timezone: true } });
    to = todayInTimeZone(c?.timezone ?? "America/New_York");
  }
  // Active and paused items; archived ones (replaced or put away) are left out.
  const keywords = await prisma.trackedKeyword.findMany({
    where: { clientId, archivedAt: null, asset: { kind: "RANK_PROJECT" }, ...(opts.locationCode ? { locationCode: opts.locationCode } : {}) },
    select: { id: true, keyword: true, device: true, locationCode: true, locationName: true, active: true },
  });
  if (!keywords.length) return [];
  const ids = keywords.map((k) => k.id);
  // Enough history for the window, the 30-day change and a few days' slack.
  const from = addDays(to, -Math.max(days, changeDays, 30) - 4);
  const [ranks, bests] = await Promise.all([
    prisma.keywordRank.findMany({
      where: { keywordId: { in: ids }, date: { gte: isoToDate(from), lte: isoToDate(to) } },
      select: { keywordId: true, date: true, position: true, url: true, serpFeatures: true },
    }),
    prisma.keywordRank.groupBy({ by: ["keywordId"], where: { keywordId: { in: ids }, position: { not: null } }, _min: { position: true } }),
  ]);
  return buildKeywordRankRows(
    keywords,
    ranks.map((r) => ({ ...r, date: dateToIso(r.date) })),
    new Map(bests.map((b) => [b.keywordId, b._min.position])),
    { to, days, changeDays, limit: opts.limit },
  );
}
