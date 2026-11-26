import "server-only";
import { DEFAULT_SERP_CHECK_PRICE_USD } from "@/lib/rankings";

// DataForSEO prices used for estimates, in one place. Override with env vars
// when DataForSEO changes its pricing; the account's actual charges are read
// from each API response (task `cost`) where we record spend.

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
}

/** Standard-queue Google organic SERP check (one tracked item, once). */
export const serpCheckPriceUsd = () => envNumber("DATAFORSEO_SERP_PRICE_USD", DEFAULT_SERP_CHECK_PRICE_USD);
