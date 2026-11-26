// Cost estimate for one crawl and the agency's monthly cap. Rates are passed
// in (server config: src/server/data-sources/dataforseo/pricing.ts) so tests
// and UI use the same numbers.

export interface OnPageRates {
  /** Basic crawl, per page (USD). */
  basicPerPage: number;
  /** Multiplier when page resources are loaded (images, scripts, styles: needed for broken-resource and page-size checks). */
  loadResourcesFactor: number;
  /** Multiplier with JavaScript rendering on. */
  javascriptFactor: number;
  /** Lighthouse test, per URL. */
  lighthousePerUrl: number;
}

/**
 * Rates (DataForSEO, Nov 2026). Basic $0.00015/page and Lighthouse $0.005 are
 * from the account's price list; loading resources measured 3× basic on a live
 * crawl ($0.0225 charged up front for 50 pages); JavaScript rendering ≈ 10× is
 * DataForSEO's published reference, not yet measured here.
 */
export const DEFAULT_ONPAGE_RATES: OnPageRates = { basicPerPage: 0.00015, loadResourcesFactor: 3, javascriptFactor: 10, lighthousePerUrl: 0.005 };

export interface AuditCostInput {
  maxPages: number;
  enableJs: boolean;
  loadResources?: boolean;
  /** Lighthouse tests to run (0 = off, 1 = homepage, up to 6 = homepage + 5 top pages). */
  lighthouseUrls: number;
}

/**
 * Worst-case cost of one crawl: every allowed page crawled. JavaScript
 * rendering includes loading resources, so the larger factor applies, not both.
 */
export function estimateAuditCost(input: AuditCostInput, rates: OnPageRates = DEFAULT_ONPAGE_RATES): number {
  const resources = input.loadResources === false ? 1 : rates.loadResourcesFactor;
  const factor = input.enableJs ? Math.max(rates.javascriptFactor, resources) : resources;
  const crawl = Math.max(0, input.maxPages) * rates.basicPerPage * factor;
  return round4(crawl + Math.max(0, input.lighthouseUrls) * rates.lighthousePerUrl);
}

export const lighthouseUrlCount = (mode: string) => (mode === "homepage" ? 1 : mode === "top_pages" ? 6 : 0);

export interface CapCheck {
  allowed: boolean;
  /** Spent (or committed) this month before this crawl. */
  spent: number;
  cap: number;
  /** Left after this crawl if it runs. */
  remaining: number;
  reason?: string;
}

/** Whether a crawl costing `estimate` fits under the agency's monthly cap given what this month's crawls already cost. */
export function checkCostCap(spentThisMonth: number, estimate: number, cap: number): CapCheck {
  const spent = round4(spentThisMonth);
  if (spent + estimate > cap + 1e-9) {
    return {
      allowed: false,
      spent,
      cap,
      remaining: round4(cap - spent),
      reason: `This crawl (about $${estimate.toFixed(2)}) would take this month's site audit spend to $${(spent + estimate).toFixed(2)}, over the agency cap of $${cap.toFixed(2)}.`,
    };
  }
  return { allowed: true, spent, cap, remaining: round4(cap - spent - estimate) };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
