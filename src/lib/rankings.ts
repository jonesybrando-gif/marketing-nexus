// Pure helpers for DataForSEO rank tracking, shared by the setup page (client
// and server) and the sync code. No DB or network access here.

/** Most tracked items (keyword × location × device) checked daily per client. */
export const MAX_KEYWORDS_PER_CLIENT = 500;
/**
 * Fallback DataForSEO Standard-queue price per keyword check (Google organic).
 * The live value comes from config: serpCheckPriceUsd() in
 * src/server/data-sources/dataforseo/pricing.ts (DATAFORSEO_SERP_PRICE_USD).
 */
export const DEFAULT_SERP_CHECK_PRICE_USD = 0.0006;
export const DEFAULT_LOCATION_CODE = 2840;
export const DEFAULT_LOCATION_NAME = "United States";
export const DEFAULT_LANGUAGE_CODE = "en";
/** New rank projects default to mobile: most local searches are on phones. */
export const DEFAULT_DEVICE: RankDeviceSetting = "mobile";

export type RankDevice = "desktop" | "mobile";
export type RankDeviceSetting = RankDevice | "both";

/**
 * Client-level defaults (DataAsset.settings of the RANK_PROJECT). They only
 * pre-fill the add-keywords panel: every TrackedKeyword carries its own
 * location and device.
 */
export interface RankProjectSettings {
  locationCode: number;
  locationName?: string;
  languageCode: string;
  device: RankDeviceSetting;
  searchEngine: "google";
}

export const DEVICE_OPTIONS: { value: RankDeviceSetting; label: string }[] = [
  { value: "desktop", label: "Desktop" },
  { value: "mobile", label: "Mobile" },
  { value: "both", label: "Desktop and mobile" },
];

export const devicesFor = (d: RankDeviceSetting): RankDevice[] => (d === "both" ? ["desktop", "mobile"] : [d]);

/**
 * Common DataForSEO (= Google Ads geo target) location codes. Any other code
 * from DataForSEO's locations list can be entered by hand.
 */
export const COMMON_LOCATIONS: { group: string; items: { code: number; name: string }[] }[] = [
  { group: "Country", items: [{ code: 2840, name: "United States" }] },
  {
    group: "States",
    items: [
      { code: 21133, name: "Alabama" }, { code: 21132, name: "Alaska" }, { code: 21136, name: "Arizona" }, { code: 21135, name: "Arkansas" },
      { code: 21137, name: "California" }, { code: 21138, name: "Colorado" }, { code: 21139, name: "Connecticut" }, { code: 21141, name: "Delaware" },
      { code: 21140, name: "District of Columbia" }, { code: 21142, name: "Florida" }, { code: 21143, name: "Georgia" }, { code: 21144, name: "Hawaii" },
      { code: 21146, name: "Idaho" }, { code: 21147, name: "Illinois" }, { code: 21148, name: "Indiana" }, { code: 21145, name: "Iowa" },
      { code: 21149, name: "Kansas" }, { code: 21150, name: "Kentucky" }, { code: 21151, name: "Louisiana" }, { code: 21154, name: "Maine" },
      { code: 21153, name: "Maryland" }, { code: 21152, name: "Massachusetts" }, { code: 21155, name: "Michigan" }, { code: 21156, name: "Minnesota" },
      { code: 21158, name: "Mississippi" }, { code: 21157, name: "Missouri" }, { code: 21159, name: "Montana" }, { code: 21162, name: "Nebraska" },
      { code: 21166, name: "Nevada" }, { code: 21163, name: "New Hampshire" }, { code: 21164, name: "New Jersey" }, { code: 21165, name: "New Mexico" },
      { code: 21167, name: "New York" }, { code: 21160, name: "North Carolina" }, { code: 21161, name: "North Dakota" }, { code: 21168, name: "Ohio" },
      { code: 21169, name: "Oklahoma" }, { code: 21170, name: "Oregon" }, { code: 21171, name: "Pennsylvania" }, { code: 21172, name: "Rhode Island" },
      { code: 21173, name: "South Carolina" }, { code: 21174, name: "South Dakota" }, { code: 21175, name: "Tennessee" }, { code: 21176, name: "Texas" },
      { code: 21177, name: "Utah" }, { code: 21179, name: "Vermont" }, { code: 21178, name: "Virginia" }, { code: 21180, name: "Washington" },
      { code: 21183, name: "West Virginia" }, { code: 21182, name: "Wisconsin" }, { code: 21184, name: "Wyoming" },
    ],
  },
  {
    group: "Cities",
    items: [
      { code: 1015254, name: "Atlanta, Georgia" }, { code: 1026201, name: "Austin, Texas" }, { code: 1016367, name: "Chicago, Illinois" },
      { code: 1026339, name: "Dallas, Texas" }, { code: 1026481, name: "Houston, Texas" }, { code: 1013962, name: "Los Angeles, California" },
      { code: 1015116, name: "Miami, Florida" }, { code: 1023191, name: "New York, New York" }, { code: 1013462, name: "Phoenix, Arizona" },
      { code: 1014218, name: "San Diego, California" }, { code: 1014221, name: "San Francisco, California" }, { code: 1027744, name: "Seattle, Washington" },
    ],
  },
];

const LOCATION_NAME = new Map(COMMON_LOCATIONS.flatMap((g) => g.items.map((i) => [i.code, i.name] as const)));
/** Display name for a code from the built-in list, else "Location <code>". Prefer a stored locationName. */
export const locationName = (code: number): string => LOCATION_NAME.get(code) ?? `Location ${code}`;

/** "Dublin,California,United States" → "Dublin, California, United States" (DataForSEO joins parts with bare commas). */
export function formatLocationName(dfsName: string): string {
  return dfsName.split(",").map((p) => p.trim()).filter(Boolean).join(", ");
}

/** Short label for tables: drops a trailing "United States" (most clients are US), keeps the rest. */
export function shortLocationName(name: string | null | undefined, code?: number): string {
  const n = name?.trim() || (code ? locationName(code) : "");
  if (n === "United States") return n;
  return n.replace(/,\s*United States$/, "");
}

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** Countries offered in the location search (DataForSEO loads one country's list at a time). */
export const LOCATION_COUNTRIES: { iso: string; name: string }[] = [
  { iso: "US", name: "United States" }, { iso: "CA", name: "Canada" }, { iso: "GB", name: "United Kingdom" }, { iso: "IE", name: "Ireland" },
  { iso: "AU", name: "Australia" }, { iso: "NZ", name: "New Zealand" }, { iso: "MX", name: "Mexico" }, { iso: "DE", name: "Germany" },
  { iso: "FR", name: "France" }, { iso: "ES", name: "Spain" }, { iso: "IN", name: "India" },
];

/** A DataForSEO location as the search returns it. */
export interface RankLocationOption {
  code: number;
  /** Display form, e.g. "Dublin, California, United States". */
  name: string;
  /** DataForSEO type: "City", "County", "DMA Region", "State", "Postal Code", "Country", … */
  type: string;
  countryIso: string;
}

/** Bare host of a domain or URL: lowercase, no protocol/path/port, no leading "www.". "" if invalid. */
export function normalizeDomain(input: string): string {
  let s = (input ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\/\//, "");
  s = s.split(/[/?#]/)[0].replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  s = s.replace(/^www\d?\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : "";
}

/** True when `host` (domain or URL) is the target domain, its www form, or any subdomain of it. */
export function domainMatches(host: string, target: string): boolean {
  const h = normalizeDomain(host);
  const t = normalizeDomain(target);
  if (!h || !t) return false;
  return h === t || h.endsWith(`.${t}`);
}

/** One keyword per line (commas also split); trimmed, lowercased, whitespace-collapsed, de-duplicated. */
export function parseKeywordList(text: string): string[] {
  const out = new Set<string>();
  for (const raw of (text ?? "").split(/[\n\r,]+/)) {
    const k = raw.replace(/\s+/g, " ").trim().toLowerCase();
    if (k && k.length <= 200) out.add(k);
  }
  return [...out];
}

/**
 * Cost of checking `items` tracked items (keyword × location × device) once a
 * day at `pricePerCheck` USD: per day and per 30-day month.
 */
export function rankCostEstimate(items: number, pricePerCheck = DEFAULT_SERP_CHECK_PRICE_USD): { checksPerDay: number; perDay: number; perMonth: number } {
  const checksPerDay = Math.max(0, items);
  const perDay = checksPerDay * pricePerCheck;
  return { checksPerDay, perDay, perMonth: perDay * 30 };
}

/** How many tracked items `keywords` keywords make on `device` ("both" = two each). */
export const trackedItemCount = (keywords: number, device: RankDeviceSetting) => keywords * devicesFor(device).length;

export function readRankSettings(raw: unknown): RankProjectSettings & { pendingTasks: PendingRankTask[]; taskErrors: RankTaskError[] } {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const device = s.device === "mobile" || s.device === "both" || s.device === "desktop" ? s.device : DEFAULT_DEVICE;
  const loc = Number(s.locationCode);
  const code = Number.isInteger(loc) && loc > 0 ? loc : DEFAULT_LOCATION_CODE;
  return {
    locationCode: code,
    locationName: typeof s.locationName === "string" && s.locationName ? s.locationName : code === DEFAULT_LOCATION_CODE ? DEFAULT_LOCATION_NAME : locationName(code),
    languageCode: typeof s.languageCode === "string" && s.languageCode ? s.languageCode : DEFAULT_LANGUAGE_CODE,
    device,
    searchEngine: "google",
    pendingTasks: Array.isArray(s.pendingTasks) ? (s.pendingTasks as PendingRankTask[]) : [],
    taskErrors: Array.isArray(s.taskErrors) ? (s.taskErrors as RankTaskError[]) : [],
  };
}

/** A posted DataForSEO task waiting to be collected (kept in DataAsset.settings.pendingTasks). */
export interface PendingRankTask {
  id: string;
  keywordId: string;
  /** Local date (asset time zone) the check counts for. */
  date: string;
  postedAt: string;
}

export interface RankTaskError { keyword: string; message: string; at: string }
