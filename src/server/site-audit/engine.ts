import "server-only";
import { analyseCrawl, type CrawlFindings, type DfsPage, type SiteInputs } from "@/lib/site-audit/issues";
import {
  BALANCE_MESSAGE, DataForSeoError, getLighthouse, getOnPageList, getOnPageSummary, isBalanceCode, postOnPageTask, type FetchLike,
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
  cost: number;
}

export async function crawlProgress(secret: string, taskId: string, f?: FetchLike): Promise<CrawlProgress> {
  const { result, cost } = await getOnPageSummary(secret, taskId, f);
  return {
    finished: result?.crawl_progress === "finished",
    pagesCrawled: result?.crawl_status?.pages_crawled ?? 0,
    pagesInQueue: result?.crawl_status?.pages_in_queue ?? 0,
    onpageScore: result?.page_metrics?.onpage_score ?? null,
    domainChecks: result?.domain_info?.checks ?? null,
    cost,
  };
}

const PAGE_BATCH = 1000;

/** Fetches every crawled page (up to `maxPages` HTML pages) and the site-wide lists, then analyses them. */
export async function collectCrawl(secret: string, taskId: string, input: { targetUrl: string; maxPages: number; domainChecks: Record<string, boolean | null> | null }, f?: FetchLike): Promise<{ findings: CrawlFindings; cost: number }> {
  let cost = 0;
  const pages: DfsPage[] = [];
  for (let offset = 0; pages.length < input.maxPages; offset += PAGE_BATCH) {
    const { result, cost: c } = await getOnPageList<DfsPage>(secret, "pages", taskId, { limit: PAGE_BATCH, offset, filters: [["resource_type", "=", "html"]] }, f);
    cost += c;
    const items = (result?.items ?? []).filter((p) => !p.resource_type || p.resource_type === "html");
    pages.push(...items);
    if ((result?.items?.length ?? 0) < PAGE_BATCH) break;
  }
  const list = async <I,>(endpoint: "non_indexable" | "links" | "redirect_chains", filters?: unknown[]) => {
    try {
      const r = await getOnPageList<I>(secret, endpoint, taskId, { limit: PAGE_BATCH, filters }, f);
      cost += r.cost;
      return r.result?.items ?? [];
    } catch (e) {
      // Optional detail: a failure here must not lose the whole audit (balance/credential errors still stop it).
      const k = classifyError(e).code;
      if (k === "bad_credentials" || k === "insufficient_balance") throw e;
      return [];
    }
  };
  const site: SiteInputs = {
    domainChecks: input.domainChecks,
    nonIndexable: await list<{ url: string; reason?: string }>("non_indexable"),
    redirectChains: await list<NonNullable<SiteInputs["redirectChains"]>[number]>("redirect_chains"),
    links: await list<NonNullable<SiteInputs["links"]>[number]>("links", [["is_broken", "=", true], "and", ["direction", "=", "internal"]]),
  };
  return { findings: analyseCrawl(pages.slice(0, input.maxPages), site, hostOfTarget(input.targetUrl)), cost };
}

export interface LighthouseRow { url: string; performance: number | null; lcpMs: number | null; cls: number | null; tbtMs: number | null; error?: string }

/** Lighthouse (mobile, performance) for each URL, one at a time. Failures are recorded per URL. */
export async function runLighthouse(secret: string, urls: string[], f?: FetchLike): Promise<{ rows: LighthouseRow[]; cost: number }> {
  const rows: LighthouseRow[] = [];
  let cost = 0;
  for (const url of urls) {
    try {
      const { result, cost: c } = await getLighthouse(secret, url, f);
      cost += c;
      const a = result?.audits ?? {};
      const num = (k: string) => (typeof a[k]?.numericValue === "number" ? a[k]!.numericValue! : null);
      const perf = result?.categories?.performance?.score;
      rows.push({ url, performance: typeof perf === "number" ? Math.round(perf * 100) : null, lcpMs: num("largest-contentful-paint"), cls: num("cumulative-layout-shift"), tbtMs: num("total-blocking-time") });
    } catch (e) {
      const k = classifyError(e).code;
      if (k === "bad_credentials" || k === "insufficient_balance") throw e;
      rows.push({ url, performance: null, lcpMs: null, cls: null, tbtMs: null, error: (e as Error).message.slice(0, 200) });
    }
  }
  return { rows, cost };
}
