import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { analyseCrawl, failedToLoad, ISSUES, pageIssueKeys, type DfsPage } from "@/lib/site-audit/issues";
import { healthScore, issueCost, scoreBand } from "@/lib/site-audit/score";
import { isSystemUrl, matchesIgnore, parseIgnorePatterns } from "@/lib/site-audit/urls";
import { changed, diffIssues, summarizeDiff } from "@/lib/site-audit/diff";
import { checkCostCap, DEFAULT_ONPAGE_RATES, estimateAuditCost, lighthouseUrlCount } from "@/lib/site-audit/cost";
import { nextAuditRun } from "@/lib/site-audit/schedule";
import { classifyError, collectCrawl, crawlProgress, lighthouseFailure, normalizeTargetUrl, runLighthouse, startCrawl, stopCrawl } from "../engine";
import { DataForSeoError } from "../../data-sources/dataforseo/api";
import { issueRows } from "../queries";

// Site Auditor: issue mapping (every check against a sandbox page), health
// score, diff, cost and cap, schedule, the crawl engine against recorded
// sandbox responses, the database flow, and (DATAFORSEO_SANDBOX=1) the live
// sandbox end to end.

const fx = (n: string) => JSON.parse(readFileSync(path.join(__dirname, "fixtures", `${n}.json`), "utf8"));
const PAGES: DfsPage[] = fx("pages").tasks[0].result[0].items;
const SUMMARY = fx("summary").tasks[0].result[0];
/** A sandbox page with every check cleared: the base for one-issue variants. */
const clean = (): DfsPage => {
  const p = structuredClone(PAGES[0]);
  for (const k of Object.keys(p.checks ?? {})) p.checks![k] = false;
  p.checks!.is_https = true;
  p.broken_links = p.broken_resources = p.duplicate_title = p.duplicate_description = false;
  p.click_depth = 1;
  p.url = "https://dataforseo.com/apis";
  p.url_length = p.url.length;
  p.status_code = 200;
  p.page_timing = { duration_time: 500 };
  p.meta!.htags = { h1: ["One heading"] };
  p.meta!.content = { plain_text_word_count: 900 };
  p.meta!.internal_links_count = 40;
  p.meta!.external_links_count = 5;
  p.meta!.social_media_tags = { "og:title": "x" };
  return p;
};

/** How to trigger each page-level issue on a clean sandbox page. */
const TRIGGER: Record<string, (p: DfsPage) => void> = {
  http_4xx: (p) => { p.status_code = 404; p.checks!.is_4xx_code = true; },
  http_5xx: (p) => { p.status_code = 503; p.checks!.is_5xx_code = true; },
  broken_internal_links: (p) => { p.broken_links = true; },
  broken_resources: (p) => { p.broken_resources = true; },
  non_https: (p) => { p.url = "http://dataforseo.com/apis"; p.checks!.is_http = true; p.checks!.is_https = false; },
  mixed_content: (p) => { p.checks!.https_to_http_links = true; },
  duplicate_title: (p) => { p.duplicate_title = true; },
  missing_title: (p) => { p.checks!.no_title = true; p.meta!.title = ""; },
  missing_description: (p) => { p.checks!.no_description = true; },
  duplicate_description: (p) => { p.duplicate_description = true; },
  title_too_long: (p) => { p.checks!.title_too_long = true; },
  title_too_short: (p) => { p.checks!.title_too_short = true; },
  missing_h1: (p) => { p.checks!.no_h1_tag = true; p.meta!.htags = { h1: [] }; },
  multiple_h1: (p) => { p.meta!.htags = { h1: ["One", "Two"] }; },
  redirect_chain: (p) => { p.checks!.redirect_chain = true; },
  low_word_count: (p) => { p.meta!.content = { plain_text_word_count: 120 }; },
  slow_page: (p) => { p.checks!.high_loading_time = true; },
  large_page: (p) => { p.checks!.large_page_size = true; },
  image_missing_alt: (p) => { p.checks!.no_image_alt = true; },
  canonical_issue: (p) => { p.checks!.canonical_to_redirect = true; },
  orphan_page: (p) => { p.checks!.is_orphan_page = true; },
  long_url: (p) => { p.url = `https://dataforseo.com/${"very-long-path-segment-".repeat(6)}`; p.url_length = p.url.length; },
  too_many_links: (p) => { p.meta!.internal_links_count = 300; },
  deep_page: (p) => { p.click_depth = 5; },
  missing_og: (p) => { p.meta!.social_media_tags = {}; },
};

describe("issue mapping (sandbox pages)", () => {
  it("a cleaned sandbox page has no issues", () => {
    expect(pageIssueKeys(clean())).toEqual([]);
  });
  for (const d of ISSUES.filter((x) => x.scope === "page")) {
    it(`detects ${d.key} (${d.severity}, ${d.category})`, () => {
      const p = clean();
      TRIGGER[d.key](p);
      expect(pageIssueKeys(p)).toContain(d.key);
    });
  }
  it("covers every page-level issue with a trigger", () => {
    expect(ISSUES.filter((d) => d.scope === "page").map((d) => d.key).sort()).toEqual(Object.keys(TRIGGER).sort());
  });

  it("counts on the sandbox crawl match DataForSEO's own summary checks", () => {
    const f = analyseCrawl(PAGES, { domainChecks: SUMMARY.domain_info.checks }, "dataforseo.com");
    const count = (k: string) => f.issues.find((i) => i.key === k)?.count ?? 0;
    const c = SUMMARY.page_metrics.checks;
    expect(f.pages).toBe(SUMMARY.domain_info.total_pages);
    expect(count("image_missing_alt")).toBe(c.no_image_alt);
    expect(count("title_too_short")).toBe(c.title_too_short);
    expect(count("missing_description")).toBe(c.no_description);
    expect(count("mixed_content")).toBe(c.https_to_http_links);
    expect(count("missing_h1")).toBe(c.no_h1_tag);
    expect(count("http_4xx")).toBe(c.is_4xx_code);
    expect(f.issues.find((i) => i.key === "no_sitemap")).toBeUndefined(); // the sandbox site has a sitemap
  });

  it("site-wide checks: sitemap, robots, redirect loops, blocked pages and broken link targets", () => {
    const links = fx("links_broken").tasks[0].result[0].items;
    const f = analyseCrawl([clean()], {
      domainChecks: { sitemap: false, robots_txt: true },
      redirectChains: [{ is_redirect_loop: true, chain: [{ from_url: "https://dataforseo.com/a", to_url: "https://dataforseo.com/b" }] }],
      nonIndexable: [...fx("non_indexable").tasks[0].result[0].items, { url: "https://dataforseo.com/private", reason: "meta_tag" }, { url: "https://dataforseo.com/x", reason: "canonical" }],
      links: [...links, { link_from: "https://dataforseo.com/", link_to: "https://dataforseo.com/gone", direction: "internal", is_broken: true }],
    }, "dataforseo.com");
    const by = Object.fromEntries(f.issues.map((i) => [i.key, i]));
    expect(by.no_sitemap).toMatchObject({ severity: "warning", count: 1 });
    expect(by.redirect_loop).toMatchObject({ severity: "error", sampleUrls: ["https://dataforseo.com/a"] });
    // Only this site's blocked pages; other hosts (the sandbox lists ebay.com) and canonicalised pages are ignored.
    expect(by.blocked_but_linked).toMatchObject({ count: 1, sampleUrls: ["https://dataforseo.com/private"] });
  });

  it("keeps pages with errors or warnings for the page list and caps samples at 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => { const p = clean(); p.url = `https://dataforseo.com/p${i}`; TRIGGER.missing_description(p); return p; });
    const f = analyseCrawl([...many, clean()], {}, "dataforseo.com");
    expect(f.issues[0]).toMatchObject({ key: "missing_description", count: 30 });
    expect(f.issues[0].sampleUrls).toHaveLength(20);
    expect(f.pageRows).toHaveLength(30);
  });
});

describe("health score", () => {
  const e = (key: string, count: number) => ({ key, severity: "error" as const, count });
  const w = (key: string, count: number) => ({ key, severity: "warning" as const, count });
  const n = (key: string, count: number) => ({ key, severity: "notice" as const, count });
  it("costs each kind of issue by severity and share of pages: weight × (0.25 + 0.75 × share)", () => {
    expect(healthScore({ pages: 100, issues: [] })).toBe(100);
    expect(issueCost(e("http_4xx", 1), 100)).toBeCloseTo(10 * (0.25 + 0.75 * 0.01));
    expect(healthScore({ pages: 100, issues: [e("http_4xx", 1)] })).toBe(97); // 100 − 2.575
    expect(healthScore({ pages: 100, issues: [w("missing_description", 50), n("missing_og", 100)] })).toBe(97); // 100 − 2.5 − 1 = 96.5
    expect(healthScore({ pages: 0, issues: [] })).toBeNull();
  });
  it("one issue on every page costs at most its weight, never the whole score", () => {
    // The Galaxy Parties case: one footer link broken on all 498 pages.
    expect(healthScore({ pages: 498, issues: [e("broken_internal_links", 498)] })).toBe(90);
    expect(healthScore({ pages: 498, issues: [e("broken_internal_links", 498), w("blocked_but_linked", 1000)] })).toBe(86);
  });
  it("only many different serious problems reach 0", () => {
    const keys = ["http_4xx", "http_5xx", "broken_internal_links", "broken_resources", "non_https", "mixed_content", "duplicate_title", "missing_title", "redirect_loop", "blocked_but_linked", "slow_page"];
    expect(healthScore({ pages: 10, issues: keys.map((k) => e(k, 10)) })).toBe(0);
  });
  it("site-wide yes/no checks count as affecting every page", () => {
    expect(issueCost(w("no_sitemap", 1), 500)).toBe(4);
    expect(issueCost(w("blocked_but_linked", 5), 500)).toBeCloseTo(4 * (0.25 + 0.75 * 0.01));
  });
  it("scores the sandbox crawl from its own findings", () => {
    const f = analyseCrawl(PAGES, { domainChecks: SUMMARY.domain_info.checks }, "dataforseo.com");
    expect(healthScore({ pages: f.pages, issues: f.issues })).toBe(Math.round(100 - f.issues.reduce((s, i) => s + issueCost(i, f.pages), 0)));
  });
  it("bands", () => {
    expect(scoreBand(92).tone).toBe("good");
    expect(scoreBand(60).tone).toBe("warning");
    expect(scoreBand(40).tone).toBe("critical");
  });
});

describe("excluded URLs and ignore patterns", () => {
  it("knows CDN and system paths", () => {
    expect(isSystemUrl("https://galaxyparties.biz/cdn-cgi/l/email-protection#a1b2")).toBe(true);
    expect(isSystemUrl("/wp-json/wp/v2/posts")).toBe(true);
    expect(isSystemUrl("https://galaxyparties.biz/contact")).toBe(false);
  });
  it("parses patterns and matches path and query, * for anything", () => {
    const { patterns, errors } = parseIgnorePatterns("/book?*\n\n# comment\nhttps://galaxyparties.biz/cart*\nthank-you");
    expect(errors).toEqual([]);
    expect(patterns).toEqual(["/book?*", "/cart*", "/thank-you"]);
    expect(matchesIgnore("https://galaxyparties.biz/book?city=Austin&state=TX", patterns)).toBe(true);
    expect(matchesIgnore("https://galaxyparties.biz/book", patterns)).toBe(false); // needs the "?"
    expect(matchesIgnore("https://galaxyparties.biz/booking", patterns)).toBe(false);
    expect(matchesIgnore("https://galaxyparties.biz/cart/checkout", patterns)).toBe(true);
    expect(matchesIgnore("https://galaxyparties.biz/THANK-YOU", patterns)).toBe(true);
    expect(parseIgnorePatterns(Array.from({ length: 60 }, (_, i) => `/p${i}`).join("\n")).errors).toHaveLength(1);
  });
});

/** The Galaxy Parties crawl in miniature: every page links to Cloudflare's email protection, booking links are noindexed on purpose. */
function galaxyCrawl() {
  const pages = Array.from({ length: 6 }, (_, i) => {
    const p = clean();
    p.url = `https://galaxyparties.biz/${i ? `party-${i}` : ""}`;
    p.broken_links = true; // DataForSEO's flag: the email-protection link "broke" on every page
    p.broken_resources = true;
    return p;
  });
  pages.push(Object.assign(clean(), { url: "https://galaxyparties.biz/cdn-cgi/l/email-protection", status_code: 403, checks: { ...clean().checks, is_4xx_code: true } }));
  const links = pages.slice(0, 6).map((p) => ({ link_from: p.url, link_to: "https://galaxyparties.biz/cdn-cgi/l/email-protection#ab12", direction: "internal", is_broken: true }));
  const nonIndexable = Array.from({ length: 20 }, (_, i) => ({ url: `https://galaxyparties.biz/book?city=City${i}&state=TX`, reason: "meta_tag" }));
  return { pages, links, nonIndexable };
}

describe("false positives (Galaxy Parties)", () => {
  it("leaves out Cloudflare email-protection links, its resources and its pages", () => {
    const g = galaxyCrawl();
    const f = analyseCrawl(g.pages, { links: g.links, linksComplete: true, brokenResources: [{ url: "https://galaxyparties.biz/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js" }], resourcePages: {}, nonIndexable: [] }, "galaxyparties.biz");
    expect(f.pages).toBe(6); // the /cdn-cgi/ page itself isn't a site page
    expect(f.issues.map((i) => i.key)).toEqual([]);
  });
  it("still counts a real broken link, only on the page that has it, with the target as the sample", () => {
    const g = galaxyCrawl();
    g.links.push({ link_from: "https://galaxyparties.biz/party-2", link_to: "https://galaxyparties.biz/old-page", direction: "internal", is_broken: true });
    const f = analyseCrawl(g.pages, { links: g.links, linksComplete: true }, "galaxyparties.biz");
    expect(f.issues.find((i) => i.key === "broken_internal_links")).toMatchObject({ count: 1, sampleUrls: ["https://galaxyparties.biz/old-page"] });
  });
  it("attributes a real broken resource to the pages that use it", () => {
    const g = galaxyCrawl();
    const img = "https://galaxyparties.biz/img/missing.jpg";
    const f = analyseCrawl(g.pages, { links: g.links, linksComplete: true, brokenResources: [{ url: img }], resourcePages: { [img]: ["https://galaxyparties.biz/party-3"] } }, "galaxyparties.biz");
    expect(f.issues.find((i) => i.key === "broken_resources")).toMatchObject({ count: 1, sampleUrls: ["https://galaxyparties.biz/party-3"] });
  });
  it("trusts DataForSEO's page flag when it couldn't list every broken link", () => {
    const g = galaxyCrawl();
    const p = Object.assign(clean(), { url: "https://galaxyparties.biz/unknown", broken_links: true });
    const f = analyseCrawl([...g.pages, p], { links: g.links, linksComplete: false }, "galaxyparties.biz");
    expect(f.issues.find((i) => i.key === "broken_internal_links")?.sampleUrls).toEqual(["https://galaxyparties.biz/unknown"]);
  });
  it("blocked booking links are a warning, and none with the client's ignore pattern", () => {
    const g = galaxyCrawl();
    const without = analyseCrawl(g.pages, { links: g.links, linksComplete: true, nonIndexable: g.nonIndexable }, "galaxyparties.biz");
    expect(without.issues.find((i) => i.key === "blocked_but_linked")).toMatchObject({ severity: "warning", count: 20 });
    const withIgnore = analyseCrawl(g.pages, { links: g.links, linksComplete: true, nonIndexable: g.nonIndexable }, "galaxyparties.biz", { ignore: ["/book?*"] });
    expect(withIgnore.issues.find((i) => i.key === "blocked_but_linked")).toBeUndefined();
  });
  it("ignore patterns also leave matching pages out of the page count", () => {
    const g = galaxyCrawl();
    const f = analyseCrawl(g.pages, { links: g.links, linksComplete: true }, "galaxyparties.biz", { ignore: ["/party-*"] });
    expect(f.pages).toBe(1);
  });
});

describe("broken resources (Galaxy Parties crawl)", () => {
  // Real on_page/resources records: the main stylesheet loads (200) but DataForSEO marks it broken for CSS parse warnings.
  const RES: { url: string; status_code: number }[] = fx("galaxy_resources").tasks[0].result[0].items;
  const main = RES.find((r) => r.url.endsWith("index-DYweEDFD.css"))!.url;
  const missing = RES.find((r) => r.status_code === 404)!.url;
  const site = () => {
    const pages = Array.from({ length: 5 }, (_, i) => Object.assign(clean(), { url: `https://galaxyparties.biz/p${i}`, broken_resources: true }));
    return { pages, brokenResources: RES.map((r) => ({ url: r.url, status: r.status_code })) };
  };
  it("counts only resources that failed to load, not ones with parse warnings", () => {
    expect(failedToLoad(200)).toBe(false);
    expect(failedToLoad(404)).toBe(true);
    expect(failedToLoad(null)).toBe(true); // no response
    const { pages, brokenResources } = site();
    const f = analyseCrawl(pages, { brokenResources, resourcePages: { [missing]: ["https://galaxyparties.biz/p3"], [main]: pages.map((p) => p.url) }, resourcePageCounts: { [missing]: 1, [main]: 496 } }, "galaxyparties.biz");
    const issue = f.issues.find((i) => i.key === "broken_resources")!;
    expect(issue).toMatchObject({ count: 1, targets: [{ url: missing, status: 404, pages: 1 }] });
    expect(f.errorPages).toBe(1);
  });
  it("leaves out resources on system paths even when they fail", () => {
    const { pages } = site();
    const f = analyseCrawl(pages, { brokenResources: [{ url: "https://galaxyparties.biz/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js", status: 403 }], resourcePages: {} }, "galaxyparties.biz");
    expect(f.issues.find((i) => i.key === "broken_resources")).toBeUndefined();
  });
  it("lists broken link targets with the pages linking to them", () => {
    const g = galaxyCrawl();
    g.links.push({ link_from: "https://galaxyparties.biz/party-1", link_to: "https://galaxyparties.biz/gone", direction: "internal", is_broken: true }, { link_from: "https://galaxyparties.biz/party-2", link_to: "https://galaxyparties.biz/gone", direction: "internal", is_broken: true });
    const f = analyseCrawl(g.pages, { links: g.links, linksComplete: true }, "galaxyparties.biz");
    expect(f.issues.find((i) => i.key === "broken_internal_links")?.targets).toEqual([{ url: "https://galaxyparties.biz/gone", status: null, pages: 2 }]);
  });
  it("the engine looks up pages only for resources that failed to load, and counts them all", async () => {
    const looked: string[] = [];
    const base = sandboxReplay().f;
    const f = (async (url: string | URL, init?: RequestInit) => {
      const p = String(url).replace(/^https:\/\/[^/]+\/v3/, "");
      if (p === "/on_page/resources") return Response.json(fx("galaxy_resources"));
      if (p === "/on_page/pages_by_resource") {
        const body = JSON.parse(String(init?.body))[0];
        looked.push(body.url);
        return Response.json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: "x", status_code: 20000, status_message: "Ok.", cost: 0, result: [{ total_items_count: 1, items: [{ url: "https://dataforseo.com/" }] }] }] });
      }
      return base(url, init);
    }) as typeof fetch;
    const { findings } = await collectCrawl("login:pass", "t", { targetUrl: "https://dataforseo.com", maxPages: 50, domainChecks: null }, f);
    expect(looked).toEqual([missing]);
    expect(findings.issues.find((i) => i.key === "broken_resources")?.targets).toEqual([{ url: missing, status: 404, pages: 1 }]);
  });
});

describe("Lighthouse failures", () => {
  it("explains a 403 from a site behind Cloudflare, retries once, and isn't charged", async () => {
    let calls = 0;
    const f = (async () => { calls++; return Response.json(fx("lighthouse_403")); }) as unknown as typeof fetch;
    const r = await runLighthouse("login:pass", ["https://galaxyparties.biz/"], f, { server: "cloudflare", retryDelayMs: 0 });
    expect(calls).toBe(2);
    expect(r.cost).toBe(0);
    expect(r.rows[0]).toMatchObject({ performance: null, errorCode: "ERRORED_DOCUMENT_REQUEST" });
    expect(r.rows[0].error).toMatch(/refused the speed test \(HTTP 403\).*Cloudflare/);
  });
  it("keeps the second attempt when the retry works", async () => {
    let calls = 0;
    const f = (async () => Response.json(++calls === 1 ? fx("lighthouse_403") : fx("lighthouse"))) as unknown as typeof fetch;
    const r = await runLighthouse("login:pass", ["https://dataforseo.com/"], f, { retryDelayMs: 0 });
    expect(calls).toBe(2);
    expect(r.rows[0]).toMatchObject({ performance: 82 });
    expect(r.rows[0].error).toBeUndefined();
  });
  it("words other failures plainly", () => {
    expect(lighthouseFailure({ code: "X", message: "Something (Status code: 500)" }, "", null)).toBe("The page returned HTTP 500 to the speed test.");
    expect(lighthouseFailure({ code: "NO_FCP" }, "", null)).toMatch(/didn't show any content/);
    expect(lighthouseFailure(null, "DataForSEO error 50000: Internal Error.", null)).toBe("DataForSEO error 50000: Internal Error.");
  });
});

describe("diff vs the previous crawl", () => {
  it("marks new, fixed, worse, better and unchanged issues", () => {
    const d = diffIssues(
      [{ key: "missing_title", count: 3 }, { key: "slow_page", count: 40 }, { key: "image_missing_alt", count: 20 }, { key: "long_url", count: 11 }],
      [{ key: "slow_page", count: 30 }, { key: "image_missing_alt", count: 26 }, { key: "long_url", count: 12 }, { key: "http_4xx", count: 4 }],
    );
    expect(Object.fromEntries(d.map((c) => [c.key, c.kind]))).toEqual({ missing_title: "new", slow_page: "worse", image_missing_alt: "better", long_url: "same", http_4xx: "fixed" });
    expect(summarizeDiff(d)).toEqual({ new: 1, fixed: 1, worse: 1, better: 1, same: 1 });
  });
  it("counts a change at 10% or 5 pages", () => {
    expect(changed(100, 109)).toBe(true); // 9 pages ≥ 5
    expect(changed(200, 204)).toBe(false); // 2%, 4 pages
    expect(changed(20, 22)).toBe(true); // 10%
    expect(changed(3, 3)).toBe(false);
  });
  it("calls nothing new on a first crawl", () => {
    expect(diffIssues([{ key: "x", count: 2 }], null)).toEqual([{ key: "x", kind: "same", count: 2, previous: null }]);
  });
  it("issue rows put errors first and fixed issues after open ones", () => {
    const rows = issueRows([{ issueKey: "image_missing_alt", count: 9, sampleUrls: [] }, { issueKey: "missing_title", count: 1, sampleUrls: ["https://a.test/"] }], [{ issueKey: "http_4xx", count: 2 }, { issueKey: "image_missing_alt", count: 9 }]);
    expect(rows.map((r) => [r.key, r.change])).toEqual([["missing_title", "new"], ["http_4xx", "fixed"], ["image_missing_alt", "same"]]);
  });
});

describe("cost estimate and monthly cap", () => {
  it("prices pages by options and adds Lighthouse tests", () => {
    expect(estimateAuditCost({ maxPages: 500, enableJs: false, lighthouseUrls: 1 })).toBeCloseTo(500 * 0.00015 * 3 + 0.005, 6);
    expect(estimateAuditCost({ maxPages: 500, enableJs: false, loadResources: false, lighthouseUrls: 0 })).toBeCloseTo(0.075, 6);
    expect(estimateAuditCost({ maxPages: 50, enableJs: true, lighthouseUrls: 6 })).toBeCloseTo(50 * 0.00015 * 10 + 6 * 0.005, 6);
    expect(estimateAuditCost({ maxPages: 100, enableJs: false, lighthouseUrls: 0 }, { ...DEFAULT_ONPAGE_RATES, basicPerPage: 0.0002 })).toBeCloseTo(100 * 0.0002 * 3, 6);
    expect(lighthouseUrlCount("top_pages")).toBe(6);
  });
  it("charges only the pages crawled (DataForSEO refunds the rest of the up-front charge)", async () => {
    const { crawlCharge } = await import("../jobs");
    expect(crawlCharge(0.0225, 50, 3)).toBeCloseTo(0.00135, 6); // the live marketingnexus.us crawl
    expect(crawlCharge(0.0225, 50, 80)).toBeCloseTo(0.0225, 6);
  });
  it("blocks a crawl that would go over the cap and says why", () => {
    expect(checkCostCap(24, 0.755, 25)).toMatchObject({ allowed: true });
    const no = checkCostCap(24.5, 0.755, 25);
    expect(no.allowed).toBe(false);
    expect(no.reason).toMatch(/over the agency cap of \$25\.00/);
  });
});

describe("schedule", () => {
  it("runs weekly and monthly at 4:00 in the client's time zone; manual never", () => {
    const after = new Date("2026-11-26T12:00:00Z"); // a Thursday
    expect(nextAuditRun({ schedule: "weekly", dayOfWeek: 1, dayOfMonth: null }, "America/Los_Angeles", after)?.toISOString()).toBe("2026-11-30T12:00:00.000Z");
    expect(nextAuditRun({ schedule: "monthly", dayOfWeek: null, dayOfMonth: 1 }, "America/New_York", after)?.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(nextAuditRun({ schedule: "manual", dayOfWeek: 1, dayOfMonth: null }, "UTC", after)).toBeNull();
  });
});

describe("engine helpers", () => {
  it("normalises the website address", () => {
    expect(normalizeTargetUrl("Example.com/page?x=1")).toBe("https://example.com");
    expect(normalizeTargetUrl("http://www.example.com")).toBe("http://www.example.com");
    expect(normalizeTargetUrl("not a site")).toBeNull();
  });
  it("classifies DataForSEO errors like the data source contract", () => {
    expect(classifyError(new DataForSeoError("x", 401)).code).toBe("bad_credentials");
    expect(classifyError(new DataForSeoError("x", 40210)).code).toBe("insufficient_balance");
    expect(classifyError(new DataForSeoError("x", 40202)).code).toBe("rate_limit");
    expect(classifyError(new DataForSeoError("DataForSEO error 40501: Invalid Field: 'target'.", 40501)).code).toBe("invalid_target");
    expect(classifyError(new Error("socket hang up")).code).toBe("provider_error");
  });
});

/** Replays recorded sandbox responses (task_post, summary, pages, lists, lighthouse). */
function sandboxReplay() {
  const calls: { path: string; body?: unknown }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const p = String(url).replace(/^https:\/\/[^/]+\/v3/, "");
    calls.push({ path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (p === "/on_page/task_post") return Response.json(fx("task_post"));
    if (p.startsWith("/on_page/summary/")) return Response.json(fx("summary"));
    if (p === "/on_page/pages") return Response.json(fx("pages"));
    if (p === "/on_page/non_indexable") return Response.json(fx("non_indexable"));
    if (p === "/on_page/redirect_chains") return Response.json(fx("redirect_chains"));
    if (p === "/on_page/links") return Response.json(fx("links_broken"));
    if (p === "/on_page/lighthouse/live/json") return Response.json(fx("lighthouse"));
    if (p === "/on_page/resources" || p === "/on_page/pages_by_resource") return Response.json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: "r", status_code: 20000, status_message: "Ok.", cost: 0, result: [{ items: [] }] }] });
    if (p === "/on_page/force_stop") return Response.json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: "s", status_code: 20100, status_message: "Task Created.", cost: 0, result: null }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

describe("crawl engine (recorded sandbox responses)", () => {
  it("starts with our options, reads progress, collects and analyses, runs Lighthouse", async () => {
    const { f, calls } = sandboxReplay();
    const started = await startCrawl("login:pass", { targetUrl: "https://dataforseo.com", maxPages: 50, enableJs: false, auditId: "a1" }, f);
    expect(started.taskId).toBe(fx("task_post").tasks[0].id);
    expect(calls[0].body).toEqual([{ target: "dataforseo.com", start_url: "https://dataforseo.com/", max_crawl_pages: 50, load_resources: true, enable_javascript: false, calculate_keyword_density: false, tag: "a1" }]);
    const p = await crawlProgress("login:pass", started.taskId, f);
    expect(p).toMatchObject({ finished: true, pagesCrawled: 10, onpageScore: SUMMARY.page_metrics.onpage_score });
    const { findings } = await collectCrawl("login:pass", started.taskId, { targetUrl: "https://dataforseo.com", maxPages: 50, domainChecks: p.domainChecks }, f);
    expect(findings.pages).toBe(10);
    expect(findings.issues.length).toBeGreaterThan(3);
    const lh = await runLighthouse("login:pass", ["https://dataforseo.com/"], f);
    expect(lh.rows[0]).toMatchObject({ url: "https://dataforseo.com/", performance: 82 });
    expect(lh.rows[0].lcpMs).toBeGreaterThan(0);
  });
});

// --- Database flow ----------------------------------------------------------------

const hasDb = !!process.env.DATABASE_URL;
const prisma = new PrismaClient();
const SLUG = "site-audit-test";

describe.skipIf(!hasDb)("site audit jobs (database, recorded sandbox responses)", () => {
  let agencyId = "", clientId = "";
  beforeAll(async () => {
    await prisma.agency.deleteMany({ where: { slug: SLUG } });
    const agency = await prisma.agency.create({ data: { name: "Audit", slug: SLUG, siteAuditMonthlyCapUsd: 1 } });
    agencyId = agency.id;
    const user = await prisma.user.create({ data: { agencyId, email: `${SLUG}@example.test`, name: "A", role: "AGENCY_ADMIN", passwordHash: "x" } });
    const conn = await prisma.dataSourceConnection.create({ data: { agencyId, provider: "DATAFORSEO", label: "login", externalId: "login", createdById: user.id } });
    const { storeDataSourceSecret } = await import("../../data-sources/credentials");
    await storeDataSourceSecret(conn.id, "login:pass");
    clientId = (await prisma.client.create({ data: { agencyId, name: "Audit Client", timezone: "UTC" } })).id;
    await prisma.siteAuditConfig.create({ data: { clientId, targetUrl: "https://dataforseo.com", maxPages: 50, schedule: "weekly", dayOfWeek: 1, lighthouse: "homepage", nextRunAt: new Date("2026-11-23T04:00:00Z") } });
  });
  afterAll(async () => {
    await prisma.agency.deleteMany({ where: { slug: SLUG } });
    await prisma.$disconnect();
  });

  it("scheduler starts the due crawl once, poller completes it with score, issues, Lighthouse and costs", async () => {
    const { scheduleDueAudits, pollActiveAudits, startAudit } = await import("../jobs");
    const { f } = sandboxReplay();
    const now = new Date("2026-11-23T05:00:00Z");
    expect(await scheduleDueAudits({ fetch: f, now })).toEqual({ started: 1, skipped: 0 });
    expect(await scheduleDueAudits({ fetch: f, now })).toEqual({ started: 0, skipped: 0 }); // already claimed: next run moved on
    expect((await prisma.siteAuditConfig.findUniqueOrThrow({ where: { clientId } })).nextRunAt?.toISOString()).toBe("2026-11-30T04:00:00.000Z");
    await expect(startAudit(clientId, "manual", { fetch: f, now })).rejects.toMatchObject({ code: "already_running" });

    expect(await pollActiveAudits({ fetch: f, now: new Date("2026-11-23T05:10:00Z") })).toMatchObject({ checked: 1, completed: 1, failed: 0 });
    const a = await prisma.siteAudit.findFirstOrThrow({ where: { clientId }, include: { issues: true, pages: true } });
    expect(a).toMatchObject({ status: "completed", pagesCrawled: 10, onpageScore: SUMMARY.page_metrics.onpage_score });
    expect(a.healthScore).toBeGreaterThanOrEqual(0);
    expect(a.issues.length).toBeGreaterThan(3);
    expect(a.pages.length).toBeGreaterThan(0);
    expect((a.lighthouse as { performance: number }[])[0].performance).toBe(82);
    expect(a.estimatedCost).toBeCloseTo(50 * 0.00015 * 3 + 0.005, 6);
    expect(a.aiSummaryError).toMatch(/isn't set up/); // no API key in tests: recorded, not fatal
  });

  it("writes the AI summary from the crawl data, and records a failure without failing the audit", async () => {
    const { summarizeAudit } = await import("../jobs");
    const { setAiClientForTests } = await import("../../ai/assistant");
    const audit = await prisma.siteAudit.findFirstOrThrow({ where: { clientId, status: "completed" } });
    let sent = "";
    const reply = { overview: "Score 72.", fixes: [{ title: "Add titles", why: "1 page has none." }], regressions: [] };
    setAiClientForTests({ beta: { messages: { parse: async (req: { messages: { content: string }[] }) => { sent = req.messages[0].content; return { stop_reason: "end_turn", parsed_output: reply }; } } } } as never);
    try {
      await summarizeAudit(audit.id);
      expect(sent).toContain(`Health score (ours, 0–100, higher is better): ${audit.healthScore}`);
      expect(sent).toMatch(/Issues \(severity \| issue/);
      expect(sent).toContain("Page speed (Lighthouse");
      expect((await prisma.siteAudit.findUniqueOrThrow({ where: { id: audit.id } })).aiSummary).toEqual(reply);
      setAiClientForTests({ beta: { messages: { parse: async () => { throw new Error("boom"); } } } } as never);
      await summarizeAudit(audit.id);
      const after = await prisma.siteAudit.findUniqueOrThrow({ where: { id: audit.id } });
      expect(after.status).toBe("completed");
      expect(after.aiSummaryError).toBe("boom");
    } finally {
      setAiClientForTests(null);
    }
  });

  it("re-checks a finished crawl from DataForSEO for free with the client's ignore patterns", async () => {
    const { reanalyzeAudit, ANALYSIS_VERSION } = await import("../jobs");
    const { f, calls } = sandboxReplay();
    const audit = await prisma.siteAudit.findFirstOrThrow({ where: { clientId, status: "completed" } });
    await prisma.siteAudit.update({ where: { id: audit.id }, data: { analysisVersion: 1, healthScore: 0 } });
    // Leave out every sandbox page but the homepage.
    await prisma.siteAuditConfig.update({ where: { clientId }, data: { ignorePatterns: ["/?*", "/*?*", "/a*", "/b*", "/c*", "/d*", "/e*", "/f*", "/g*", "/h*", "/i*", "/j*", "/k*", "/l*", "/m*", "/n*", "/o*", "/p*", "/q*", "/r*", "/s*", "/t*", "/u*", "/v*", "/w*", "/x*", "/y*", "/z*"] } });
    const r = await reanalyzeAudit(audit.id, { fetch: f });
    expect(r.mode).toBe("refetched");
    expect(calls.some((c) => c.path === "/on_page/task_post")).toBe(false); // no new crawl
    expect(calls.some((c) => c.path === "/on_page/lighthouse/live/json")).toBe(false); // no new speed test
    const after = await prisma.siteAudit.findUniqueOrThrow({ where: { id: audit.id } });
    expect(after).toMatchObject({ analysisVersion: ANALYSIS_VERSION, pagesCrawled: 1, ignorePatterns: expect.arrayContaining(["/a*"]) });
    expect(after.healthScore).toBeGreaterThan(0);
    await prisma.siteAuditConfig.update({ where: { clientId }, data: { ignorePatterns: [] } });
  });

  it("falls back to re-scoring the stored counts when DataForSEO no longer has the crawl", async () => {
    const { reanalyzeAudit } = await import("../jobs");
    const gone = (async () => Response.json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: "x", status_code: 40400, status_message: "Not Found.", result: null }] })) as unknown as typeof fetch;
    const audit = await prisma.siteAudit.create({
      data: { clientId, status: "completed", providerTaskId: "expired", targetUrl: "https://galaxyparties.biz", maxPages: 500, pagesCrawled: 498, healthScore: 0, finishedAt: new Date("2026-11-25T10:00:00Z"), createdAt: new Date("2026-11-25T09:00:00Z"),
        issues: { create: [{ issueKey: "broken_internal_links", severity: "error", category: "links", count: 498 }, { issueKey: "blocked_but_linked", severity: "error", category: "crawlability", count: 1000 }] },
        errorPages: 498, pages: { create: [{ url: "https://galaxyparties.biz/a", issueKeys: ["broken_internal_links"] }, { url: "https://galaxyparties.biz/b", issueKeys: ["title_too_short"] }] } },
    });
    const r = await reanalyzeAudit(audit.id, { fetch: gone });
    expect(r).toEqual({ mode: "stored", before: 0, after: 86, speedRetried: 0 });
    // Page counts re-derived from the stored pages with current severities.
    expect(await prisma.siteAudit.findUniqueOrThrow({ where: { id: audit.id } })).toMatchObject({ errorPages: 1, warningPages: 1 });
    const issue = await prisma.siteAuditIssue.findFirstOrThrow({ where: { auditId: audit.id, issueKey: "blocked_but_linked" } });
    expect(issue.severity).toBe("warning"); // re-graded with the current catalogue
    await prisma.siteAudit.delete({ where: { id: audit.id } });
  });

  it("a re-check re-runs only the failed speed tests and stores the real reason (failed tests aren't charged)", async () => {
    const { reanalyzeAudit } = await import("../jobs");
    const tested: string[] = [];
    const base = sandboxReplay().f;
    const f = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/on_page/lighthouse/live/json")) { tested.push(JSON.parse(String(init?.body))[0].url); return Response.json(fx("lighthouse_403")); }
      return base(url, init);
    }) as typeof fetch;
    const audit = await prisma.siteAudit.create({
      data: { clientId, status: "completed", providerTaskId: "t-old", targetUrl: "https://galaxyparties.biz", maxPages: 500, pagesCrawled: 10, healthScore: 0, serverSoftware: "cloudflare", actualCost: 0.2, finishedAt: new Date("2026-11-25T10:00:00Z"), createdAt: new Date("2026-11-25T09:00:00Z"),
        lighthouse: [{ url: "https://galaxyparties.biz/", performance: null, lcpMs: null, cls: null, tbtMs: null, error: "DataForSEO error 50301: Lighthouse encountered an error with the following code: ERRORED_DOCUMENT_REQUEST" }, { url: "https://galaxyparties.biz/party", performance: 70, lcpMs: 2000, cls: 0, tbtMs: 100 }] },
    });
    const r = await reanalyzeAudit(audit.id, { fetch: f, retryDelayMs: 0 });
    expect(r.speedRetried).toBe(1);
    expect(tested).toEqual(["https://galaxyparties.biz/", "https://galaxyparties.biz/"]); // the failed one only, retried once
    const after = await prisma.siteAudit.findUniqueOrThrow({ where: { id: audit.id } });
    const rows = after.lighthouse as { url: string; error?: string; performance: number | null }[];
    expect(rows[0].error).toMatch(/refused the speed test \(HTTP 403\).*Cloudflare/);
    expect(rows[1].performance).toBe(70);
    expect(after.actualCost).toBe(0.2);
    await prisma.siteAudit.delete({ where: { id: audit.id } });
  });

  it("stops a running crawl at DataForSEO and then collects what was crawled", async () => {
    const { startAudit, stopAudit, pollActiveAudits } = await import("../jobs");
    await prisma.siteAudit.updateMany({ where: { clientId, status: { in: ["queued", "crawling", "processing"] } }, data: { status: "failed" } });
    const { f, calls } = sandboxReplay();
    const started = await startAudit(clientId, "manual", { fetch: f, now: new Date("2026-11-23T05:30:00Z") });
    expect(started.status).toBe("crawling");
    const stopped = await stopAudit(clientId, { fetch: f, now: new Date("2026-11-23T05:31:00Z") });
    expect(stopped.stopRequestedAt).not.toBeNull();
    expect(calls.find((c) => c.path === "/on_page/force_stop")?.body).toEqual([{ id: started.providerTaskId }]);
    await pollActiveAudits({ fetch: f, now: new Date("2026-11-23T05:32:00Z"), retryDelayMs: 0 });
    const done = await prisma.siteAudit.findUniqueOrThrow({ where: { id: started.id } });
    expect(done.status).toBe("completed");
    expect(done.errorMessage).toMatch(/Stopped early by an administrator after 10 pages/);
  });

  it("skips a crawl over the monthly cap and records why", async () => {
    const { startAudit } = await import("../jobs");
    await prisma.siteAuditConfig.update({ where: { clientId }, data: { maxPages: 3000 } }); // ≈ $1.36, cap is $1
    const { f } = sandboxReplay();
    const a = await startAudit(clientId, "manual", { fetch: f, now: new Date("2026-11-23T06:00:00Z") });
    expect(a).toMatchObject({ status: "skipped", errorCode: "cost_cap" });
    expect(a.errorMessage).toMatch(/over the agency cap/);
  });

  it("fails a crawl after 24 hours, and doesn't auto-retry after a balance error", async () => {
    const { pollActiveAudits, scheduleDueAudits, startAudit } = await import("../jobs");
    await prisma.siteAuditConfig.update({ where: { clientId }, data: { maxPages: 10 } });
    const { f } = sandboxReplay();
    const started = await startAudit(clientId, "manual", { fetch: f, now: new Date("2026-11-24T00:00:00Z") });
    expect(started.status).toBe("crawling");
    await pollActiveAudits({ fetch: f, now: new Date("2026-11-25T01:00:00Z") });
    expect(await prisma.siteAudit.findUniqueOrThrow({ where: { id: started.id } })).toMatchObject({ status: "failed", errorCode: "timeout" });

    const broke = (async () => Response.json({ status_code: 40210, status_message: "Insufficient funds.", tasks: [] })) as unknown as typeof fetch;
    const b = await startAudit(clientId, "manual", { fetch: broke, now: new Date("2026-11-25T02:00:00Z") });
    expect(b).toMatchObject({ status: "failed", errorCode: "insufficient_balance" });
    await prisma.siteAuditConfig.update({ where: { clientId }, data: { nextRunAt: new Date("2026-11-25T03:00:00Z") } });
    expect(await scheduleDueAudits({ fetch: f, now: new Date("2026-11-25T04:00:00Z") })).toEqual({ started: 0, skipped: 1 });
    const last = await prisma.siteAudit.findFirstOrThrow({ where: { clientId }, orderBy: { createdAt: "desc" } });
    expect(last).toMatchObject({ status: "skipped", errorCode: "insufficient_balance" });
  });

  it("keeps full detail for the last 6 completed audits only", async () => {
    const { pruneAuditDetail } = await import("../jobs");
    for (let i = 0; i < 7; i++) {
      await prisma.siteAudit.create({
        data: { clientId, status: "completed", targetUrl: "https://dataforseo.com", maxPages: 10, healthScore: 80 + i, createdAt: new Date(Date.UTC(2026, 9, 1 + i)), issues: { create: [{ issueKey: "missing_title", severity: "error", category: "content", count: 2, sampleUrls: ["https://dataforseo.com/x"] }] }, pages: { create: [{ url: "https://dataforseo.com/x", issueKeys: ["missing_title"] }] } },
      });
    }
    await pruneAuditDetail(clientId);
    const audits = await prisma.siteAudit.findMany({ where: { clientId, status: "completed" }, orderBy: { createdAt: "desc" }, include: { issues: true, _count: { select: { pages: true } } } });
    const pruned = audits.filter((a) => a.detailPrunedAt);
    expect(audits.length - pruned.length).toBe(6);
    for (const a of pruned) {
      expect(a.healthScore).not.toBeNull(); // trend kept
      expect(a.issues[0].count).toBe(2); // counts kept
      expect(a.issues[0].sampleUrls).toEqual([]);
      expect(a._count.pages).toBe(0);
    }
  });
});

describe.skipIf(!hasDb)("site audit widgets for a report period (database)", () => {
  const slug = "site-audit-widgets-test";
  let clientId = "";
  beforeAll(async () => {
    await prisma.agency.deleteMany({ where: { slug } });
    const agency = await prisma.agency.create({ data: { name: "W", slug } });
    clientId = (await prisma.client.create({ data: { agencyId: agency.id, name: "W", timezone: "UTC" } })).id;
    const crawl = (id: string, finished: string, score: number, issues: [string, string, number][]) => prisma.siteAudit.create({
      data: { id, clientId, status: "completed", targetUrl: "https://w.test", maxPages: 10, healthScore: score, pagesCrawled: 10, errorPages: 1, finishedAt: new Date(finished), createdAt: new Date(finished), aiSummary: { overview: `Score ${score}.`, fixes: [], regressions: [] }, issues: { create: issues.map(([issueKey, severity, count]) => ({ issueKey, severity, category: "content", count })) } },
    });
    await crawl("w-sep", "2026-09-28T04:00:00Z", 60, [["missing_title", "error", 3], ["slow_page", "warning", 10]]);
    await crawl("w-oct1", "2026-10-05T04:00:00Z", 70, [["missing_title", "error", 1], ["slow_page", "warning", 10]]);
    await crawl("w-oct2", "2026-10-26T04:00:00Z", 80, [["slow_page", "warning", 4], ["long_url", "notice", 2]]);
  });
  afterAll(async () => {
    await prisma.agency.deleteMany({ where: { slug } });
  });

  it("shows the period's last crawl against the last crawl before the period", async () => {
    const { siteAuditSnapshot } = await import("../../dashboards/sources");
    const { buildAudit } = await import("../../dashboards/data");
    const s = await siteAuditSnapshot(clientId, { from: "2026-10-01", to: "2026-10-31" });
    expect(s.latest?.id).toBe("w-oct2");
    expect(s.baseline?.score).toBe(60); // Sep 28: the "last report" for an October report
    expect(s.trend.map((t) => t.score)).toEqual([60, 70, 80]);
    const fixed = buildAudit({ id: "f", kind: "audit_fixed", x: 0, y: 0, w: 12, h: 4 }, { linked: ["audit"] }, s);
    expect(fixed).toMatchObject({ kind: "audit_fixed", rows: [{ key: "missing_title", previous: 3 }] });
    const issues = buildAudit({ id: "i", kind: "audit_issues", x: 0, y: 0, w: 12, h: 4 }, { linked: ["audit"] }, s);
    expect(issues.kind === "audit_issues" && issues.rows.map((r) => [r.key, r.change])).toEqual([["slow_page", "better"], ["long_url", "new"]]);
    expect(buildAudit({ id: "s", kind: "audit_score", x: 0, y: 0, w: 5, h: 4 }, { linked: ["audit"] }, s)).toMatchObject({ score: 80, previous: 60 });
    expect(buildAudit({ id: "a", kind: "audit_summary", x: 0, y: 0, w: 5, h: 4 }, { linked: ["audit"] }, s)).toMatchObject({ overview: "Score 80." });
  });

  it("before any crawl: says nothing had finished by the period's end; not set up: asks to set it up", async () => {
    const { siteAuditSnapshot } = await import("../../dashboards/sources");
    const { buildAudit } = await import("../../dashboards/data");
    const s = await siteAuditSnapshot(clientId, { from: "2026-08-01", to: "2026-08-31" });
    const w = { id: "s", kind: "audit_score" as const, x: 0, y: 0, w: 5, h: 4 };
    expect(buildAudit(w, { linked: ["audit"] }, s, "2026-08-31")).toMatchObject({ kind: "empty", reason: "no_data", message: "No site audit had finished by Aug 31, 2026." });
    expect(buildAudit(w, { linked: [] }, s, "2026-08-31")).toMatchObject({ kind: "empty", reason: "not_connected", message: "Set up the Site Auditor to see this" });
  });
});

// --- Live sandbox: run with DATAFORSEO_SANDBOX=1 -------------------------------------

const sandbox = process.env.DATAFORSEO_SANDBOX === "1";
describe.skipIf(!sandbox)("DataForSEO sandbox: full crawl flow", () => {
  it("starts, polls, fetches and analyses a crawl", async () => {
    process.env.DATAFORSEO_API_BASE = "https://sandbox.dataforseo.com/v3";
    // The session proxy injects the real login; the placeholder is replaced in the header.
    const secret = "proxy-injected:x";
    const started = await startCrawl(secret, { targetUrl: "https://marketingnexus.us", maxPages: 50, enableJs: false, auditId: "sandbox-test" });
    expect(started.taskId).toMatch(/\w/);
    const p = await crawlProgress(secret, started.taskId);
    expect(p.finished).toBe(true); // the sandbox answers with a finished crawl
    await expect(stopCrawl(secret, started.taskId)).resolves.toBeUndefined(); // force_stop accepted
    const { findings } = await collectCrawl(secret, started.taskId, { targetUrl: "https://dataforseo.com", maxPages: 50, domainChecks: p.domainChecks });
    expect(findings.pages).toBeGreaterThan(0);
    const score = healthScore({ pages: findings.pages, issues: findings.issues });
    expect(score).toBeGreaterThanOrEqual(0);
    const lh = await runLighthouse(secret, ["https://dataforseo.com/"]);
    expect(lh.rows[0].performance).not.toBeNull();
  }, 120_000);

  it.skipIf(!hasDb)("stores a sandbox crawl through the real jobs (start, poll, store)", async () => {
    process.env.DATAFORSEO_API_BASE = "https://sandbox.dataforseo.com/v3";
    const slug = "site-audit-sandbox-test";
    await prisma.agency.deleteMany({ where: { slug } });
    const agency = await prisma.agency.create({ data: { name: "Sandbox", slug } });
    try {
      const user = await prisma.user.create({ data: { agencyId: agency.id, email: `${slug}@example.test`, name: "S", role: "AGENCY_ADMIN", passwordHash: "x" } });
      const conn = await prisma.dataSourceConnection.create({ data: { agencyId: agency.id, provider: "DATAFORSEO", label: "sandbox", externalId: "sandbox", createdById: user.id } });
      const { storeDataSourceSecret } = await import("../../data-sources/credentials");
      await storeDataSourceSecret(conn.id, "proxy-injected:x");
      const client = await prisma.client.create({ data: { agencyId: agency.id, name: "Sandbox Client", timezone: "UTC" } });
      await prisma.siteAuditConfig.create({ data: { clientId: client.id, targetUrl: "https://dataforseo.com", maxPages: 50, schedule: "manual", lighthouse: "homepage" } });
      const { startAudit, pollActiveAudits } = await import("../jobs");
      const a = await startAudit(client.id, "manual");
      expect(a.status).toBe("crawling");
      await pollActiveAudits();
      const done = await prisma.siteAudit.findUniqueOrThrow({ where: { id: a.id }, include: { _count: { select: { issues: true } } } });
      expect(done).toMatchObject({ status: "completed" });
      expect(done.pagesCrawled).toBeGreaterThan(0);
      expect(done._count.issues).toBeGreaterThan(0);
      expect(done.healthScore).not.toBeNull();
    } finally {
      await prisma.agency.deleteMany({ where: { slug } });
    }
  }, 180_000);
});
