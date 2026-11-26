import "server-only";

// Minimal DataForSEO v3 client (official REST API, HTTP Basic auth).
// `secret` is "login:password"; it is only ever sent in the Authorization
// header and never logged or included in error messages.

export const DFS_BASE = "https://api.dataforseo.com/v3";
/** API root; DATAFORSEO_API_BASE=https://sandbox.dataforseo.com/v3 points everything at the free sandbox (tests). */
export const dfsBase = () => process.env.DATAFORSEO_API_BASE?.replace(/\/$/, "") || DFS_BASE;

export type FetchLike = typeof fetch;

export class DataForSeoError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "DataForSeoError";
  }
}

/** DataForSEO "payment required" / "insufficient funds" codes (HTTP 402, 40200, 40210). */
export const isBalanceCode = (code: number | undefined) => code === 402 || code === 40200 || code === 40210;
/** Task not finished yet ("task handed", "task in queue"). */
export const isNotReadyCode = (code: number | undefined) => code === 40601 || code === 40602;

export const BALANCE_MESSAGE = "DataForSEO balance is too low to run rank checks. Add funds in your DataForSEO account; checks resume on the next sync.";

export interface DfsTask<R = unknown> {
  id: string;
  status_code: number;
  status_message: string;
  cost?: number;
  data?: Record<string, unknown> & { tag?: string; keyword?: string };
  result: R[] | null;
}

export interface DfsResponse<R> {
  status_code: number;
  status_message: string;
  tasks?: DfsTask<R>[];
}

function authHeader(secret: string) {
  return `Basic ${Buffer.from(secret, "utf8").toString("base64")}`;
}

export async function call<R>(secret: string, path: string, init: { method: "GET" | "POST"; body?: unknown }, fetchImpl: FetchLike = fetch): Promise<DfsResponse<R>> {
  let res: Response;
  try {
    res = await fetchImpl(`${dfsBase()}${path}`, {
      method: init.method,
      headers: { Authorization: authHeader(secret), "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
  } catch (e) {
    throw new DataForSeoError(`Could not reach DataForSEO (${(e as Error).name === "TimeoutError" ? "timed out" : "network error"}).`);
  }
  if (res.status === 401) throw new DataForSeoError("DataForSEO rejected the API login or password (401 unauthorized).", 401);
  if (res.status === 402) throw new DataForSeoError(BALANCE_MESSAGE, 402);
  let json: DfsResponse<R>;
  try {
    json = (await res.json()) as DfsResponse<R>;
  } catch {
    throw new DataForSeoError(`DataForSEO returned HTTP ${res.status}.`, res.status);
  }
  if (json.status_code !== 20000) {
    if (isBalanceCode(json.status_code)) throw new DataForSeoError(BALANCE_MESSAGE, json.status_code);
    if (json.status_code === 40100) throw new DataForSeoError("DataForSEO rejected the API login or password (401 unauthorized).", 401);
    throw new DataForSeoError(`DataForSEO error ${json.status_code}: ${json.status_message}`, json.status_code);
  }
  return json;
}

export interface DfsUserData {
  login: string;
  money?: { balance?: number; total?: number };
}

/** GET /v3/appendix/user_data: validates credentials and returns the login and balance. */
export async function getUserData(secret: string, fetchImpl?: FetchLike): Promise<{ login: string; balance: number | null }> {
  const r = await call<DfsUserData>(secret, "/appendix/user_data", { method: "GET" }, fetchImpl);
  const t = r.tasks?.[0];
  if (!t || t.status_code !== 20000 || !t.result?.[0]) throw new DataForSeoError(`DataForSEO error ${t?.status_code ?? r.status_code}: ${t?.status_message ?? r.status_message}`, t?.status_code);
  const u = t.result[0];
  const bal = u.money?.balance;
  return { login: u.login, balance: typeof bal === "number" && Number.isFinite(bal) ? bal : null };
}

export interface SerpTaskInput {
  keyword: string;
  location_code: number;
  language_code: string;
  device: "desktop" | "mobile";
  depth: number;
  /** Our TrackedKeyword id, echoed back in task data. */
  tag: string;
}

/** POST /v3/serp/google/organic/task_post (Standard queue). Max 100 tasks per call. */
export async function postSerpTasks(secret: string, tasks: SerpTaskInput[], fetchImpl?: FetchLike): Promise<DfsTask[]> {
  if (tasks.length > 100) throw new Error("DataForSEO accepts at most 100 tasks per request");
  const r = await call(secret, "/serp/google/organic/task_post", { method: "POST", body: tasks }, fetchImpl);
  return r.tasks ?? [];
}

/** GET /v3/serp/google/organic/tasks_ready: ids of finished, not yet collected tasks. */
export async function readySerpTaskIds(secret: string, fetchImpl?: FetchLike): Promise<Set<string>> {
  const r = await call<{ id: string }>(secret, "/serp/google/organic/tasks_ready", { method: "GET" }, fetchImpl);
  const ids = new Set<string>();
  for (const t of r.tasks ?? []) for (const x of t.result ?? []) if (x?.id) ids.add(x.id);
  return ids;
}

export interface SerpItem {
  type: string;
  rank_group?: number;
  rank_absolute?: number;
  domain?: string;
  url?: string;
}
export interface SerpResult {
  keyword?: string;
  item_types?: string[];
  items?: SerpItem[] | null;
}

/** GET /v3/serp/google/organic/task_get/regular/{id}. Returns the task (check its status_code). */
export async function getSerpTask(secret: string, id: string, fetchImpl?: FetchLike): Promise<DfsTask<SerpResult>> {
  const r = await call<SerpResult>(secret, `/serp/google/organic/task_get/regular/${encodeURIComponent(id)}`, { method: "GET" }, fetchImpl);
  const t = r.tasks?.[0];
  if (!t) throw new DataForSeoError(`DataForSEO returned no task for ${id}.`);
  return t;
}

export interface DfsLocation {
  location_code: number;
  location_name: string;
  location_code_parent: number | null;
  country_iso_code: string;
  location_type: string;
}

/** GET /v3/serp/google/locations/{country}: every Google location in one country (free). */
export async function getSerpLocations(secret: string, countryIso: string, fetchImpl?: FetchLike): Promise<DfsLocation[]> {
  if (!/^[a-z]{2}$/i.test(countryIso)) throw new Error("Country must be a two-letter ISO code");
  const r = await call<DfsLocation>(secret, `/serp/google/locations/${countryIso.toLowerCase()}`, { method: "GET" }, fetchImpl);
  const t = r.tasks?.[0];
  if (!t || t.status_code !== 20000) throw new DataForSeoError(`DataForSEO error ${t?.status_code ?? r.status_code}: ${t?.status_message ?? r.status_message}`, t?.status_code);
  return (t.result ?? []).filter((l): l is DfsLocation => !!l && typeof l.location_code === "number" && typeof l.location_name === "string");
}

// --- On-Page API (Site Auditor) ----------------------------------------------

export interface OnPageTaskInput {
  target: string;
  max_crawl_pages: number;
  load_resources: boolean;
  enable_javascript: boolean;
  calculate_keyword_density: false;
  /** Our SiteAudit id, echoed back in task data. */
  tag: string;
  /** Start from this URL (keeps the crawl on the chosen protocol and host). */
  start_url?: string;
}

/** POST /v3/on_page/task_post: starts a crawl. Returns the task (status 20100 = created) with its cost. */
export async function postOnPageTask(secret: string, task: OnPageTaskInput, fetchImpl?: FetchLike): Promise<DfsTask> {
  const r = await call(secret, "/on_page/task_post", { method: "POST", body: [task] }, fetchImpl);
  const t = r.tasks?.[0];
  if (!t) throw new DataForSeoError("DataForSEO returned no task for the crawl.");
  return t;
}

export interface OnPageSummary {
  crawl_progress?: string;
  crawl_status?: { max_crawl_pages?: number; pages_in_queue?: number; pages_crawled?: number } | null;
  crawl_stop_reason?: string | null;
  domain_info?: { checks?: Record<string, boolean | null> | null; total_pages?: number | null } | null;
  page_metrics?: { onpage_score?: number | null } | null;
}

/** On-Page task result (summary, pages, …). Throws on task-level errors except "not ready", which returns null. */
async function onPageResult<R>(secret: string, path: string, body: unknown, fetchImpl?: FetchLike): Promise<{ result: R | null; cost: number }> {
  const r = await call<R>(secret, path, body === undefined ? { method: "GET" } : { method: "POST", body: [body] }, fetchImpl);
  const t = r.tasks?.[0];
  if (!t) throw new DataForSeoError(`DataForSEO returned no task for ${path}.`);
  if (isNotReadyCode(t.status_code)) return { result: null, cost: t.cost ?? 0 };
  if (t.status_code !== 20000) throw new DataForSeoError(`DataForSEO error ${t.status_code}: ${t.status_message}`, t.status_code);
  return { result: t.result?.[0] ?? null, cost: t.cost ?? 0 };
}

/** GET /v3/on_page/summary/{id}: progress ("in_progress" | "finished") and domain-level totals. */
export function getOnPageSummary(secret: string, id: string, fetchImpl?: FetchLike) {
  return onPageResult<OnPageSummary>(secret, `/on_page/summary/${encodeURIComponent(id)}`, undefined, fetchImpl);
}

export interface OnPageList<I> { crawl_progress?: string; total_items_count?: number; items_count?: number; items?: I[] | null }

/** POST /v3/on_page/{endpoint} with { id, limit, offset, filters? }. */
export function getOnPageList<I>(secret: string, endpoint: "pages" | "non_indexable" | "links" | "redirect_chains" | "resources" | "pages_by_resource", id: string, opts: { limit: number; offset?: number; filters?: unknown[]; url?: string }, fetchImpl?: FetchLike) {
  return onPageResult<OnPageList<I>>(secret, `/on_page/${endpoint}`, { id, limit: opts.limit, offset: opts.offset ?? 0, ...(opts.url ? { url: opts.url } : {}), ...(opts.filters ? { filters: opts.filters } : {}) }, fetchImpl);
}

/** POST /v3/on_page/force_stop: stops a running crawl; pages crawled so far stay available. Free. */
export async function forceStopOnPage(secret: string, id: string, fetchImpl?: FetchLike): Promise<void> {
  const r = await call(secret, "/on_page/force_stop", { method: "POST", body: [{ id }] }, fetchImpl);
  const t = r.tasks?.[0];
  if (!t || (t.status_code !== 20000 && t.status_code !== 20100)) throw new DataForSeoError(`DataForSEO error ${t?.status_code ?? r.status_code}: ${t?.status_message ?? r.status_message}`, t?.status_code);
}

export interface LighthouseResult {
  categories?: { performance?: { score?: number | null } | null } | null;
  audits?: Record<string, { numericValue?: number | null } | undefined> | null;
  /** Set when Lighthouse couldn't test the page, e.g. { code: "ERRORED_DOCUMENT_REQUEST", message: "… (Status code: 403)" }. */
  runtimeError?: { code?: string; message?: string } | null;
}

/**
 * POST /v3/on_page/lighthouse/live/json (mobile, performance only). Returns
 * the task status as well: when Lighthouse fails (task 50301) the result still
 * carries its runtimeError, which says why (and failed tests aren't charged).
 */
export async function getLighthouse(secret: string, url: string, fetchImpl?: FetchLike): Promise<{ status: number; message: string; result: LighthouseResult | null; cost: number }> {
  const r = await call<LighthouseResult>(secret, "/on_page/lighthouse/live/json", { method: "POST", body: [{ url, for_mobile: true, categories: ["performance"] }] }, fetchImpl);
  const t = r.tasks?.[0];
  if (!t) throw new DataForSeoError("DataForSEO returned no Lighthouse task.");
  if (t.status_code === 401 || isBalanceCode(t.status_code)) throw new DataForSeoError(t.status_message, t.status_code);
  return { status: t.status_code, message: t.status_message, result: t.result?.[0] ?? null, cost: t.cost ?? 0 };
}
