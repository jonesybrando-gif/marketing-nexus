import { describe, expect, it } from "vitest";
import { dailyPerformanceQuery, formatCustomerId, microsToMinor, normalizeCustomerId, parseCampaigns, parseCustomerClients, parseDailyPerformance, unitsToMinor } from "../gaql";
import { classifyGoogleAdsError } from "../client";
import { createGoogleAdsAdapter } from "../adapter";
import { withRetry, IntegrationError } from "../../errors";

const config = { clientId: "cid", clientSecret: "secret", developerToken: "devtok", apiVersion: "v26" };

interface Call { url: string; init?: RequestInit }
function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fn, calls };
}

describe("GAQL helpers", () => {
  it("normalizes customer ids", () => {
    expect(normalizeCustomerId("123-456-7890")).toBe("1234567890");
    expect(normalizeCustomerId("customers/1234567890")).toBe("1234567890");
    expect(formatCustomerId("1234567890")).toBe("123-456-7890");
    expect(() => normalizeCustomerId("12345")).toThrow();
    expect(() => normalizeCustomerId("1234567890; DROP")).toThrow();
  });

  it("converts micros to cents exactly", () => {
    expect(microsToMinor("1230000")).toBe(123); // $1.23
    expect(microsToMinor("5000")).toBe(1); // half a cent rounds up
    expect(microsToMinor("4999")).toBe(0);
    expect(microsToMinor("123456789012345678")).toBe(12345678901235); // beyond float precision of micros
    expect(microsToMinor(undefined)).toBe(0);
    expect(unitsToMinor(42.5)).toBe(4250);
  });

  it("only builds date queries from valid ISO dates", () => {
    expect(dailyPerformanceQuery("2026-10-01", "2026-10-16")).toContain("segments.date BETWEEN '2026-10-01' AND '2026-10-16'");
    expect(() => dailyPerformanceQuery("2026-10-01' OR '1'='1", "2026-10-16")).toThrow();
    expect(() => dailyPerformanceQuery("2026-10-16", "2026-10-01")).toThrow();
  });

  it("parses the customer hierarchy", () => {
    const accounts = parseCustomerClients(
      [
        { customerClient: { id: "1111111111", descriptiveName: "Agency MCC", currencyCode: "USD", timeZone: "America/New_York", manager: true, level: "0" } },
        { customerClient: { id: "2222222222", descriptiveName: "ABC Plumbing", currencyCode: "USD", timeZone: "America/Chicago", manager: false, level: "1" } },
      ],
      "1111111111",
    );
    expect(accounts[0]).toMatchObject({ externalId: "1111111111", isManager: true, loginCustomerId: undefined });
    expect(accounts[1]).toMatchObject({ externalId: "2222222222", name: "ABC Plumbing", timezone: "America/Chicago", loginCustomerId: "1111111111", level: 1 });
  });

  it("parses daily performance with omitted zero metrics and sums duplicate keys", () => {
    const { rows, campaigns } = parseDailyPerformance([
      { campaign: { id: "9", name: "Search", status: "ENABLED" }, segments: { date: "2026-10-01" }, metrics: { costMicros: "12340000", impressions: "1000", clicks: "50", conversions: 2.5, conversionsValue: 300.75 } },
      { campaign: { id: "9", name: "Search", status: "ENABLED" }, segments: { date: "2026-10-01" }, metrics: { costMicros: "10000" } },
      { campaign: { id: "8", name: "Old", status: "REMOVED" }, segments: { date: "2026-10-02" }, metrics: {} },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ campaignExternalId: "9", date: "2026-10-01", costMinor: 1235, costIsEstimated: false, impressions: 1000, clicks: 50, conversions: 2.5, conversionValueMinor: 30075 });
    expect(rows[1]).toMatchObject({ campaignExternalId: "8", costMinor: 0, clicks: 0 });
    expect(campaigns.find((c) => c.externalId === "8")?.status).toBe("REMOVED");
  });

  it("parses campaigns with budgets", () => {
    expect(parseCampaigns([{ campaign: { id: "1", name: "A", status: "PAUSED" }, campaignBudget: { id: "77", amountMicros: "50000000", period: "DAILY" } }, { campaign: { id: "2", status: "WEIRD" } }])).toEqual([
      { externalId: "1", name: "A", status: "PAUSED", dailyBudgetMinor: 5000, budgetKind: "DAILY", budgetId: "google:77" },
      { externalId: "2", name: "Campaign 2", status: "UNKNOWN" },
    ]);
  });

  it("keeps the budget id for shared budgets and never reads a total-period budget as daily", () => {
    const [a, b, total] = parseCampaigns([
      { campaign: { id: "1" }, campaignBudget: { id: "9", amountMicros: "30000000", period: "DAILY" } },
      { campaign: { id: "2" }, campaignBudget: { id: "9", amountMicros: "30000000", period: "DAILY" } },
      { campaign: { id: "3" }, campaignBudget: { id: "10", amountMicros: "900000000", period: "CUSTOM_PERIOD" } },
    ]);
    expect(a.budgetId).toBe(b.budgetId);
    expect(total).toMatchObject({ budgetKind: "LIFETIME" });
    expect(total.dailyBudgetMinor).toBeUndefined();
  });
});

describe("Google Ads error classification", () => {
  const failure = (code: Record<string, string>, extra: object = {}) => ({
    error: {
      code: 403,
      message: "The caller does not have permission",
      status: "PERMISSION_DENIED",
      details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: [{ errorCode: code, message: "detail message", ...extra }] }],
    },
  });

  it("maps known error codes", () => {
    expect(classifyGoogleAdsError(403, failure({ authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" })).kind).toBe("NOT_APPROVED");
    expect(classifyGoogleAdsError(403, failure({ authorizationError: "USER_PERMISSION_DENIED" })).kind).toBe("PERMISSION_DENIED");
    const q = classifyGoogleAdsError(429, failure({ quotaError: "RESOURCE_EXHAUSTED" }, { details: { quotaErrorDetails: { retryDelay: "30s" } } }));
    expect(q.kind).toBe("RATE_LIMITED");
    expect(q.retryAfterMs).toBe(30000);
    expect(q.retryable).toBe(true);
  });

  it("falls back to HTTP status, including errors inside a searchStream array", () => {
    expect(classifyGoogleAdsError(503, undefined).kind).toBe("TRANSIENT");
    expect(classifyGoogleAdsError(401, { error: { message: "expired" } }).kind).toBe("AUTH_REVOKED");
    expect(classifyGoogleAdsError(400, [{ error: { message: "bad query" } }]).kind).toBe("INVALID_REQUEST");
  });
});

describe("Google Ads adapter (mocked HTTP)", () => {
  it("builds an offline-access consent URL for the adwords scope", () => {
    const url = new URL(createGoogleAdsAdapter({ config }).authorizationUrl("st", "https://app.example.com/cb"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("select_account consent"); // pick the Google login every time
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("sends developer-token and login-customer-id headers to searchStream", async () => {
    const m = mockFetch(() => ({ body: [{ results: [{ campaign: { id: "5", name: "C" }, segments: { date: "2026-10-01" }, metrics: { costMicros: "1000000" } }] }] }));
    const adapter = createGoogleAdsAdapter({ config, fetch: m.fn });
    const res = await adapter.fetchDailyPerformance("tok", { externalId: "222-222-2222", loginCustomerId: "111-111-1111" }, "2026-10-01", "2026-10-01");
    expect(res.rows[0].costMinor).toBe(100);
    const { url, init } = m.calls[0];
    expect(url).toBe("https://googleads.googleapis.com/v26/customers/2222222222/googleAds:searchStream");
    const h = init!.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok");
    expect(h["developer-token"]).toBe("devtok");
    expect(h["login-customer-id"]).toBe("1111111111");
    expect(JSON.parse(init!.body as string).query).toContain("FROM campaign");
  });

  it("expands manager hierarchies and lists each account once, preferring direct access", async () => {
    const m = mockFetch((url) => {
      if (url.endsWith("customers:listAccessibleCustomers")) return { body: { resourceNames: ["customers/1111111111", "customers/2222222222"] } };
      if (url.includes("/customers/1111111111/")) {
        return { body: [{ results: [
          { customerClient: { id: "1111111111", descriptiveName: "MCC", manager: true, level: "0" } },
          { customerClient: { id: "2222222222", descriptiveName: "Client A", manager: false, level: "1" } },
          { customerClient: { id: "3333333333", descriptiveName: "Client B", manager: false, level: "1" } },
        ] }] };
      }
      return { body: [{ results: [{ customerClient: { id: "2222222222", descriptiveName: "Client A", manager: false, level: "0" } }] }] };
    });
    const accounts = await createGoogleAdsAdapter({ config, fetch: m.fn }).listAccounts("tok");
    expect(accounts.map((a) => a.externalId)).toEqual(["2222222222", "3333333333", "1111111111"]);
    expect(accounts.find((a) => a.externalId === "2222222222")!.loginCustomerId).toBeUndefined(); // direct
    expect(accounts.find((a) => a.externalId === "3333333333")!.loginCustomerId).toBe("1111111111");
  });

  it("classifies a revoked refresh token", async () => {
    const m = mockFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }));
    await expect(createGoogleAdsAdapter({ config, fetch: m.fn }).refresh!("rt")).rejects.toMatchObject({ kind: "AUTH_REVOKED" });
    expect(m.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(String(m.calls[0].init!.body)).toContain("grant_type=refresh_token");
  });

  it("surfaces an unapproved developer token", async () => {
    const m = mockFetch(() => ({ status: 403, body: { error: { code: 403, details: [{ errors: [{ errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" }, message: "The developer token is only approved for use with test accounts." }] }] } } }));
    await expect(createGoogleAdsAdapter({ config, fetch: m.fn }).listCampaigns("tok", { externalId: "2222222222" })).rejects.toMatchObject({ kind: "NOT_APPROVED" });
  });

  it("treats yesterday as complete only after 3am account time", () => {
    const a = createGoogleAdsAdapter({ config });
    // 2026-10-17 06:30 UTC = 02:30 in New York → day before yesterday
    expect(a.dataCompleteThrough("America/New_York", new Date("2026-10-17T06:30:00Z"))).toBe("2026-10-15");
    // 2026-10-17 08:30 UTC = 04:30 in New York → yesterday
    expect(a.dataCompleteThrough("America/New_York", new Date("2026-10-17T08:30:00Z"))).toBe("2026-10-16");
  });

  it("works without a developer token (retired by Google) and omits the header", async () => {
    const m = mockFetch(() => ({ body: [] }));
    const adapter = createGoogleAdsAdapter({ config: { ...config, developerToken: null }, fetch: m.fn });
    await adapter.fetchDailyPerformance("tok", { externalId: "2222222222" }, "2026-10-01", "2026-10-01");
    const h = m.calls[0].init!.headers as Record<string, string>;
    expect(h).not.toHaveProperty("developer-token");
    expect(h).not.toHaveProperty("login-customer-id");
  });

  it("is configured with just the OAuth client; the token is optional", async () => {
    const { googleAdsConfig, missingGoogleAdsEnv } = await import("../config");
    expect(missingGoogleAdsEnv({ GOOGLE_ADS_CLIENT_ID: "a", GOOGLE_ADS_CLIENT_SECRET: "b" } as unknown as NodeJS.ProcessEnv)).toEqual([]);
    expect(googleAdsConfig({ GOOGLE_ADS_CLIENT_ID: "a", GOOGLE_ADS_CLIENT_SECRET: "b" } as unknown as NodeJS.ProcessEnv)?.developerToken).toBeNull();
    expect(googleAdsConfig({ GOOGLE_ADS_CLIENT_ID: "a", GOOGLE_ADS_CLIENT_SECRET: "b", GOOGLE_ADS_DEVELOPER_TOKEN: "t" } as unknown as NodeJS.ProcessEnv)?.developerToken).toBe("t");
  });

  it("refuses to run without server credentials", async () => {
    await expect(createGoogleAdsAdapter({ config: null }).listAccounts("t")).rejects.toMatchObject({ kind: "NOT_CONFIGURED" });
  });
});

describe("withRetry", () => {
  it("retries rate limits and transient errors, honoring retryAfter", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const result = await withRetry(
      async () => {
        n++;
        if (n === 1) throw new IntegrationError("RATE_LIMITED", "slow down", 5000);
        if (n === 2) throw new IntegrationError("TRANSIENT", "503");
        return "ok";
      },
      { sleep: async (ms) => void sleeps.push(ms), baseDelayMs: 100 },
    );
    expect(result).toBe("ok");
    expect(sleeps[0]).toBeGreaterThanOrEqual(5000);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry permanent errors and stops after the attempt limit", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new IntegrationError("PERMISSION_DENIED", "no"); }, { sleep: async () => {} })).rejects.toMatchObject({ kind: "PERMISSION_DENIED" });
    expect(n).toBe(1);
    n = 0;
    await expect(withRetry(async () => { n++; throw new IntegrationError("TRANSIENT", "x"); }, { attempts: 3, sleep: async () => {} })).rejects.toMatchObject({ kind: "TRANSIENT" });
    expect(n).toBe(3);
  });
});

describe("OAuth client misconfiguration", () => {
  it("reports a rejected OAuth client as a configuration problem", async () => {
    const m = mockFetch(() => ({ status: 401, body: { error: "invalid_client", error_description: "The OAuth client was not found." } }));
    await expect(createGoogleAdsAdapter({ config, fetch: m.fn }).refresh!("rt")).rejects.toMatchObject({ kind: "NOT_CONFIGURED" });
  });
});

describe("Local Services Ads (via Google Ads API)", () => {
  it("splits LOCAL_SERVICES campaigns between the two platforms", async () => {
    const { campaignsQuery } = await import("../gaql");
    expect(dailyPerformanceQuery("2026-10-01", "2026-10-02")).toContain("campaign.advertising_channel_type != 'LOCAL_SERVICES'");
    expect(dailyPerformanceQuery("2026-10-01", "2026-10-02", "LOCAL_SERVICES")).toContain("campaign.advertising_channel_type = 'LOCAL_SERVICES'");
    expect(campaignsQuery("LOCAL_SERVICES")).toContain("= 'LOCAL_SERVICES'");
  });

  const leadRows = [
    { localServicesLead: { id: "1", campaign: "customers/2222222222/campaigns/77", leadType: "PHONE_CALL", leadCharged: true, creationDateTime: "2026-10-15 09:12:00" } },
    { localServicesLead: { id: "2", campaign: "customers/2222222222/campaigns/77", leadType: "MESSAGE", leadCharged: false, creationDateTime: "2026-10-15 15:00:00" } },
    { localServicesLead: { id: "3", leadType: "BOOKING", leadCharged: true, creationDateTime: "2026-10-16 08:00:00" } },
    { localServicesLead: { id: "4", leadCharged: true, creationDateTime: "2026-09-01 08:00:00" } }, // outside range
  ];

  function lsaFetch(costMicros: string | undefined, rejectDateFilter = false) {
    const queries: string[] = [];
    const fn = async (_url: string, init?: RequestInit) => {
      const q: string = JSON.parse(String(init!.body)).query;
      queries.push(q);
      if (q.includes("FROM local_services_lead")) {
        if (rejectDateFilter && q.includes("WHERE")) {
          return new Response(JSON.stringify({ error: { code: 400, details: [{ errors: [{ errorCode: { queryError: "PROHIBITED_FIELD_IN_WHERE_CLAUSE" }, message: "not filterable" }] }] } }), { status: 400 });
        }
        return new Response(JSON.stringify([{ results: leadRows }]));
      }
      const metrics = costMicros ? { costMicros } : {};
      return new Response(JSON.stringify([{ results: [{ campaign: { id: "77", name: "LSA – Plumbing", status: "ENABLED" }, segments: { date: "2026-10-15" }, metrics }] }]));
    };
    return { fn, queries };
  }

  it("adds leads (all) and charged leads (as conversions) per day", async () => {
    const m = lsaFetch("150000000");
    const a = createGoogleAdsAdapter({ config, fetch: m.fn, localServices: true });
    expect(a.platform).toBe("GOOGLE_LSA");
    expect(a.connectionPlatform).toBe("GOOGLE_ADS");
    const r = await a.fetchDailyPerformance("tok", { externalId: "2222222222" }, "2026-10-15", "2026-10-16");
    const day15 = r.rows.find((x) => x.date === "2026-10-15")!;
    const day16 = r.rows.find((x) => x.date === "2026-10-16")!;
    expect(day15).toMatchObject({ campaignExternalId: "77", costMinor: 15000, leads: 2, conversions: 1 });
    // lead without a campaign is attributed to the only LSA campaign
    expect(day16).toMatchObject({ campaignExternalId: "77", costMinor: 0, leads: 1, conversions: 1 });
    expect(r.spendVerified).toBe(true);
    expect(m.queries[1]).toContain("local_services_lead.creation_date_time >= '2026-10-15 00:00:00'");
  });

  it("marks spend unverified when leads were charged but no cost was reported", async () => {
    const r = await createGoogleAdsAdapter({ config, fetch: lsaFetch(undefined).fn, localServices: true }).fetchDailyPerformance("tok", { externalId: "2222222222" }, "2026-10-15", "2026-10-16");
    expect(r.rows.reduce((s, x) => s + x.costMinor, 0)).toBe(0);
    expect(r.spendVerified).toBe(false);
  });

  it("falls back to client-side date filtering if the API rejects it", async () => {
    const m = lsaFetch("1000000", true);
    const r = await createGoogleAdsAdapter({ config, fetch: m.fn, localServices: true }).fetchDailyPerformance("tok", { externalId: "2222222222" }, "2026-10-15", "2026-10-16");
    expect(m.queries.filter((q) => q.includes("local_services_lead"))).toHaveLength(2);
    expect(r.rows.reduce((s, x) => s + (x.leads ?? 0), 0)).toBe(3); // the September lead is excluded
  });

  it("regular Google Ads mode never queries leads", async () => {
    const m = lsaFetch("1000000");
    const r = await createGoogleAdsAdapter({ config, fetch: m.fn }).fetchDailyPerformance("tok", { externalId: "2222222222" }, "2026-10-15", "2026-10-16");
    expect(m.queries).toHaveLength(1);
    expect(r.spendVerified).toBeUndefined();
  });
});

describe("Google code exchange", () => {
  it("reports a bad sign-in code as such, not as revoked access", async () => {
    const fn = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }), { status: 400 });
    await expect(createGoogleAdsAdapter({ config, fetch: fn }).exchangeCode("bad", "https://app/cb")).rejects.toMatchObject({ kind: "INVALID_REQUEST" });
  });
});
