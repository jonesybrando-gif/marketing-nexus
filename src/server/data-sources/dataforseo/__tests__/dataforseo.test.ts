import { describe, expect, it } from "vitest";
import { domainMatches, normalizeDomain, parseKeywordList, rankCostEstimate, trackedItemCount, type PendingRankTask, type RankTaskError } from "@/lib/rankings";
import { METRIC_BY_KEY } from "@/lib/metrics-registry";
import { aggregateMetric } from "@/lib/metrics-registry/aggregate";
import { chunk, dueKeywords, parseSerpResult, runRankSync, summaryMetrics, type ParsedRank, type RankKeyword, type RankStore } from "../core";
import { getUserData } from "../api";
import type { MetricRow } from "../../types";
import { buildKeywordRankRows } from "@/server/metrics/rankings-rows";

const SECRET = "agency@example.com:s3cret-pass";

function kw(i: number, extra: Partial<RankKeyword> = {}): RankKeyword {
  return { id: `k${i}`, keyword: `keyword ${i}`, locationCode: 2840, languageCode: "en", device: "desktop", targetDomain: "example.com", ...extra };
}

class MemStore implements RankStore {
  ranks: ParsedRank[] = [];
  summaries: Record<string, MetricRow[]> = {};
  state?: { pendingTasks: PendingRankTask[]; taskErrors: RankTaskError[] };
  constructor(public keywords: RankKeyword[]) {}
  async activeKeywords() { return this.keywords; }
  async checkedKeywordIds(date: string) { return new Set(this.ranks.filter((r) => r.date === date).map((r) => r.keywordId)); }
  async saveRanks(r: ParsedRank[]) { this.ranks.push(...r); }
  async ranksForDate(date: string) { return this.ranks.filter((r) => r.date === date); }
  async writeSummary(date: string, rows: MetricRow[]) { this.summaries[date] = rows; }
  async saveState(s: { pendingTasks: PendingRankTask[]; taskErrors: RankTaskError[] }) { this.state = s; }
}

type Call = { method: string; path: string; body?: unknown; auth: string | null };

/** Fake DataForSEO API. task_post creates ids "t-<tag>"; results come from `serps`. */
function fakeApi(opts: { serps?: Record<string, unknown>; ready?: string[]; postStatus?: (tag: string) => number; topLevel?: number } = {}) {
  const calls: Call[] = [];
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const f = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.dataforseo.com/v3", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body, auth: new Headers(init?.headers).get("authorization") });
    if (opts.topLevel) return json({ status_code: opts.topLevel, status_message: "insufficient funds.", tasks: [] });
    if (path === "/appendix/user_data") return json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: "u", status_code: 20000, status_message: "Ok.", result: [{ login: "agency@example.com", money: { balance: 42.5 } }] }] });
    if (path === "/serp/google/organic/task_post") {
      return json({
        status_code: 20000, status_message: "Ok.",
        tasks: (body as { tag: string; keyword: string }[]).map((t) => {
          const code = opts.postStatus?.(t.tag) ?? 20100;
          return { id: `t-${t.tag}`, status_code: code, status_message: code === 20100 ? "Task Created." : "bad", data: { tag: t.tag, keyword: t.keyword }, result: null };
        }),
      });
    }
    if (path === "/serp/google/organic/tasks_ready") return json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: "r", status_code: 20000, status_message: "Ok.", result: (opts.ready ?? []).map((id) => ({ id })) }] });
    const m = path.match(/^\/serp\/google\/organic\/task_get\/regular\/(.+)$/);
    if (m) {
      const serp = opts.serps?.[m[1]];
      if (!serp) return json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: m[1], status_code: 40602, status_message: "Task In Queue.", result: null }] });
      return json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: m[1], status_code: 20000, status_message: "Ok.", result: [serp] }] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

const serp = (items: { type: string; domain?: string; url?: string; rank_group?: number }[], itemTypes?: string[]) => ({ keyword: "x", item_types: itemTypes ?? [...new Set(items.map((i) => i.type))], items });

describe("domain matching", () => {
  it("normalizes domains and URL forms", () => {
    expect(normalizeDomain("https://WWW.Example.com/path?q=1")).toBe("example.com");
    expect(normalizeDomain("example.com:8080/x")).toBe("example.com");
    expect(normalizeDomain("//www2.example.com")).toBe("example.com");
    expect(normalizeDomain("not a domain")).toBe("");
  });
  it("matches www, subdomains and URLs, but not look-alikes", () => {
    expect(domainMatches("www.example.com", "example.com")).toBe(true);
    expect(domainMatches("example.com", "https://www.example.com/")).toBe(true);
    expect(domainMatches("blog.example.com", "example.com")).toBe(true);
    expect(domainMatches("https://shop.eu.example.com/a/b", "www.example.com")).toBe(true);
    expect(domainMatches("notexample.com", "example.com")).toBe(false);
    expect(domainMatches("example.com.evil.net", "example.com")).toBe(false);
    expect(domainMatches("example.co", "example.com")).toBe(false);
    // A subdomain target does not match the parent domain.
    expect(domainMatches("example.com", "blog.example.com")).toBe(false);
  });
});

describe("SERP parsing", () => {
  it("takes the first organic result on the target domain and lists features", () => {
    const r = parseSerpResult(serp([
      { type: "paid", domain: "www.example.com", url: "https://www.example.com/ad" },
      { type: "local_pack", domain: "example.com" },
      { type: "organic", domain: "competitor.com", url: "https://competitor.com/", rank_group: 1 },
      { type: "people_also_ask" },
      { type: "organic", domain: "blog.example.com", url: "https://blog.example.com/post", rank_group: 2 },
      { type: "organic", domain: "www.example.com", url: "https://www.example.com/", rank_group: 3 },
    ]), "example.com");
    expect(r).toEqual({ position: 2, url: "https://blog.example.com/post", serpFeatures: ["local_pack", "organic", "paid", "people_also_ask"] });
  });
  it("returns null position when not in the results", () => {
    expect(parseSerpResult(serp([{ type: "organic", domain: "other.com", rank_group: 1 }]), "example.com").position).toBeNull();
    expect(parseSerpResult({ items: null }, "example.com")).toEqual({ position: null, url: null, serpFeatures: [] });
  });
  it("falls back to the URL when the domain field is missing", () => {
    expect(parseSerpResult(serp([{ type: "organic", url: "https://www.example.com/x", rank_group: 7 }]), "example.com").position).toBe(7);
  });
});

describe("helpers", () => {
  it("chunks into batches of 100", () => {
    expect(chunk(Array.from({ length: 250 }, (_, i) => i), 100).map((c) => c.length)).toEqual([100, 100, 50]);
  });
  it("parses pasted keyword lists", () => {
    expect(parseKeywordList(" Dentist  Near Me \n\ndentist near me\r\nemergency dentist, invisalign ")).toEqual(["dentist near me", "emergency dentist", "invisalign"]);
  });
  it("estimates cost per tracked item at the configured price", () => {
    expect(rankCostEstimate(trackedItemCount(100, "both"))).toEqual({ checksPerDay: 200, perDay: 200 * 0.0006, perMonth: 200 * 0.0006 * 30 });
    expect(rankCostEstimate(10, 0.001).perMonth).toBeCloseTo(0.3);
  });
  it("skips keywords already checked today or pending today", () => {
    const ks = [kw(1), kw(2), kw(3)];
    const pending: PendingRankTask[] = [{ id: "t", keywordId: "k2", date: "2026-10-23", postedAt: "" }, { id: "y", keywordId: "k3", date: "2026-10-22", postedAt: "" }];
    expect(dueKeywords(ks, new Set(["k1"]), pending, "2026-10-23").map((k) => k.id)).toEqual(["k3"]);
  });
});

describe("summary metrics", () => {
  it("counts top buckets and stores sums for a weighted average", () => {
    const rows = summaryMetrics("2026-10-23", [{ position: 1 }, { position: 5 }, { position: 15 }, { position: 60 }, { position: null }], 6);
    const v = Object.fromEntries(rows.map((r) => [r.metric, r.value]));
    expect(v).toEqual({ "rank.tracked": 6, "rank.rankedCount": 4, "rank.positionSum": 81, "rank.top3": 1, "rank.top10": 2, "rank.top20": 3, "rank.top100": 4, "rank.avgPosition": 20.25 });
    for (const r of rows) expect(METRIC_BY_KEY[r.metric]).toBeDefined();
  });
  it("omits the average when nothing ranks", () => {
    expect(summaryMetrics("2026-10-23", [{ position: null }], 1).some((r) => r.metric === "rank.avgPosition")).toBe(false);
  });
  it("averages over a range by summed positions / ranked count", () => {
    const by = {
      "rank.positionSum": [{ date: "a", value: 10 }, { date: "b", value: 30 }],
      "rank.rankedCount": [{ date: "a", value: 2 }, { date: "b", value: 3 }],
    };
    expect(aggregateMetric("rank.avgPosition", [], by)).toBe(8);
  });
});

describe("runRankSync", () => {
  const today = "2026-10-23";
  const now = new Date("2026-10-23T15:00:00Z");

  it("posts due keywords in batches of up to 100 with basic auth, depth 100 and the keyword settings", async () => {
    const store = new MemStore(Array.from({ length: 205 }, (_, i) => kw(i, i % 2 ? { device: "mobile", locationCode: 21137 } : {})));
    const { f, calls } = fakeApi();
    const out = await runRankSync({ secret: SECRET, today, pendingTasks: [], store, now, fetch: f });
    const posts = calls.filter((c) => c.path.endsWith("task_post"));
    expect(posts.map((p) => (p.body as unknown[]).length)).toEqual([100, 100, 5]);
    expect(posts[0].auth).toBe(`Basic ${Buffer.from(SECRET).toString("base64")}`);
    expect((posts[0].body as unknown[])[1]).toEqual({ keyword: "keyword 1", location_code: 21137, language_code: "en", device: "mobile", depth: 100, tag: "k1" });
    expect(out).toMatchObject({ posted: 205, pending: 205, collected: 0 });
    expect(store.state!.pendingTasks[0]).toEqual({ id: "t-k0", keywordId: "k0", date: today, postedAt: now.toISOString() });
    // No pending tasks yet, so tasks_ready isn't called.
    expect(calls.some((c) => c.path.endsWith("tasks_ready"))).toBe(false);
  });

  it("collects ready tasks, writes ranks and summaries, keeps unready ones, and skips keywords checked today", async () => {
    const store = new MemStore([kw(1), kw(2), kw(3)]);
    const pending: PendingRankTask[] = [
      { id: "t-k1", keywordId: "k1", date: today, postedAt: "2026-10-23T14:30:00Z" },
      { id: "t-k2", keywordId: "k2", date: today, postedAt: "2026-10-23T14:30:00Z" },
      { id: "t-k3", keywordId: "k3", date: today, postedAt: "2026-10-23T14:30:00Z" },
    ];
    const { f, calls } = fakeApi({
      ready: ["t-k1", "t-k2", "other-asset-task"],
      serps: {
        "t-k1": serp([{ type: "featured_snippet" }, { type: "organic", domain: "www.example.com", url: "https://www.example.com/a", rank_group: 4 }]),
        "t-k2": serp([{ type: "organic", domain: "other.com", rank_group: 1 }]),
      },
    });
    const out = await runRankSync({ secret: SECRET, today, pendingTasks: pending, store, now, fetch: f });
    expect(out).toMatchObject({ collected: 2, posted: 0, pending: 1 });
    expect(store.ranks).toEqual([
      { keywordId: "k1", date: today, position: 4, url: "https://www.example.com/a", serpFeatures: ["featured_snippet", "organic"] },
      { keywordId: "k2", date: today, position: null, url: null, serpFeatures: ["organic"] },
    ]);
    // Only our ready tasks are fetched; k3 is pending so nothing new is posted.
    expect(calls.filter((c) => c.path.includes("task_get")).map((c) => c.path)).toEqual(["/serp/google/organic/task_get/regular/t-k1", "/serp/google/organic/task_get/regular/t-k2"]);
    expect(calls.some((c) => c.path.endsWith("task_post"))).toBe(false);
    expect(store.state!.pendingTasks.map((p) => p.id)).toEqual(["t-k3"]);
    const v = Object.fromEntries(store.summaries[today].map((r) => [r.metric, r.value]));
    expect(v).toMatchObject({ "rank.tracked": 3, "rank.rankedCount": 1, "rank.avgPosition": 4, "rank.top10": 1, "rank.top3": 0 });

    // Next run, same day: k1/k2 are done, k3 still pending → no posts.
    const again = fakeApi({ ready: [] });
    await runRankSync({ secret: SECRET, today, pendingTasks: store.state!.pendingTasks, store, now, fetch: again.f });
    expect(again.calls.some((c) => c.path.endsWith("task_post"))).toBe(false);

    // Next day: all three are due again (k3's stale pending task is from yesterday).
    const tomorrow = fakeApi({ ready: [] });
    const out2 = await runRankSync({ secret: SECRET, today: "2026-10-24", pendingTasks: store.state!.pendingTasks, store, now: new Date("2026-10-24T15:00:00Z"), fetch: tomorrow.f });
    expect(out2.posted).toBe(3);
  });

  it("records per-task errors and keeps going", async () => {
    const store = new MemStore([kw(1), kw(2)]);
    const { f } = fakeApi({ postStatus: (tag) => (tag === "k1" ? 40501 : 20100) });
    const out = await runRankSync({ secret: SECRET, today, pendingTasks: [], store, now, fetch: f });
    expect(out.posted).toBe(1);
    expect(out.errors).toEqual([{ keyword: "keyword 1", message: "DataForSEO error 40501: bad", at: now.toISOString() }]);
    expect(store.state!.taskErrors).toHaveLength(1);
    expect(out.fatal).toBeUndefined();
  });

  it("stops on insufficient balance and still saves state", async () => {
    const store = new MemStore(Array.from({ length: 150 }, (_, i) => kw(i)));
    const { f, calls } = fakeApi({ postStatus: () => 40210 });
    const out = await runRankSync({ secret: SECRET, today, pendingTasks: [], store, now, fetch: f });
    expect(out.fatal).toMatch(/balance is too low/);
    expect(calls.filter((c) => c.path.endsWith("task_post"))).toHaveLength(1); // stopped after the first batch
    expect(store.state).toEqual({ pendingTasks: [], taskErrors: [] });

    const top = fakeApi({ topLevel: 40200 });
    const out2 = await runRankSync({ secret: SECRET, today, pendingTasks: [], store, now, fetch: top.f });
    expect(out2.fatal).toMatch(/balance is too low/);
  });

  it("drops pending tasks for removed keywords and very old tasks", async () => {
    const store = new MemStore([kw(1)]);
    const { f } = fakeApi({ ready: [] });
    await runRankSync({
      secret: SECRET, today, store, now, fetch: f,
      pendingTasks: [
        { id: "gone", keywordId: "deleted", date: today, postedAt: now.toISOString() },
        { id: "old", keywordId: "k1", date: "2026-10-18", postedAt: "2026-10-18T10:00:00Z" },
      ],
    });
    expect(store.state!.pendingTasks.map((p) => p.id)).toEqual(["t-k1"]);
  });
});

describe("user_data", () => {
  it("returns login and balance, and never puts the password in errors", async () => {
    const { f } = fakeApi();
    expect(await getUserData(SECRET, f)).toEqual({ login: "agency@example.com", balance: 42.5 });
    const bad = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(getUserData(SECRET, bad)).rejects.toThrow(/rejected/);
    await getUserData(SECRET, bad).catch((e: Error) => expect(e.message).not.toContain("s3cret"));
  });
});

describe("keyword rank table rows", () => {
  it("computes latest position, changes, best and history", () => {
    const pts = [
      { keywordId: "a", date: "2026-09-23", position: 20, url: null, serpFeatures: [] },
      { keywordId: "a", date: "2026-10-16", position: 8, url: null, serpFeatures: [] },
      { keywordId: "a", date: "2026-10-23", position: 5, url: "https://x.com/", serpFeatures: ["organic", "local_pack"] },
      { keywordId: "b", date: "2026-10-16", position: null, url: null, serpFeatures: [] },
      { keywordId: "b", date: "2026-10-23", position: 30, url: null, serpFeatures: [] },
    ];
    const rows = buildKeywordRankRows(
      [{ id: "b", keyword: "beta", device: "desktop", locationCode: 2840 }, { id: "a", keyword: "alpha", device: "mobile", locationCode: 2840 }, { id: "c", keyword: "gamma", device: "desktop", locationCode: 2840 }],
      pts, new Map([["a", 3], ["b", 30]]), { to: "2026-10-23", days: 30, changeDays: 7 },
    );
    expect(rows.map((r) => r.keyword)).toEqual(["alpha", "beta", "gamma"]);
    expect(rows[0]).toMatchObject({ position: 5, change: -3, change7: -3, change30: -15, best: 3, url: "https://x.com/", serpFeatures: ["organic", "local_pack"], device: "mobile" });
    expect(rows[0].history).toHaveLength(30);
    expect(rows[0].history.at(-1)).toEqual({ date: "2026-10-23", position: 5 });
    expect(rows[1]).toMatchObject({ position: 30, change7: null, newlyRanked: true });
    expect(rows[2]).toMatchObject({ position: null, checkedOn: null });
  });
});
