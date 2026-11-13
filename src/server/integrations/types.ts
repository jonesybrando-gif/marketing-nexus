import type { Platform } from "@prisma/client";
import type { IsoDate } from "@/lib/pacing/dates";

/**
 * Contract every advertising-platform integration implements. Adding a
 * platform = implementing this interface and registering it in registry.ts;
 * the sync runner, pacing engine and reports do not change.
 */
export interface PlatformAdapter {
  /** The platform of the ad accounts this adapter syncs. */
  platform: Platform;
  /**
   * The platform of the login (PlatformConnection) this adapter uses. Usually
   * the same; Local Services Ads reuse a Google Ads connection.
   */
  connectionPlatform: Platform;
  /** True when the server has the credentials this integration needs. */
  isConfigured(): boolean;
  /** Build the OAuth consent URL for this platform. */
  authorizationUrl(state: string, redirectUri: string): string;
  /** Exchange an OAuth code for tokens (caller encrypts and stores them). */
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens>;
  /**
   * Use a refresh token to get a fresh access token. Platforms without
   * refresh tokens (Meta) omit this; their tokens are re-authorized instead.
   */
  refresh?(refreshToken: string): Promise<OAuthTokens>;
  /**
   * Connect with a pasted long-lived token instead of OAuth (e.g. a Meta
   * Business Manager system-user token). Validates it and returns a label.
   */
  connectWithToken?(token: string): Promise<{ label: string; tokens: OAuthTokens }>;
  /** Account platforms that can be linked from this connection's accounts (Google Ads → Google Ads + LSA). */
  linkablePlatforms: Platform[];
  /** Accounts the authorized login can reach (e.g. every customer under a Google Ads MCC). */
  listAccounts(accessToken: string): Promise<RemoteAccount[]>;
  listCampaigns(accessToken: string, account: AccountRef): Promise<RemoteCampaign[]>;
  /**
   * Daily leaf-level performance for [from, to] in the account's own timezone.
   * Returns one row per campaign per day (or per account per day when the
   * platform has no campaign granularity), never pre-aggregated totals.
   * Days with no activity may be absent; absent means zero.
   */
  fetchDailyPerformance(accessToken: string, account: AccountRef, from: IsoDate, to: IsoDate): Promise<DailyPerformanceResult>;
  /**
   * Read-only detail below campaign level for one date range, fetched live for
   * the AI assistant (never stored): ads, ad headlines and descriptions,
   * keywords or search terms. Kinds the platform doesn't have are omitted.
   */
  detailKinds?: DetailKind[];
  fetchDetail?(accessToken: string, account: AccountRef, kind: DetailKind, from: IsoDate, to: IsoDate): Promise<DetailRow[]>;
  /** Largest date range requested at once (default 92 days). */
  maxRangeDays?: number;
  /**
   * Last local date whose numbers are complete enough to pace on. The
   * dashboard never paces past this date.
   */
  dataCompleteThrough(accountTimezone: string, now: Date): IsoDate;
  /** Days re-fetched on every sync because the platform restates recent data (e.g. late conversions). */
  restatementWindowDays: number;
  /** Days of history imported when an account is first connected. */
  initialBackfillDays: number;
  /** Whether cost from this platform is verified billed spend. */
  spendIsVerified: boolean;
}

export interface DailyPerformanceResult {
  rows: RemoteDailyRow[];
  campaigns: RemoteCampaign[];
  /**
   * Set when the adapter can tell whether this response carried verified
   * spend (false e.g. when LSA leads were charged but no cost was reported).
   */
  spendVerified?: boolean;
}

export interface AccountRef {
  externalId: string;
  /**
   * Platform-specific parent id: the Google Ads manager id sent as
   * login-customer-id, or the Microsoft Advertising CustomerId.
   */
  loginCustomerId?: string | null;
  timezone?: string | null;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string;
}

export interface RemoteAccount {
  externalId: string;
  name: string;
  currency: string;
  timezone: string;
  isManager: boolean;
  isTestAccount?: boolean;
  /** Parent id needed to reach this account (see AccountRef.loginCustomerId). */
  loginCustomerId?: string;
  /** Human-facing id, e.g. "123-456-7890" or "act_123". */
  displayId?: string;
  /** Platform account status, if not active (shown in the account picker). */
  statusNote?: string;
  level?: number;
}

export interface RemoteCampaign {
  externalId: string;
  name: string;
  status: "ENABLED" | "PAUSED" | "REMOVED" | "UNKNOWN";
  /** Daily budget in minor units; only when budgetKind is "DAILY". */
  dailyBudgetMinor?: number;
  /**
   * How the campaign is budgeted, when the adapter reports it: "DAILY" (a daily
   * amount, possibly shared — see budgetId) or "LIFETIME" (a total for a date
   * range, no fixed daily amount). Undefined = the adapter doesn't report budgets.
   */
  budgetKind?: "DAILY" | "LIFETIME";
  /** Identifies the budget; campaigns sharing one budget have the same id, so it is counted once. */
  budgetId?: string;
}

export interface RemoteDailyRow {
  campaignExternalId: string | null;
  date: IsoDate;
  costMinor: number;
  costIsEstimated: boolean;
  impressions: number;
  clicks: number;
  reach?: number;
  conversions: number;
  conversionValueMinor: number;
  leads?: number;
}

export type DetailKind = "ads" | "headlines" | "keywords" | "search_terms";

/** One ad, ad text asset, keyword or search term with its totals for the range. */
export interface DetailRow {
  /** The thing itself: ad name or headline, keyword, search term. */
  label: string;
  /** Where it runs, e.g. "Campaign › Ad group". */
  context: string;
  /** Extra facts such as match type, asset type, Google's performance label, or the ad's text. */
  attributes?: Record<string, string>;
  costMinor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValueMinor?: number;
  leads?: number;
}
