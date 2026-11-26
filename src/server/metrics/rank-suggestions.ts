import "server-only";
import { prisma } from "../db";
import { metricBreakdown } from "./query";
import { addDays, todayInTimeZone } from "@/lib/pacing/dates";
import { cityInQuery, marketCitiesFromPages, stateOfLocation, type CityIndex, type CityLocation } from "@/lib/rank-cities";
import { usCityIndex } from "../data-sources/dataforseo/locations";

// Keyword suggestions for rank tracking from the client's Search Console:
// top queries not tracked yet, each with a location: the city the query names
// ("reptile party dublin" → Dublin, California) or the client's default.

export interface RankSuggestion {
  keyword: string;
  clicks: number;
  impressions: number;
  /** Average Google position in Search Console over the window. */
  position: number | null;
  location: { code: number; name: string };
  /** True when the location came from a city named in the query. */
  fromCity: boolean;
}

export interface RankSuggestionsResult {
  hasSearchConsole: boolean;
  suggestions: RankSuggestion[];
  /** Cities the client's landing pages are about: one-click locations in the add panel. */
  marketCities: { code: number; name: string }[];
}

const WINDOW_DAYS = 90;

/** Pure: suggestion rows from Search Console tables. Exported for tests. */
export function buildRankSuggestions(input: {
  queries: { value: string; clicks: number; impressions: number; position: number | null }[];
  pages: string[];
  tracked: Set<string>;
  index: CityIndex | null;
  defaultLocation: { code: number; name: string };
  limit?: number;
}): { suggestions: RankSuggestion[]; marketCities: CityLocation[] } {
  const defaultState = stateOfLocation(input.defaultLocation.name);
  const marketCities = input.index ? marketCitiesFromPages(input.pages, input.index, defaultState) : [];
  const suggestions: RankSuggestion[] = [];
  for (const q of input.queries) {
    const keyword = q.value.replace(/\s+/g, " ").trim().toLowerCase();
    if (!keyword || keyword.length > 200 || input.tracked.has(keyword)) continue;
    const city = input.index ? cityInQuery(keyword, input.index, { defaultState, marketCities }) : null;
    suggestions.push({
      keyword,
      clicks: q.clicks,
      impressions: q.impressions,
      position: q.position,
      location: city ? { code: city.code, name: city.name } : input.defaultLocation,
      fromCity: !!city,
    });
    if (suggestions.length >= (input.limit ?? 25)) break;
  }
  return { suggestions, marketCities };
}

/** Suggestions for a client. Callers must already have checked the user may edit the client. */
export async function rankSuggestions(clientId: string, agencyId: string, defaultLocation: { code: number; name: string }): Promise<RankSuggestionsResult> {
  const [client, gsc, tracked] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { timezone: true } }),
    prisma.dataAsset.count({ where: { clientId, kind: "GSC_SITE" } }),
    prisma.trackedKeyword.findMany({ where: { clientId, archivedAt: null }, select: { keyword: true }, distinct: ["keyword"] }),
  ]);
  if (!gsc) return { hasSearchConsole: false, suggestions: [], marketCities: [] };
  const to = todayInTimeZone(client.timezone);
  const from = addDays(to, -WINDOW_DAYS);
  const [queries, pages, index] = await Promise.all([
    metricBreakdown(clientId, "query", ["gsc.clicks", "gsc.impressions", "gsc.position"], from, to, 200),
    metricBreakdown(clientId, "page", ["gsc.clicks", "gsc.impressions"], from, to, 300),
    usCityIndex(agencyId).catch(() => null),
  ]);
  const { suggestions, marketCities } = buildRankSuggestions({
    queries: queries.map((q) => ({ value: q.value, clicks: q.metrics["gsc.clicks"] ?? 0, impressions: q.metrics["gsc.impressions"] ?? 0, position: q.metrics["gsc.position"] ?? null })),
    pages: pages.map((p) => p.value),
    tracked: new Set(tracked.map((t) => t.keyword)),
    index,
    defaultLocation,
  });
  return { hasSearchConsole: true, suggestions, marketCities: marketCities.map((c) => ({ code: c.code, name: c.name })) };
}

/**
 * A starting default location for a client with no rank project yet: its
 * Business Profile city when that name is one US city. Null otherwise (the
 * caller falls back to the United States).
 */
export async function guessDefaultLocation(clientId: string, agencyId: string): Promise<{ code: number; name: string } | null> {
  const gbp = await prisma.dataAsset.findFirst({ where: { clientId, kind: "GBP_LOCATION" }, select: { name: true } });
  const city = gbp?.name.match(/\(([^()]+)\)\s*$/)?.[1]?.trim();
  if (!city) return null;
  const index = await usCityIndex(agencyId).catch(() => null);
  if (!index) return null;
  const options = index.byName.get(city.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim()) ?? [];
  if (options.length === 1) return { code: options[0].code, name: options[0].name };
  return null;
}

/** The client's Search Console site as a bare domain, to pre-fill rank tracking setup. */
export async function searchConsoleDomain(clientId: string): Promise<string | null> {
  const site = await prisma.dataAsset.findFirst({ where: { clientId, kind: "GSC_SITE" }, select: { externalId: true } });
  if (!site) return null;
  return site.externalId.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || null;
}
