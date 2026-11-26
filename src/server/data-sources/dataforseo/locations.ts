import "server-only";
import { prisma } from "../../db";
import { readSecret } from "../credentials";
import { agencyDataForSeoConnection } from "./account";
import { getSerpLocations, type FetchLike } from "./api";
import { buildCityIndex, type CityIndex } from "@/lib/rank-cities";
import { COMMON_LOCATIONS, formatLocationName, LOCATION_COUNTRIES, US_STATES, type RankLocationOption } from "@/lib/rankings";

// DataForSEO's Google locations, cached per country in RankLocation for the
// rank tracking location search. The list is free to fetch; the US alone is
// ~63k rows, so countries are loaded on first use and refreshed monthly.

const REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const INSERT_CHUNK = 5000;
const loading = new Map<string, Promise<number>>();

/** Search results rank by type: places people search "near" first. */
const TYPE_ORDER = ["City", "Neighborhood", "County", "DMA Region", "State", "Postal Code", "Municipality", "Borough", "City Region", "Region", "Country"];
const typeRank = (t: string) => {
  const i = TYPE_ORDER.indexOf(t);
  return i < 0 ? TYPE_ORDER.length : i;
};

export const isSupportedCountry = (iso: string) => LOCATION_COUNTRIES.some((c) => c.iso === iso);

/** Rows cached for a country, loading them from DataForSEO when missing or older than a month. Returns the row count. */
export async function ensureCountryLoaded(agencyId: string, countryIso: string, opts: { fetch?: FetchLike; secret?: string } = {}): Promise<number> {
  const iso = countryIso.toUpperCase();
  const newest = await prisma.rankLocation.findFirst({ where: { countryIso: iso }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } });
  const count = newest ? await prisma.rankLocation.count({ where: { countryIso: iso } }) : 0;
  if (newest && Date.now() - newest.updatedAt.getTime() < REFRESH_AFTER_MS) return count;
  let secret = opts.secret;
  if (!secret) {
    const c = await agencyDataForSeoConnection(agencyId);
    secret = c && c.status === "ACTIVE" ? readSecret(c) ?? undefined : undefined;
  }
  if (!secret) return count; // not connected: search falls back to the built-in list
  const key = iso;
  const running = loading.get(key);
  if (running) return running;
  const job = (async () => {
    const rows = (await getSerpLocations(secret!, iso, opts.fetch)).filter((l) => l.country_iso_code?.toUpperCase() === iso);
    if (!rows.length) return count;
    const data = rows.map((l) => ({ code: l.location_code, name: l.location_name, type: l.location_type || "", countryIso: iso, parentCode: l.location_code_parent ?? null }));
    await prisma.$transaction(async (tx) => {
      await tx.rankLocation.deleteMany({ where: { countryIso: iso } });
      for (let i = 0; i < data.length; i += INSERT_CHUNK) await tx.rankLocation.createMany({ data: data.slice(i, i + INSERT_CHUNK), skipDuplicates: true });
    }, { timeout: 120_000 });
    cityIndexCache.delete(iso);
    // Items saved before their name was known (older keywords, typed codes) get it now.
    await prisma.$executeRaw`UPDATE "TrackedKeyword" t SET "locationName" = array_to_string(string_to_array(l.name, ','), ', ')
      FROM "RankLocation" l WHERE l.code = t."locationCode" AND l."countryIso" = ${iso} AND t."locationName" IS NULL`;
    return data.length;
  })().finally(() => loading.delete(key));
  loading.set(key, job);
  return job;
}

/** Orders candidates: exact place name first, then names starting with the query, then by type and shortness. Pure; exported for tests. */
export function rankLocationMatches(q: string, rows: { code: number; name: string; type: string; countryIso: string }[], limit = 20): RankLocationOption[] {
  const query = q.trim().toLowerCase();
  const first = query.split(/[ ,]+/)[0] ?? "";
  const score = (r: { name: string; type: string }) => {
    const place = r.name.split(",")[0].trim().toLowerCase();
    const head = place === query || place === query.split(",")[0].trim() ? 0 : place.startsWith(first) ? 1 : 2;
    return head * 100 + typeRank(r.type);
  };
  return [...rows]
    .sort((a, b) => score(a) - score(b) || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((r) => ({ code: r.code, name: formatLocationName(r.name), type: r.type, countryIso: r.countryIso }));
}

/** Built-in fallback list (no DataForSEO connection or list not loaded yet). */
function commonMatches(q: string, limit: number): RankLocationOption[] {
  const tokens = q.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const all = COMMON_LOCATIONS.flatMap((g) => g.items.map((i) => ({
    code: i.code,
    name: i.code === 2840 ? "United States" : `${i.name}, United States`,
    type: g.group === "Country" ? "Country" : g.group === "States" ? "State" : "City",
    countryIso: "US",
  })));
  return all.filter((l) => tokens.every((t) => l.name.toLowerCase().includes(t))).slice(0, limit);
}

/**
 * Type-ahead search over a country's locations: every word must appear in the
 * name ("dublin ca" matches "Dublin,California,…"); a number matches a ZIP or
 * a location code.
 */
export async function searchLocations(agencyId: string, q: string, countryIso = "US", limit = 20): Promise<RankLocationOption[]> {
  const query = q.trim().slice(0, 80);
  if (query.length < 2) return [];
  const iso = isSupportedCountry(countryIso.toUpperCase()) ? countryIso.toUpperCase() : "US";
  let loaded = 0;
  try {
    loaded = await ensureCountryLoaded(agencyId, iso);
  } catch {
    loaded = await prisma.rankLocation.count({ where: { countryIso: iso } });
  }
  if (!loaded) return iso === "US" ? commonMatches(query, limit) : [];
  if (/^\d{3,9}$/.test(query)) {
    const rows = await prisma.rankLocation.findMany({
      where: { OR: [{ code: Number(query) }, { countryIso: iso, name: { startsWith: query } }] },
      take: limit,
      orderBy: { name: "asc" },
    });
    return rows.map((r) => ({ code: r.code, name: formatLocationName(r.name), type: r.type, countryIso: r.countryIso }));
  }
  // "Dublin, CA" → words; a two-letter US state code matches the state's full name.
  const tokens = query.toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, 5);
  const rows = await prisma.rankLocation.findMany({
    where: {
      countryIso: iso,
      AND: tokens.map((t) => {
        const state = iso === "US" && t.length === 2 ? US_STATES[t.toUpperCase()] : undefined;
        return state
          ? { OR: [{ name: { contains: t, mode: "insensitive" as const } }, { name: { contains: `,${state},`, mode: "insensitive" as const } }] }
          : { name: { contains: t, mode: "insensitive" as const } };
      }),
    },
    take: 400,
  });
  return rankLocationMatches(query, rows, limit);
}

/** One location by code from the cache (or the built-in list). */
export async function findLocation(code: number): Promise<RankLocationOption | null> {
  const r = await prisma.rankLocation.findUnique({ where: { code } });
  if (r) return { code: r.code, name: formatLocationName(r.name), type: r.type, countryIso: r.countryIso };
  const c = commonMatches("", 200).find((x) => x.code === code);
  return c ?? null;
}

const cityIndexCache = new Map<string, { at: number; index: CityIndex }>();

/** US cities for query/landing-page city detection (cached in memory for an hour). Null when the US list isn't loaded. */
export async function usCityIndex(agencyId: string): Promise<CityIndex | null> {
  const hit = cityIndexCache.get("US");
  if (hit && Date.now() - hit.at < 3_600_000) return hit.index;
  try {
    await ensureCountryLoaded(agencyId, "US");
  } catch {
    // use whatever is cached
  }
  const rows = await prisma.rankLocation.findMany({ where: { countryIso: "US", type: "City" }, select: { code: true, name: true, type: true } });
  if (!rows.length) return null;
  const index = buildCityIndex(rows);
  cityIndexCache.set("US", { at: Date.now(), index });
  return index;
}
