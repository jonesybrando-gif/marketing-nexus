import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildCityIndex, cityInQuery, marketCitiesFromPages, stateOfLocation } from "@/lib/rank-cities";
import { formatLocationName, readRankSettings, shortLocationName, type PendingRankTask, type RankTaskError } from "@/lib/rankings";
import { buildKeywordRankRows } from "@/server/metrics/rankings-rows";
import { buildRankSuggestions } from "@/server/metrics/rank-suggestions";
import { rankLocationMatches } from "../locations";
import { runRankSync, type ParsedRank, type RankKeyword, type RankStore } from "../core";

// Per-keyword locations for rank tracking: city detection, location search
// ranking, suggestions, the per-item sync payload, item operations and the
// data migration. The fixture is an extract of DataForSEO's live US list.

const US = JSON.parse(readFileSync(path.join(__dirname, "fixtures/us-locations.json"), "utf8")) as { location_code: number; location_name: string; location_type: string; country_iso_code: string }[];
const index = buildCityIndex(US.map((l) => ({ code: l.location_code, name: l.location_name, type: l.location_type })));
const code = (name: string) => US.find((l) => l.location_name === name)!.location_code;
const GALAXY_PAGES = [
  "https://galaxyparties.biz/dublin/",
  "https://galaxyparties.biz/mission-viejo-reptile-party",
  "https://galaxyparties.biz/locations/palo-alto",
  "https://galaxyparties.biz/simi-valley/",
  "https://galaxyparties.biz/temecula",
  "https://galaxyparties.biz/redwood-city-snow-party",
  "https://galaxyparties.biz/about",
];

describe("location names", () => {
  it("formats DataForSEO names and shortens US ones for tables", () => {
    expect(formatLocationName("Dublin,California,United States")).toBe("Dublin, California, United States");
    expect(shortLocationName("Dublin, California, United States")).toBe("Dublin, California");
    expect(shortLocationName("United States")).toBe("United States");
    expect(shortLocationName(null, 21137)).toBe("California");
    expect(stateOfLocation("Dublin, California, United States")).toBe("California");
    expect(stateOfLocation("United States")).toBeNull();
  });
  it("defaults new projects to mobile in the United States", () => {
    expect(readRankSettings(null)).toMatchObject({ locationCode: 2840, locationName: "United States", device: "mobile" });
    expect(readRankSettings({ device: "desktop", locationCode: 21137 })).toMatchObject({ device: "desktop", locationName: "California" });
  });
});

describe("city detection", () => {
  const markets = marketCitiesFromPages(GALAXY_PAGES, index, null);

  it("finds the cities a site's landing pages are about, settling Dublin by the other cities' state", () => {
    expect(markets.map((m) => m.name)).toEqual([
      "Dublin, California, United States",
      "Mission Viejo, California, United States",
      "Palo Alto, California, United States",
      "Redwood City, California, United States",
      "Simi Valley, California, United States",
      "Temecula, California, United States",
    ]);
  });

  it("names the city in a query, using market cities and explicit states", () => {
    expect(cityInQuery("reptile party dublin", index, { marketCities: markets })?.code).toBe(code("Dublin,California,United States"));
    expect(cityInQuery("dublin ohio reptile show", index, { marketCities: markets })?.code).toBe(code("Dublin,Ohio,United States"));
    expect(cityInQuery("reptile show dublin oh", index)?.code).toBe(code("Dublin,Ohio,United States"));
    expect(cityInQuery("party rentals palo alto", index, { marketCities: markets })?.code).toBe(code("Palo Alto,California,United States"));
    expect(cityInQuery("washington dc party", index)?.code).toBe(code("Washington,District of Columbia,United States"));
  });

  it("does not guess between same-named cities without a hint", () => {
    expect(cityInQuery("reptile party dublin", index)).toBeNull();
    expect(cityInQuery("reptile party dublin", index, { defaultState: "Ohio" })?.code).toBe(code("Dublin,Ohio,United States"));
  });

  it("ignores queries with no city, and a state name on its own", () => {
    for (const q of ["puppy petting zoo", "snow party rental near me", "galaxy parties", "washington state parks"]) expect(cityInQuery(q, index, { marketCities: markets })).toBeNull();
  });
});

describe("location search ranking", () => {
  const rows = US.map((l) => ({ code: l.location_code, name: l.location_name, type: l.location_type, countryIso: "US" }));
  it("puts the named city first, then other places", () => {
    const dub = rows.filter((r) => r.name.toLowerCase().includes("dublin"));
    const out = rankLocationMatches("dublin", dub, 3);
    expect(out[0].type).toBe("City");
    expect(out[0].name).toMatch(/^Dublin, /);
  });
  it("prefers an exact place over a longer match", () => {
    const out = rankLocationMatches("california", rows.filter((r) => r.name.toLowerCase().includes("california")), 1);
    expect(out[0]).toMatchObject({ name: "California, United States", type: "State" });
  });
});

describe("Search Console suggestions", () => {
  const def = { code: 2840, name: "United States" };
  it("suggests untracked queries, with the city they name as the location", () => {
    const { suggestions, marketCities } = buildRankSuggestions({
      queries: [
        { value: "galaxy parties", clicks: 40, impressions: 300, position: 1.2 },
        { value: "reptile party dublin", clicks: 12, impressions: 90, position: 4.1 },
        { value: "petting zoo temecula", clicks: 5, impressions: 70, position: 8 },
        { value: "Puppy Petting Zoo", clicks: 3, impressions: 50, position: 12 },
      ],
      pages: GALAXY_PAGES,
      tracked: new Set(["puppy petting zoo"]),
      index,
      defaultLocation: def,
    });
    expect(marketCities).toHaveLength(6);
    expect(suggestions.map((s) => [s.keyword, s.location.name, s.fromCity])).toEqual([
      ["galaxy parties", "United States", false],
      ["reptile party dublin", "Dublin, California, United States", true],
      ["petting zoo temecula", "Temecula, California, United States", true],
    ]);
  });
  it("works without the city list (default location only)", () => {
    const { suggestions } = buildRankSuggestions({ queries: [{ value: "reptile party dublin", clicks: 1, impressions: 1, position: null }], pages: [], tracked: new Set(), index: null, defaultLocation: def });
    expect(suggestions[0].location).toEqual(def);
  });
});

describe("rank rows", () => {
  it("carries the location name and paused state per item", () => {
    const rows = buildKeywordRankRows(
      [
        { id: "a", keyword: "reptile party", device: "mobile", locationCode: 1013740, locationName: "Dublin, California, United States", active: true },
        { id: "b", keyword: "reptile party", device: "mobile", locationCode: 1014327, locationName: "Temecula, California, United States", active: false },
      ],
      [{ keywordId: "a", date: "2026-11-25", position: 3, url: null, serpFeatures: [] }, { keywordId: "b", date: "2026-11-25", position: 9, url: null, serpFeatures: [] }],
      new Map(),
      { to: "2026-11-25", days: 7, changeDays: 7 },
    );
    expect(rows.map((r) => [r.keyword, r.locationName, r.position, r.paused])).toEqual([
      ["reptile party", "Dublin, California", 3, false],
      ["reptile party", "Temecula, California", 9, true],
    ]);
  });
});

class MemStore implements RankStore {
  ranks: ParsedRank[] = [];
  state?: { pendingTasks: PendingRankTask[]; taskErrors: RankTaskError[] };
  constructor(public keywords: RankKeyword[]) {}
  async activeKeywords() { return this.keywords; }
  async checkedKeywordIds() { return new Set<string>(); }
  async saveRanks(r: ParsedRank[]) { this.ranks.push(...r); }
  async ranksForDate() { return []; }
  async writeSummary() {}
  async saveState(s: { pendingTasks: PendingRankTask[]; taskErrors: RankTaskError[] }) { this.state = s; }
}

describe("daily check payload", () => {
  it("sends each item's own location code and device", async () => {
    const posted: { keyword: string; location_code: number; device: string; tag: string }[] = [];
    const f = (async (url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : [];
      if (String(url).endsWith("/serp/google/organic/task_post")) {
        posted.push(...body);
        return Response.json({ status_code: 20000, status_message: "Ok.", tasks: body.map((t: { tag: string }) => ({ id: `t-${t.tag}`, status_code: 20100, status_message: "Task Created.", data: t, result: null })) });
      }
      return Response.json({ status_code: 20000, status_message: "Ok.", tasks: [] });
    }) as typeof fetch;
    const store = new MemStore([
      { id: "dub-m", keyword: "reptile party", locationCode: 1013740, languageCode: "en", device: "mobile", targetDomain: "galaxyparties.biz" },
      { id: "tem-m", keyword: "reptile party", locationCode: 1014327, languageCode: "en", device: "mobile", targetDomain: "galaxyparties.biz" },
      { id: "us-d", keyword: "galaxy parties", locationCode: 2840, languageCode: "en", device: "desktop", targetDomain: "galaxyparties.biz" },
    ]);
    const out = await runRankSync({ secret: "login:pass", today: "2026-11-26", pendingTasks: [], store, fetch: f });
    expect(out.posted).toBe(3);
    expect(posted.map((p) => [p.tag, p.keyword, p.location_code, p.device])).toEqual([
      ["dub-m", "reptile party", 1013740, "mobile"],
      ["tem-m", "reptile party", 1014327, "mobile"],
      ["us-d", "galaxy parties", 2840, "desktop"],
    ]);
  });
});

// --- Database: item operations and the data migration -------------------------

const hasDb = !!process.env.DATABASE_URL;
const prisma = new PrismaClient();
const SLUG = "rank-locations-test";

describe.skipIf(!hasDb)("tracked items (database)", () => {
  let asset: { id: string; clientId: string; externalId: string };
  beforeAll(async () => {
    await prisma.agency.deleteMany({ where: { slug: SLUG } });
    const agency = await prisma.agency.create({ data: { name: "Rank", slug: SLUG } });
    const client = await prisma.client.create({ data: { agencyId: agency.id, name: "Galaxy Parties", timezone: "America/Los_Angeles" } });
    asset = await prisma.dataAsset.create({ data: { clientId: client.id, kind: "RANK_PROJECT", externalId: "galaxyparties.biz", name: "Rankings", settings: { locationCode: 2840, device: "mobile" } } });
  });
  afterAll(async () => {
    await prisma.agency.deleteMany({ where: { slug: SLUG } });
    await prisma.$disconnect();
  });

  it("tracks the same keyword in two locations, without duplicates", async () => {
    const { addTrackedItems } = await import("../projects");
    const dublin = { code: 1013740, name: "Dublin, California, United States" };
    const temecula = { code: 1014327, name: "Temecula, California, United States" };
    expect(await addTrackedItems(asset, ["reptile party", "puppy petting zoo"], dublin, ["mobile"])).toEqual({ added: 2, revived: 0, already: 0, skipped: 0 });
    expect(await addTrackedItems(asset, ["reptile party"], temecula, ["mobile"])).toEqual({ added: 1, revived: 0, already: 0, skipped: 0 });
    expect(await addTrackedItems(asset, ["reptile party"], dublin, ["mobile", "desktop"])).toEqual({ added: 1, revived: 0, already: 1, skipped: 0 });
    const rows = await prisma.trackedKeyword.findMany({ where: { assetId: asset.id }, orderBy: [{ keyword: "asc" }, { locationCode: "asc" }, { device: "asc" }] });
    expect(rows.map((r) => [r.keyword, r.locationName, r.device])).toEqual([
      ["puppy petting zoo", "Dublin, California, United States", "mobile"],
      ["reptile party", "Dublin, California, United States", "desktop"],
      ["reptile party", "Dublin, California, United States", "mobile"],
      ["reptile party", "Temecula, California, United States", "mobile"],
    ]);
    // The database refuses a second row for the same keyword, location and device.
    await expect(prisma.trackedKeyword.create({ data: { assetId: asset.id, clientId: asset.clientId, keyword: "reptile party", locationCode: 1013740, device: "mobile", targetDomain: "galaxyparties.biz" } })).rejects.toThrow();
  });

  it("changing location archives the old item with its history and creates the new one", async () => {
    const { moveTrackedItems, addTrackedItems } = await import("../projects");
    const puppy = await prisma.trackedKeyword.findFirstOrThrow({ where: { assetId: asset.id, keyword: "puppy petting zoo" } });
    await prisma.keywordRank.create({ data: { keywordId: puppy.id, date: new Date("2026-11-20"), position: 7 } });
    const r = await moveTrackedItems(asset, [puppy.id], { location: { code: 1014327, name: "Temecula, California, United States" } });
    expect(r).toMatchObject({ moved: 1, added: 1 });
    const old = await prisma.trackedKeyword.findUniqueOrThrow({ where: { id: puppy.id }, include: { ranks: true } });
    expect(old.active).toBe(false);
    expect(old.archivedAt).not.toBeNull();
    expect(old.ranks.map((x) => x.position)).toEqual([7]);
    expect(await prisma.trackedKeyword.count({ where: { assetId: asset.id, keyword: "puppy petting zoo", locationCode: 1014327, active: true } })).toBe(1);
    // Adding the old combination again revives it, history and all.
    expect(await addTrackedItems(asset, ["puppy petting zoo"], { code: 1013740, name: "Dublin, California, United States" }, ["mobile"])).toMatchObject({ revived: 1, added: 0 });
    expect(await prisma.keywordRank.count({ where: { keywordId: puppy.id } })).toBe(1);
  });

  it("pauses and resumes items; paused ones aren't checked", async () => {
    const { setItemsPaused, activeItemCount } = await import("../projects");
    const ids = (await prisma.trackedKeyword.findMany({ where: { assetId: asset.id, keyword: "reptile party" }, select: { id: true } })).map((x) => x.id);
    const before = await activeItemCount(asset.id);
    expect(await setItemsPaused(asset.id, ids, true)).toBe(3);
    expect(await activeItemCount(asset.id)).toBe(before - 3);
    expect(await setItemsPaused(asset.id, ids, false)).toBe(3);
    expect(await activeItemCount(asset.id)).toBe(before);
  });

  it("caches a country's locations once, and names items saved with only a code", async () => {
    const { ensureCountryLoaded } = await import("../locations");
    // A made-up country code keeps this away from any real cached list.
    const rows = US.map((l) => ({ ...l, location_code: l.location_code + 90_000_000, country_iso_code: "ZZ" }));
    let calls = 0;
    const f = (async (url: string | URL) => {
      calls++;
      expect(String(url)).toMatch(/\/serp\/google\/locations\/zz$/);
      return Response.json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: "x", status_code: 20000, status_message: "Ok.", result: rows }] });
    }) as typeof fetch;
    const nameless = await prisma.trackedKeyword.create({ data: { assetId: asset.id, clientId: asset.clientId, keyword: "snow party", locationCode: code("Temecula,California,United States") + 90_000_000, device: "mobile", targetDomain: "galaxyparties.biz" } });
    try {
      expect(await ensureCountryLoaded("unused", "ZZ", { secret: "login:pass", fetch: f })).toBe(rows.length);
      expect(await ensureCountryLoaded("unused", "ZZ", { secret: "login:pass", fetch: f })).toBe(rows.length); // fresh: not fetched again
      expect(calls).toBe(1);
      expect((await prisma.trackedKeyword.findUniqueOrThrow({ where: { id: nameless.id } })).locationName).toBe("Temecula, California, United States");
    } finally {
      await prisma.rankLocation.deleteMany({ where: { countryIso: "ZZ" } });
    }
  });

  it("the data migration archives switched-off rows, names known locations and keeps history", async () => {
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261126000000_rank_keyword_locations/migration.sql"), "utf8");
    const dataPart = sql.slice(sql.indexOf("-- Data:"));
    // Rows as they were before the migration: one project-wide location, older combinations switched off.
    const legacy = await prisma.dataAsset.create({ data: { clientId: asset.clientId, kind: "RANK_PROJECT", externalId: "legacy.example", name: "Legacy", settings: { locationCode: 1014221, device: "desktop" } } });
    const on = await prisma.trackedKeyword.create({ data: { assetId: legacy.id, clientId: asset.clientId, keyword: "dentist", locationCode: 1014221, device: "desktop", targetDomain: "legacy.example", active: true } });
    const off = await prisma.trackedKeyword.create({ data: { assetId: legacy.id, clientId: asset.clientId, keyword: "dentist", locationCode: 2840, device: "desktop", targetDomain: "legacy.example", active: false } });
    for (const [id, d, p] of [[on.id, "2026-10-01", 4], [on.id, "2026-10-02", 3], [off.id, "2026-09-01", 12]] as const) await prisma.keywordRank.create({ data: { keywordId: id, date: new Date(d), position: p } });

    for (const stmt of dataPart.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
      // Limit the migration's updates to this test's rows.
      await prisma.$executeRawUnsafe(stmt.replace(/WHERE /, `WHERE "assetId" = '${legacy.id}' AND `).replace(/WHERE "assetId" = '[^']+' AND t\./, `WHERE t."assetId" = '${legacy.id}' AND t.`));
    }
    const after = await prisma.trackedKeyword.findMany({ where: { assetId: legacy.id }, include: { _count: { select: { ranks: true } } }, orderBy: { locationCode: "asc" } });
    expect(after.map((r) => [r.locationCode, r.locationName, r.active, r.archivedAt !== null, r._count.ranks])).toEqual([
      [2840, "United States", false, true, 1],
      [1014221, "San Francisco, California, United States", true, false, 2],
    ]);
  });
});

// --- DataForSEO sandbox (free): run with DATAFORSEO_SANDBOX=1 -------------------

const sandbox = process.env.DATAFORSEO_SANDBOX === "1";
describe.skipIf(!sandbox)("DataForSEO sandbox: per-item location and device", () => {
  it("posts tasks that echo back each item's location_code and device", async () => {
    process.env.DATAFORSEO_API_BASE = "https://sandbox.dataforseo.com/v3";
    const { postSerpTasks } = await import("../api");
    // The session proxy injects the real login; the placeholder is replaced in the header.
    const tasks = await postSerpTasks("proxy-injected:x", [
      { keyword: "reptile party", location_code: 1013740, language_code: "en", device: "mobile", depth: 100, tag: "dub" },
      { keyword: "reptile party", location_code: 1014327, language_code: "en", device: "desktop", depth: 100, tag: "tem" },
    ]);
    expect(tasks.map((t) => [t.status_code, t.data?.tag, (t.data as Record<string, unknown>)?.location_code, (t.data as Record<string, unknown>)?.device])).toEqual([
      [20100, "dub", 1013740, "mobile"],
      [20100, "tem", 1014327, "desktop"],
    ]);
  });
});
