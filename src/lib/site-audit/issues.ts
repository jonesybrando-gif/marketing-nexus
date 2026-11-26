// Site Auditor issue catalogue: maps DataForSEO On-Page results to our stable
// issue keys, with severity, category and a one-line fix. Pure (no DB or
// network), shared by the crawl processor, the Site Audit tab and reports.
// Each detector is unit-tested against sandbox fixtures.

import { isExcludedUrl } from "./urls";

export type Severity = "error" | "warning" | "notice";
export type Category = "crawlability" | "content" | "links" | "performance" | "security" | "images";

export const SEVERITIES: Severity[] = ["error", "warning", "notice"];
export const CATEGORIES: Category[] = ["crawlability", "content", "links", "performance", "security", "images"];
export const CATEGORY_LABEL: Record<Category, string> = {
  crawlability: "Crawlability", content: "Content", links: "Links", performance: "Performance", security: "Security", images: "Images",
};
export const SEVERITY_LABEL: Record<Severity, string> = { error: "Errors", warning: "Warnings", notice: "Notices" };

/** The parts of a DataForSEO on_page/pages item we read. */
export interface DfsPage {
  url: string;
  resource_type?: string;
  status_code?: number | null;
  onpage_score?: number | null;
  click_depth?: number | null;
  url_length?: number | null;
  size?: number | null;
  broken_links?: boolean | null;
  broken_resources?: boolean | null;
  duplicate_title?: boolean | null;
  duplicate_description?: boolean | null;
  checks?: Record<string, boolean | null | undefined> | null;
  meta?: {
    title?: string | null;
    description?: string | null;
    htags?: Record<string, string[] | undefined> | null;
    internal_links_count?: number | null;
    external_links_count?: number | null;
    inbound_links_count?: number | null;
    images_count?: number | null;
    content?: { plain_text_word_count?: number | null } | null;
    social_media_tags?: Record<string, string | undefined> | null;
  } | null;
  page_timing?: { duration_time?: number | null; waiting_time?: number | null } | null;
}

/** Site-wide inputs from other On-Page endpoints. */
export interface SiteInputs {
  /** on_page/summary domain_info.checks */
  domainChecks?: Record<string, boolean | null | undefined> | null;
  /** on_page/non_indexable items */
  nonIndexable?: { url: string; reason?: string | null }[];
  /** on_page/redirect_chains items */
  redirectChains?: { is_redirect_loop?: boolean | null; chain?: { from_url?: string; to_url?: string }[] | null }[];
  /** on_page/links items (any; only broken ones are used) */
  links?: { link_from?: string; link_to?: string; direction?: string; is_broken?: boolean | null; page_to_status_code?: number | null }[];
  /** True when `links` holds every broken link of the crawl, so pages can be judged by them alone. */
  linksComplete?: boolean;
  /**
   * Resources (images, scripts, styles) that failed to load, from on_page/resources;
   * undefined = not fetched. Resources that loaded but have parse warnings aren't broken.
   */
  brokenResources?: { url: string; status?: number | null }[];
  /** Pages using each broken resource (on_page/pages_by_resource), for resources that aren't excluded. */
  resourcePages?: Record<string, string[]>;
  /** How many pages use each broken resource (can exceed the pages listed). */
  resourcePageCounts?: Record<string, number>;
}

/** A broken resource or link target, with its HTTP status and how many pages use or link to it. */
export interface IssueTarget {
  url: string;
  status: number | null;
  pages: number;
}

/** Load failed: an HTTP error, or no response at all. A 200 with CSS/JS parse warnings is not a failure. */
export const failedToLoad = (status: number | null | undefined) => status === null || status === undefined || status === 0 || status >= 400;

export interface IssueDef {
  key: string;
  label: string;
  severity: Severity;
  category: Category;
  /** One line, plain English. */
  fix: string;
  /** "page": counted per crawled page. "site": a site-wide check (a list of URLs, or a yes/no check). */
  scope: "page" | "site";
  /** Site-wide yes/no check (no sitemap, no robots.txt): when found, it applies to the whole site. */
  presence?: boolean;
  /** Page detector (scope "page"). */
  test?: (p: DfsPage) => boolean;
}

/** Thresholds for checks DataForSEO doesn't flag directly. */
export const LIMITS = { lowWordCount: 200, longUrl: 115, manyLinks: 250, deepClick: 4, slowLoadMs: 3000 };

const c = (p: DfsPage, k: string) => p.checks?.[k] === true;
const isHtml = (p: DfsPage) => !p.resource_type || p.resource_type === "html";
const ok200 = (p: DfsPage) => (p.status_code ?? 200) >= 200 && (p.status_code ?? 200) < 300;
const h1Count = (p: DfsPage) => p.meta?.htags?.h1?.filter((h) => h?.trim()).length ?? 0;

export const ISSUES: IssueDef[] = [
  // --- Errors ---
  { key: "http_4xx", label: "Pages returning 4xx errors", severity: "error", category: "crawlability", scope: "page", fix: "Restore the page or 301-redirect it to the closest live page, and update links pointing to it.", test: (p) => c(p, "is_4xx_code") || ((p.status_code ?? 0) >= 400 && (p.status_code ?? 0) < 500) },
  { key: "http_5xx", label: "Pages returning 5xx server errors", severity: "error", category: "crawlability", scope: "page", fix: "Check the server or hosting logs for these URLs; server errors stop Google from reading the page.", test: (p) => c(p, "is_5xx_code") || (p.status_code ?? 0) >= 500 },
  // Broken links and resources are re-checked per page in analyseCrawl, leaving out CDN/system paths and ignored URLs.
  { key: "broken_internal_links", label: "Pages with broken links", severity: "error", category: "links", scope: "page", fix: "Update or remove links that point to missing pages.", test: (p) => p.broken_links === true },
  { key: "broken_resources", label: "Pages with broken images, scripts or styles", severity: "error", category: "links", scope: "page", fix: "Re-upload or fix the paths of missing images, scripts and stylesheets.", test: (p) => p.broken_resources === true },
  { key: "redirect_loop", label: "Redirect loops", severity: "error", category: "crawlability", scope: "site", fix: "Break the loop so each URL redirects once, straight to a live page." },
  { key: "non_https", label: "Pages served over plain HTTP", severity: "error", category: "security", scope: "page", fix: "Redirect HTTP to HTTPS sitewide and update internal links to https://.", test: (p) => c(p, "is_http") || p.url.startsWith("http://") },
  { key: "mixed_content", label: "HTTPS pages linking to HTTP", severity: "error", category: "security", scope: "page", fix: "Change http:// links and resources on these pages to https://.", test: (p) => c(p, "https_to_http_links") },
  // A warning, not an error: many sites noindex pages on purpose (bookings, carts, filters). Add those to the client's ignore patterns.
  { key: "blocked_but_linked", label: "Linked pages blocked from Google (robots.txt or noindex)", severity: "warning", category: "crawlability", scope: "site", fix: "If these pages should rank, remove the noindex tag or robots.txt rule. If they're blocked on purpose (bookings, carts, filters), add them to the audit's ignore patterns." },
  { key: "duplicate_title", label: "Duplicate page titles", severity: "error", category: "content", scope: "page", fix: "Give each page its own title that says what's on it.", test: (p) => p.duplicate_title === true || c(p, "duplicate_title_tag") },
  { key: "missing_title", label: "Pages missing a title", severity: "error", category: "content", scope: "page", fix: "Add a unique <title> of about 50–60 characters.", test: (p) => isHtml(p) && ok200(p) && (c(p, "no_title") || !p.meta?.title?.trim()) },

  // --- Warnings ---
  { key: "missing_description", label: "Missing meta descriptions", severity: "warning", category: "content", scope: "page", fix: "Write a 120–155 character description that sells the click.", test: (p) => isHtml(p) && ok200(p) && c(p, "no_description") },
  { key: "duplicate_description", label: "Duplicate meta descriptions", severity: "warning", category: "content", scope: "page", fix: "Write a different description for each page.", test: (p) => p.duplicate_description === true },
  { key: "title_too_long", label: "Titles too long", severity: "warning", category: "content", scope: "page", fix: "Shorten the title to about 60 characters so Google doesn't cut it off.", test: (p) => c(p, "title_too_long") },
  { key: "title_too_short", label: "Titles too short", severity: "warning", category: "content", scope: "page", fix: "Expand the title to describe the page and its main keyword.", test: (p) => c(p, "title_too_short") },
  { key: "missing_h1", label: "Pages missing an H1 heading", severity: "warning", category: "content", scope: "page", fix: "Add one H1 that states the page's topic.", test: (p) => isHtml(p) && ok200(p) && (c(p, "no_h1_tag") || (p.meta?.htags != null && h1Count(p) === 0)) },
  { key: "multiple_h1", label: "Pages with more than one H1", severity: "warning", category: "content", scope: "page", fix: "Keep one H1 per page and turn the others into H2s.", test: (p) => h1Count(p) > 1 },
  { key: "redirect_chain", label: "Redirect chains", severity: "warning", category: "crawlability", scope: "page", fix: "Point links and redirects straight at the final URL.", test: (p) => c(p, "redirect_chain") },
  { key: "low_word_count", label: "Thin pages (under 200 words)", severity: "warning", category: "content", scope: "page", fix: "Add useful, specific content, or merge the page into a stronger one.", test: (p) => isHtml(p) && ok200(p) && typeof p.meta?.content?.plain_text_word_count === "number" && p.meta.content.plain_text_word_count < LIMITS.lowWordCount },
  { key: "slow_page", label: "Slow pages", severity: "warning", category: "performance", scope: "page", fix: "Compress images, cut unused scripts and use caching to speed these pages up.", test: (p) => c(p, "high_loading_time") || c(p, "high_waiting_time") || (p.page_timing?.duration_time ?? 0) > LIMITS.slowLoadMs },
  { key: "large_page", label: "Large pages", severity: "warning", category: "performance", scope: "page", fix: "Reduce page weight: smaller images, fewer scripts, lazy-load below the fold.", test: (p) => c(p, "large_page_size") || c(p, "size_greater_than_3mb") },
  { key: "image_missing_alt", label: "Images missing alt text", severity: "warning", category: "images", scope: "page", fix: "Describe each meaningful image in its alt attribute.", test: (p) => c(p, "no_image_alt") },
  { key: "canonical_issue", label: "Canonical problems", severity: "warning", category: "crawlability", scope: "page", fix: "Point canonicals straight at the live, preferred URL (no redirects, chains or broken targets).", test: (p) => c(p, "recursive_canonical") || c(p, "canonical_chain") || c(p, "canonical_to_redirect") || c(p, "canonical_to_broken") },
  { key: "orphan_page", label: "Orphan pages (no internal links in)", severity: "warning", category: "links", scope: "page", fix: "Link to these pages from relevant pages and the menu so visitors and Google can find them.", test: (p) => c(p, "is_orphan_page") },
  { key: "no_sitemap", label: "No XML sitemap found", severity: "warning", category: "crawlability", scope: "site", presence: true, fix: "Publish a sitemap.xml, list it in robots.txt and submit it in Search Console." },
  { key: "no_robots_txt", label: "No robots.txt found", severity: "notice", category: "crawlability", scope: "site", presence: true, fix: "Add a robots.txt (it can be short) that lists the sitemap." },

  // --- Notices ---
  { key: "long_url", label: "Long URLs", severity: "notice", category: "crawlability", scope: "page", fix: "Use short, readable URLs for new pages (keep existing ones unless you redirect them).", test: (p) => (p.url_length ?? p.url.length) > LIMITS.longUrl },
  { key: "too_many_links", label: "Pages with very many links", severity: "notice", category: "links", scope: "page", fix: "Trim navigation and footer links so the important ones stand out.", test: (p) => (p.meta?.internal_links_count ?? 0) + (p.meta?.external_links_count ?? 0) > LIMITS.manyLinks },
  { key: "deep_page", label: "Pages buried deep (4+ clicks from home)", severity: "notice", category: "crawlability", scope: "page", fix: "Link to these pages from higher-level pages so they're fewer clicks from the homepage.", test: (p) => (p.click_depth ?? 0) >= LIMITS.deepClick },
  { key: "missing_og", label: "Missing Open Graph tags", severity: "notice", category: "content", scope: "page", fix: "Add og:title, og:description and og:image so shared links look right.", test: (p) => isHtml(p) && ok200(p) && p.meta != null && !p.meta.social_media_tags?.["og:title"] },
];

export const ISSUE_BY_KEY: Record<string, IssueDef> = Object.fromEntries(ISSUES.map((d) => [d.key, d]));
export const SEVERITY_WEIGHT: Record<Severity, number> = { error: 1, warning: 0.4, notice: 0.1 };
const MAX_SAMPLES = 20;
const MAX_TARGETS = 50;

/** Issue keys a page has (page-scoped issues only). */
export function pageIssueKeys(p: DfsPage): string[] {
  return ISSUES.filter((d) => d.scope === "page" && d.test?.(p)).map((d) => d.key);
}

export interface FoundIssue {
  key: string;
  severity: Severity;
  category: Category;
  /** Pages affected (site-wide checks: occurrences). */
  count: number;
  sampleUrls: string[];
  /** Broken resources / link targets behind the issue, most-used first (up to 50). */
  targets?: IssueTarget[];
}

export interface CrawlFindings {
  /** HTML pages analysed. */
  pages: number;
  issues: FoundIssue[];
  /** Pages with at least one error / warning / notice (page-scoped issues). */
  errorPages: number;
  warningPages: number;
  noticePages: number;
  /** Pages with an error or warning, for SiteAuditPage. */
  pageRows: { url: string; statusCode: number | null; issueKeys: string[]; onpageScore: number | null }[];
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

/**
 * Turns crawl results into issue counts. Only HTML pages are analysed;
 * resources (images, scripts) are not. URLs on CDN/system paths (Cloudflare's
 * /cdn-cgi/…) and the client's ignore patterns are left out everywhere: as
 * pages, as broken link or resource targets, and as blocked pages.
 */
export function analyseCrawl(pages: DfsPage[], site: SiteInputs, targetHost: string, opts: { ignore?: string[] } = {}): CrawlFindings {
  const ignore = opts.ignore ?? [];
  const excluded = (u: string) => isExcludedUrl(u, ignore);
  const host = targetHost.replace(/^www\./, "").toLowerCase();
  const sameSite = (u: string) => {
    const h = hostOf(u);
    return h === host || h.endsWith(`.${host}`);
  };
  const keyOf = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();

  // Broken links per page, excluded targets left out.
  const brokenLinks = (site.links ?? []).filter((l) => l.is_broken === true && l.link_from && l.link_to);
  const realBrokenFrom = new Map<string, string[]>();
  const anyBrokenFrom = new Set<string>();
  for (const l of brokenLinks) {
    const from = keyOf(l.link_from!);
    anyBrokenFrom.add(from);
    if (excluded(l.link_to!)) continue;
    (realBrokenFrom.get(from) ?? realBrokenFrom.set(from, []).get(from)!).push(l.link_to!);
  }
  const hasBrokenLink = (p: DfsPage) => {
    const k = keyOf(p.url);
    if (realBrokenFrom.has(k)) return true;
    // Every broken link known: only real ones count. Otherwise trust the page flag unless all its known ones are excluded.
    if (site.linksComplete) return false;
    return p.broken_links === true && !anyBrokenFrom.has(k);
  };

  // Broken resources: only ones that aren't excluded, on the pages that use them when known.
  const realResources = site.brokenResources?.filter((r) => r.url && !excluded(r.url) && failedToLoad(r.status));
  // Pages using a resource that really failed (never one that loaded with parse warnings).
  const resourcePages = new Set((realResources ?? []).flatMap((r) => (site.resourcePages?.[r.url] ?? []).map(keyOf)));
  const pagesKnownForAll = !!realResources && realResources.every((r) => site.resourcePages?.[r.url]);
  const hasBrokenResource = (p: DfsPage) => {
    if (realResources && realResources.length === 0) return false;
    if (pagesKnownForAll) return resourcePages.has(keyOf(p.url));
    return p.broken_resources === true;
  };

  const html = pages.filter((p) => isHtml(p) && p.url && !excluded(p.url));
  const byKey = new Map<string, Set<string>>();
  const add = (key: string, url: string) => (byKey.get(key) ?? byKey.set(key, new Set()).get(key)!).add(url);
  let errorPages = 0, warningPages = 0, noticePages = 0;
  const pageRows: CrawlFindings["pageRows"] = [];
  for (const p of html) {
    const keys = pageIssueKeys({ ...p, broken_links: hasBrokenLink(p), broken_resources: hasBrokenResource(p) });
    for (const k of keys) add(k, p.url);
    const sev = new Set(keys.map((k) => ISSUE_BY_KEY[k].severity));
    if (sev.has("error")) errorPages++;
    if (sev.has("warning")) warningPages++;
    if (sev.has("notice")) noticePages++;
    if (sev.has("error") || sev.has("warning")) pageRows.push({ url: p.url.slice(0, 2000), statusCode: p.status_code ?? null, issueKeys: keys, onpageScore: p.onpage_score ?? null });
  }
  // Site-wide checks.
  const dc = site.domainChecks ?? {};
  if (dc.sitemap === false) add("no_sitemap", "");
  if (dc.robots_txt === false) add("no_robots_txt", "");
  for (const r of site.redirectChains ?? []) {
    const from = r.chain?.[0]?.from_url ?? "";
    if (r.is_redirect_loop && !(from && excluded(from))) add("redirect_loop", from);
  }
  const blockedReasons = /robots|noindex|meta|header/i;
  for (const n of site.nonIndexable ?? []) {
    if (n.url && sameSite(n.url) && !excluded(n.url) && blockedReasons.test(n.reason ?? "")) add("blocked_but_linked", n.url);
  }
  // Targets: each broken link target with the pages linking to it, each broken resource with the pages using it.
  const linkPages = new Map<string, { pages: Set<string>; status: number | null }>();
  for (const l of brokenLinks) {
    if (excluded(l.link_to!)) continue;
    const t = linkPages.get(l.link_to!) ?? { pages: new Set<string>(), status: l.page_to_status_code ?? null };
    t.pages.add(keyOf(l.link_from!));
    linkPages.set(l.link_to!, t);
  }
  const byUse = (a: IssueTarget, b: IssueTarget) => b.pages - a.pages || a.url.localeCompare(b.url);
  const linkTargets: IssueTarget[] = [...linkPages].map(([url, t]) => ({ url, status: t.status, pages: t.pages.size })).sort(byUse).slice(0, MAX_TARGETS);
  const resourceTargets: IssueTarget[] = (realResources ?? [])
    .map((r) => ({ url: r.url, status: r.status ?? null, pages: site.resourcePageCounts?.[r.url] ?? site.resourcePages?.[r.url]?.length ?? 0 }))
    .sort(byUse)
    .slice(0, MAX_TARGETS);
  const brokenTargets = linkTargets.map((t) => t.url);
  const issues: FoundIssue[] = [];
  for (const d of ISSUES) {
    const urls = byKey.get(d.key);
    if (!urls?.size) continue;
    const real = [...urls].filter(Boolean);
    const samples = d.key === "broken_internal_links" && brokenTargets.length ? brokenTargets : real;
    const targets = d.key === "broken_internal_links" ? linkTargets : d.key === "broken_resources" ? resourceTargets : [];
    issues.push({ key: d.key, severity: d.severity, category: d.category, count: d.scope === "site" ? Math.max(1, real.length) : urls.size, sampleUrls: samples.slice(0, MAX_SAMPLES), ...(targets.length ? { targets } : {}) });
  }
  return { pages: html.length, issues, errorPages, warningPages, noticePages, pageRows };
}
