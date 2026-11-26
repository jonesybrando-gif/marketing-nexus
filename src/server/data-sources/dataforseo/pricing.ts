import "server-only";
import { DEFAULT_SERP_CHECK_PRICE_USD } from "@/lib/rankings";
import { DEFAULT_ONPAGE_RATES, type OnPageRates } from "@/lib/site-audit/cost";

// DataForSEO prices used for estimates, in one place. Override with env vars
// when DataForSEO changes its pricing; the account's actual charges are read
// from each API response (task `cost`) where we record spend.

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
}

/** Standard-queue Google organic SERP check (one tracked item, once). */
export const serpCheckPriceUsd = () => envNumber("DATAFORSEO_SERP_PRICE_USD", DEFAULT_SERP_CHECK_PRICE_USD);

/** On-Page crawl and Lighthouse rates for Site Auditor estimates. */
export const onPageRates = (): OnPageRates => ({
  basicPerPage: envNumber("DATAFORSEO_ONPAGE_PAGE_PRICE_USD", DEFAULT_ONPAGE_RATES.basicPerPage),
  loadResourcesFactor: envNumber("DATAFORSEO_ONPAGE_RESOURCES_FACTOR", DEFAULT_ONPAGE_RATES.loadResourcesFactor),
  javascriptFactor: envNumber("DATAFORSEO_ONPAGE_JS_FACTOR", DEFAULT_ONPAGE_RATES.javascriptFactor),
  lighthousePerUrl: envNumber("DATAFORSEO_LIGHTHOUSE_PRICE_USD", DEFAULT_ONPAGE_RATES.lighthousePerUrl),
});
