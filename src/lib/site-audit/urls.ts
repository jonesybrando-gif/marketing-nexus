// URLs the Site Auditor leaves out: CDN and platform system paths (never real
// content, e.g. Cloudflare's /cdn-cgi/l/email-protection on every page) and a
// client's own "ignore" patterns (e.g. /book?* for booking links that are
// noindexed on purpose). Excluded URLs aren't crawled pages, broken-link or
// broken-resource targets, or blocked pages for the issue list and the score.

/** Path prefixes of CDN and platform machinery, not site content. */
export const SYSTEM_PATH_PREFIXES = [
  "/cdn-cgi/", // Cloudflare (email protection, challenge, beacon scripts)
  "/.well-known/",
  "/wp-admin/",
  "/wp-login.php",
  "/wp-json/",
  "/xmlrpc.php",
  "/_vercel/",
  "/__/", // Firebase Hosting reserved paths
];

/** Path and query of a URL ("/book?city=Austin"), lowercased. Relative URLs are read as paths. */
function pathAndQuery(url: string): string {
  try {
    const u = new URL(url, "https://site.invalid");
    return `${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function isSystemUrl(url: string): boolean {
  const p = pathAndQuery(url);
  return SYSTEM_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export const MAX_IGNORE_PATTERNS = 50;

/**
 * Patterns from the settings box, one per line. `*` matches anything; the rest
 * is literal, so `/book?*` means "/book followed by any query". A pattern
 * matches the URL's path and query from the start to the end; use a trailing
 * `*` for "starts with". Full URLs ("https://site.com/book*") are reduced to
 * their path. Blank lines and lines starting with # are skipped.
 */
export function parseIgnorePatterns(text: string): { patterns: string[]; errors: string[] } {
  const patterns: string[] = [];
  const errors: string[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    let p = raw.trim();
    if (!p || p.startsWith("#")) continue;
    if (/^https?:\/\//i.test(p)) p = p.replace(/^https?:\/\/[^/]+/i, "") || "/";
    if (!p.startsWith("/") && !p.startsWith("*")) p = `/${p}`;
    if (p.length > 200) errors.push(`Too long: ${p.slice(0, 40)}…`);
    else if (!patterns.includes(p)) patterns.push(p);
  }
  if (patterns.length > MAX_IGNORE_PATTERNS) errors.push(`At most ${MAX_IGNORE_PATTERNS} patterns.`);
  return { patterns: patterns.slice(0, MAX_IGNORE_PATTERNS), errors };
}

const cache = new Map<string, RegExp>();
function toRegExp(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.toLowerCase().split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    cache.set(pattern, re);
  }
  return re;
}

export function matchesIgnore(url: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const p = pathAndQuery(url);
  return patterns.some((pattern) => toRegExp(pattern).test(p));
}

/** Left out of the audit: a system path or one of the client's ignore patterns. */
export const isExcludedUrl = (url: string, patterns: string[] = []) => isSystemUrl(url) || matchesIgnore(url, patterns);
