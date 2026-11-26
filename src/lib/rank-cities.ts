// Finds US city names in search queries and landing-page URLs, for rank
// tracking suggestions ("reptile party dublin" → Dublin, California). Pure: the
// city list (DataForSEO "City" locations) is passed in, so it is unit-tested.

import { US_STATES } from "./rankings";

export interface CityLocation {
  code: number;
  /** City name as DataForSEO writes it, e.g. "Mission Viejo". */
  city: string;
  /** Full state name, e.g. "California". */
  state: string;
  /** Display name, e.g. "Mission Viejo, California, United States". */
  name: string;
}

export interface CityIndex {
  /** Lowercased city name → every US city with that name. */
  byName: Map<string, CityLocation[]>;
  /** Longest city name in words, bounds the n-gram search. */
  maxWords: number;
}

const STATE_BY_ABBR = new Map(Object.entries(US_STATES).map(([a, n]) => [a.toLowerCase(), n]));
const STATE_BY_NAME = new Map(Object.values(US_STATES).map((n) => [n.toLowerCase(), n]));

/** Words, lowercased, with punctuation and URL separators turned into spaces. */
export function words(text: string): string[] {
  return (text ?? "").toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}

/** Builds the index from DataForSEO locations ("Dublin,California,United States", type City). */
export function buildCityIndex(locations: { code: number; name: string; type: string }[]): CityIndex {
  const byName = new Map<string, CityLocation[]>();
  let maxWords = 1;
  for (const l of locations) {
    if (l.type !== "City") continue;
    const parts = l.name.split(",").map((p) => p.trim());
    if (parts.length < 3 || parts[parts.length - 1] !== "United States") continue;
    const [city, state] = parts;
    const key = words(city).join(" ");
    if (!key) continue;
    const list = byName.get(key) ?? [];
    list.push({ code: l.code, city, state, name: parts.join(", ") });
    byName.set(key, list);
    maxWords = Math.max(maxWords, key.split(" ").length);
  }
  return { byName, maxWords: Math.min(maxWords, 5) };
}

/** State named right after position `i` in `ws` ("dublin ca", "dublin california"), if any. */
function stateAfter(ws: string[], i: number): string | null {
  const one = ws[i];
  if (one && STATE_BY_ABBR.has(one)) return STATE_BY_ABBR.get(one)!;
  for (let n = 3; n >= 1; n--) {
    const phrase = ws.slice(i, i + n).join(" ");
    if (STATE_BY_NAME.has(phrase)) return STATE_BY_NAME.get(phrase)!;
  }
  return null;
}

interface Hit {
  key: string;
  start: number;
  end: number;
  /** State written next to the city in the text. */
  state: string | null;
}

/** City-name mentions in `ws`, longest names first, non-overlapping. */
function findMentions(ws: string[], index: CityIndex): Hit[] {
  const taken = new Set<number>();
  const hits: Hit[] = [];
  for (let n = index.maxWords; n >= 1; n--) {
    for (let i = 0; i + n <= ws.length; i++) {
      if ([...Array(n).keys()].some((k) => taken.has(i + k))) continue;
      const key = ws.slice(i, i + n).join(" ");
      if (!index.byName.has(key)) continue;
      // A state name on its own ("washington", "nevada") is not a city mention.
      if (n === 1 && STATE_BY_NAME.has(key) && !stateAfter(ws, i + 1)) continue;
      for (let k = 0; k < n; k++) taken.add(i + k);
      hits.push({ key, start: i, end: i + n, state: stateAfter(ws, i + n) });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

export interface CityHints {
  /** State of the client's default location (e.g. "California"), if it is a state or a city. */
  defaultState?: string | null;
  /** Cities the client's landing pages are about (their "markets"). */
  marketCities?: CityLocation[];
}

/**
 * Picks one city for a mention, or null when it can't be told apart safely:
 * a state written next to it wins, then a market city of that name, then one in
 * the hinted states; otherwise only a multi-word name that is unique in the US.
 * One-word names that are also everyday words ("party", "magic") need a hint.
 */
function resolve(hit: Hit, index: CityIndex, states: string[], markets: CityLocation[]): CityLocation | null {
  const options = index.byName.get(hit.key) ?? [];
  if (hit.state) return options.find((o) => o.state === hit.state) ?? null;
  const market = markets.find((m) => words(m.city).join(" ") === hit.key);
  if (market) return market;
  for (const st of states) {
    const inState = options.filter((o) => o.state === st);
    if (inState.length === 1) return inState[0];
  }
  if (options.length === 1 && hit.key.includes(" ")) return options[0];
  return null;
}

/** The city a search query names, using the hints to tell same-named cities apart. */
export function cityInQuery(query: string, index: CityIndex, hints: CityHints = {}): CityLocation | null {
  const ws = words(query);
  const markets = hints.marketCities ?? [];
  const states = statePreference(hints);
  for (const hit of findMentions(ws, index)) {
    const c = resolve(hit, index, states, markets);
    if (c) return c;
  }
  return null;
}

/** Hinted states, most likely first: the default location's, then the market cities' (most common first). */
function statePreference(hints: CityHints): string[] {
  const out: string[] = [];
  if (hints.defaultState) out.push(hints.defaultState);
  const counts = new Map<string, number>();
  for (const m of hints.marketCities ?? []) counts.set(m.state, (counts.get(m.state) ?? 0) + 1);
  for (const [st] of [...counts].sort((a, b) => b[1] - a[1])) if (!out.includes(st)) out.push(st);
  return out;
}

/**
 * Cities the client's landing pages are about, from their URL paths
 * ("/dublin-ca/reptile-party", "/locations/mission-viejo"). Cities that are
 * unambiguous (or have a state next to them) are settled first; their states
 * then decide the ambiguous ones (a site with Temecula and Palo Alto pages
 * means its "dublin" page is Dublin, California).
 */
export function marketCitiesFromPages(pageUrls: string[], index: CityIndex, defaultState?: string | null): CityLocation[] {
  const paths = pageUrls.map((u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  });
  const mentions: Hit[] = [];
  for (const p of paths) mentions.push(...findMentions(words(p), index));
  const found = new Map<number, CityLocation>();
  const pending: Hit[] = [];
  for (const h of mentions) {
    const options = index.byName.get(h.key) ?? [];
    const sure = h.state ? options.find((o) => o.state === h.state) : options.length === 1 && h.key.includes(" ") ? options[0] : null;
    if (sure) found.set(sure.code, sure);
    else pending.push(h);
  }
  const states = statePreference({ defaultState, marketCities: [...found.values()] });
  for (const h of pending) {
    const c = resolve(h, index, states, []);
    if (c) found.set(c.code, c);
  }
  return [...found.values()].sort((a, b) => a.city.localeCompare(b.city));
}

/** State part of a DataForSEO location name when it is a US state or a city/ZIP in one. */
export function stateOfLocation(name: string | null | undefined): string | null {
  const parts = (name ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.at(-1) !== "United States") return null;
  for (const p of parts.slice(0, -1).reverse()) if (STATE_BY_NAME.has(p.toLowerCase())) return STATE_BY_NAME.get(p.toLowerCase())!;
  return null;
}
