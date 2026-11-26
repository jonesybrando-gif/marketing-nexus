import "server-only";
import { analyseCrawl, type CrawlFindings, type DfsPage, type SiteInputs } from "@/lib/site-audit/issues";
import { isExcludedUrl } from "@/lib/site-audit/urls";
import {
  BALANCE_MESSAGE, DataForSeoError, forceStopOnPage, getLighthouse, getOnPageList, getOnPageSummary, isBalanceCode, postOnPageTask, type FetchLike,
} from "../data-sources/dataforseo/api";

// Site Auditor crawl engine: start a DataForSEO On-Page crawl, check its
// progress, collect and analyse results, run Lighthouse. No database access
// (./jobs.ts stores everything), so it is tested with fixtures and the sandbox.

export type AuditErrorCode = "bad_credentials" | "insufficient_balance" | "invalid_target" | "rate_limit" | "provider_error" | "timeout" | "cost_cap" | "not_connected" | "already_running";

/** Codes the scheduler must not retry on its own: they need a person (new login, more funds). */
export const NO_AUTO_RETRY: AuditErrorCode[] = ["bad_credentials", "insufficient_balance"];

export const ERROR_HELP: Record<AuditErrorCode, string> = {
  bad_credentials: "DataForSEO rejected the API login. An administrator can update it in Settings › Connections.",
  insufficient_balance: "The DataForSEO balance is too low for this crawl. Add funds in DataForSEO, then run the audit again.",
  invalid_target: "DataForSEO couldn't crawl this address. Check the website URL in the audit settings.",
  rate_limit: "DataForSEO is limiting requests right now. The audit will be tried again later.",
  provider_error: "DataForSEO returned an error. The audit will be tried again on the next schedule.",
  timeout: "The crawl didn't finish within 24 hours.",
  cost_cap: "Skipped: it would go over the agency's monthly site audit spending cap.",
  not_connected: "DataForSEO isn't connected. An administrator can connect it in Settings › Connections.",
  already_running: "A crawl for this site is already running.",
};

export class AuditError extends Error {
  constructor(readonly code: AuditErrorCode, message?: string) {
    super(message ?? ERROR_HELP[code]);
    this.name = "AuditError";
  }
}

/** Maps DataForSEO and network errors to the data source contract's classes. */
export function classifyError(e: unknown): { code: AuditErrorCode; message: string } {
  if (e instanceof AuditError) return { code: e.code, message: e.message };
  const msg = (e as Error)?.message ?? String(e);
  const code = e instanceof DataForSeoError ? e.code : undefined;
  if (code === 401 || code === 40100 || /unauthori[sz]ed|rejected the API login/i.test(msg)) return { code: "bad_credentials", message: ERROR_HELP.bad_credentials };
  if (isBalanceCode(code) || msg === BALANCE_MESSAGE) return { code: "insufficient_balance", message: ERROR_HELP.insufficient_balance };
  if (code === 40202 || code === 429 || /rate limit|too many requests/i.test(msg)) return { code: "rate_limit", message: ERROR_HELP.rate_limit };
  // 40501 invalid field, 40503 invalid target / unreachable domain, 40400 not found.
  if (code === 40501 || code === 40503 || /invalid (field: )?'?target|invalid url/i.test(msg)) return { code: "invalid_target", message: `${ERROR_HELP.invalid_target} (${msg.slice(0, 200)})` };
  return { code: "provider_error", message: msg.slice(0, 300) };
}

/** Normalises a website address to an https origin (keeps a non-www/www host as entered). */
export function normalizeTargetUrl(input: string): string | null {
  let s = (input ?? "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    return `${u.protocol}//${u.hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

export const hostOfTarget = (targetUrl: string) => new URL(targetUrl).hostname.replace(/^www\./, "");

export interface StartedCrawl { taskId: string; cost: number }

export async function startCrawl(secret: string, input: { targetUrl: string; maxPages: number; enableJs: boolean; auditId: string }, f?: FetchLike): Promise<StartedCrawl> {
  const t = await postOnPageTask(secret, {
    target: hostOfTarget(input.targetUrl),
    start_url: `${input.targetUrl}/`,
    max_crawl_pages: input.maxPages,
    load_resources: true,
    enable_javascript: input.enableJs,
    calculate_keyword_density: false,
    tag: input.auditId,
  }, f);
  if (t.status_code !== 20100 || !t.id) throw new DataForSeoError(`DataForSEO error ${t.status_code}: ${t.status_message}`, t.status_code);
  return { taskId: t.id, cost: t.cost ?? 0 };
}

export interface CrawlProgress {
  finished: boolean;
  pagesCrawled: number;
  pagesInQueue: number;
  onpageScore: number | null;
  domainChecks: Record<string, boolean | null> | null;
  /** The site's web server (e.g. "cloudflare"), for explaining blocked tests. */
  server: string | null;
  cost: number;
}

export async function crawlProgress(secret: string, taskId: string, f?: FetchLike): Promise<CrawlProgress> {
  const { result, cost } = await getOnPageSummary(secret, taskId, f);
  const info = result?.domain_info as ({ server?: string | null } & NonNullable<typeof result>["domain_info"]) | null | undefined;
  return {
    finished: result?.crawl_progress === "finished",
    pagesCrawled: result?.crawl_status?.pages_crawled ?? 0,
    pagesInQueue: result?.crawl_status?.pages_in_queue ?? 0,
    onpageScore: result?.page_metrics?.onpage_score ?? null,
    domainChecks: info?.checks ?? null,
    server: typeof info?.server === "string" && info.server ? info.server.slice(0, 80) : null,
    cost,
  };
}

/** Stops a running crawl (free). DataForSEO then reports it finished, with the pages crawled so far. */
export const stopCrawl = (secret: string, taskId: string, f?: FetchLike) => forceStopOnPage(secret, taskId, f);

const PAGE_BATCH = 1000;
/** Most broken links read per crawl (beyond this, pages fall back to DataForSEO's per-page flag). */
const MAX_BROKEN_LINKS = 10_000;
/** Most broken resources whose pages are looked up individually. */
const MAX_RESOURCE_LOOKUPS = 20;

/**
 * Fetches every crawled page (up to `maxPages` HTML pages) and the site-wide
 * lists (blocked pages, redirect chains, every broken link, broken resources
 * and the pages using them), then analyses them. All these reads are free.
 */
export async function collectCrawl(secret: string, taskId: string, input: { targetUrl: string; maxPages: number; domainChecks: Record<string, boolean | null> | null; ignore?: string[] }, f?: FetchLike): Promise<{ findings: CrawlFindings; cost: number }> {
  let cost = 0;
  const pages: DfsPage[] = [];
  for (let offset = 0; pages.length < input.maxPages; offset += PAGE_BATCH) {
    const { result, cost: c } = await getOnPageList<DfsPage>(secret, "pages", taskId, { limit: PAGE_BATCH, offset, filters: [["resource_type", "=", "html"]] }, f);
    cost += c;
    const items = (result?.items ?? []).filter((p) => !p.resource_type || p.resource_type === "html");
    pages.push(...items);
    if ((result?.items?.length ?? 0) < PAGE_BATCH) break;
  }
  // Optional detail: a failure here must not lose the whole audit (balance/credential errors still stop it).
  const optional = async <T,>(read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read();
    } catch (e) {
      const k = classifyError(e).code;
      if (k === "bad_credentials" || k === "insufficient_balance") throw e;
      return fallback;
    }
  };
  const list = async <I,>(endpoint: "non_indexable" | "redirect_chains", filters?: unknown[]) =>
    optional(async () => {
      const r = await getOnPageList<I>(secret, endpoint, taskId, { limit: PAGE_BATCH, filters }, f);
      cost += r.cost;
      return r.result?.items ?? [];
    }, [] as I[]);
  type Link = NonNullable<SiteInputs["links"]>[number];
  // Every broken link (paged), so a page whose only broken links are excluded paths isn't counted.
  const links = await optional(async () => {
    const out: Link[] = [];
    for (let offset = 0; offset < MAX_BROKEN_LINKS; offset += PAGE_BATCH) {
      const r = await getOnPageList<Link>(secret, "links", taskId, { limit: PAGE_BATCH, offset, filters: [["is_broken", "=", true]] }, f);
      cost += r.cost;
      const items = r.result?.items ?? [];
      out.push(...items.filter((l) => l.is_broken === true));
      if (items.length < PAGE_BATCH) return { items: out, complete: true };
    }
    return { items: out, complete: false };
  }, { items: [] as Link[], complete: false });
  // Broken resources, then which pages use the ones that aren't excluded.
  const brokenResources = await optional(async () => {
    const out: { url: string }[] = [];
    for (let offset = 0; offset < MAX_BROKEN_LINKS; offset += PAGE_BATCH) {
      const r = await getOnPageList<{ url?: string; status_code?: number | null; checks?: { is_broken?: boolean | null } | null }>(secret, "resources", taskId, { limit: PAGE_BATCH, offset, filters: [["checks.is_broken", "=", true]] }, f);
      cost += r.cost;
      const items = r.result?.items ?? [];
      // The sandbox ignores filters: keep only broken ones here too.
      out.push(...items.filter((x) => x.url && (x.checks?.is_broken === true || (x.status_code ?? 0) >= 400)).map((x) => ({ url: x.url! })));
      if (items.length < PAGE_BATCH) return out;
    }
    return undefined; // too many to judge: keep DataForSEO's per-page flag
  }, undefined as { url: string }[] | undefined);
  const resourcePages: Record<string, string[]> = {};
  const toLookUp = (brokenResources ?? []).filter((r) => !isExcludedUrl(r.url, input.ignore ?? []));
  if (toLookUp.length <= MAX_RESOURCE_LOOKUPS) {
    for (const res of toLookUp) {
      const ps = await optional(async () => {
        const r = await getOnPageList<{ url?: string }>(secret, "pages_by_resource", taskId, { limit: PAGE_BATCH, url: res.url }, f);
        cost += r.cost;
        return (r.result?.items ?? []).map((x) => x.url).filter((u): u is string => !!u);
      }, null as string[] | null);
      if (ps) resourcePages[res.url] = ps;
    }
  }
  const site: SiteInputs = {
    domainChecks: input.domainChecks,
    nonIndexable: await list<{ url: string; reason?: string }>("non_indexable"),
    redirectChains: await list<NonNullable<SiteInputs["redirectChains"]>[number]>("redirect_chains"),
    links: links.items,
    linksComplete: links.complete,
    brokenResources,
    resourcePages,
  };
  return { findings: analyseCrawl(pages.slice(0, input.maxPages), site, hostOfTarget(input.targetUrl), { ignore: input.ignore }), cost };
}

export interface LighthouseRow {
  url: string;
  performance: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  /** Why the test couldn't run, in plain words (shown on the tab). */
  error?: string;
  /** Lighthouse's own error code, e.g. ERRORED_DOCUMENT_REQUEST. */
  errorCode?: string;
}

/** Plain-language reason a Lighthouse test failed, from its runtimeError. Exported for tests. */
export function lighthouseFailure(err: { code?: string; message?: string } | null | undefined, taskMessage: string, server: string | null): string {
  const status = Number(err?.message?.match(/Status code:\s*(\d{3})/i)?.[1] ?? NaN);
  const behindCloudflare = /cloudflare/i.test(server ?? "");
  if (status === 403 || status === 401 || status === 429) {
    return `The site refused the speed test (HTTP ${status}).${behindCloudflare ? " It's behind Cloudflare, whose bot protection likely blocked the tester: allow DataForSEO's crawler (or the Lighthouse user agent) in Cloudflare's security settings, then run the audit again." : " A firewall or bot protection likely blocked the tester: allow DataForSEO's crawler, then run the audit again."}`;
  }
  if (Number.isFinite(status)) return `The page returned HTTP ${status} to the speed test.`;
  if (err?.code === "NO_FCP") return "The page didn't show any content to the speed test (it may need JavaScript or block automated browsers).";
  if (err?.message) return err.message.slice(0, 300);
  return taskMessage.slice(0, 300) || "The speed test failed.";
}

const RETRY_DELAY_MS = 5_000;

/**
 * Lighthouse (mobile, performance) for each URL, one at a time. A failed test
 * is retried once; if it fails again, the row records why. DataForSEO doesn't
 * charge for failed tests.
 */
export async function runLighthouse(secret: string, urls: string[], f?: FetchLike, opts: { server?: string | null; retryDelayMs?: number } = {}): Promise<{ rows: LighthouseRow[]; cost: number }> {
  const rows: LighthouseRow[] = [];
  let cost = 0;
  for (const url of urls) {
    let row: LighthouseRow | null = null;
    for (let attempt = 0; attempt < 2 && !(row && !row.error); attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? RETRY_DELAY_MS));
      try {
        const t = await getLighthouse(secret, url, f);
        cost += t.cost;
        const result = t.result;
        const perf = result?.categories?.performance?.score;
        if (t.status !== 20000 || result?.runtimeError || typeof perf !== "number") {
          row = { url, performance: null, lcpMs: null, cls: null, tbtMs: null, error: lighthouseFailure(result?.runtimeError, t.message, opts.server ?? null), errorCode: result?.runtimeError?.code ?? String(t.status) };
          continue;
        }
        const a = result?.audits ?? {};
        const num = (k: string) => (typeof a[k]?.numericValue === "number" ? a[k]!.numericValue! : null);
        row = { url, performance: Math.round(perf * 100), lcpMs: num("largest-contentful-paint"), cls: num("cumulative-layout-shift"), tbtMs: num("total-blocking-time") };
      } catch (e) {
        const k = classifyError(e).code;
        if (k === "bad_credentials" || k === "insufficient_balance") throw e;
        row = { url, performance: null, lcpMs: null, cls: null, tbtMs: null, error: (e as Error).message.slice(0, 300) };
      }
    }
    rows.push(row!);
  }
  return { rows, cost };
}
