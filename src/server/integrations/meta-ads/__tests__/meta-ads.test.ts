import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { classifyMetaError, createMetaAdsAdapter, metaCampaignBudget, parseInsights, pickAction } from "../adapter";
import { decimalToMinor } from "../../common";

const config = { appId: "123", appSecret: "shh", apiVersion: "v26.0", loginConfigId: null };

function mockFetch(handler: (url: URL) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fn = async (u: string, init?: RequestInit) => {
    const url = new URL(u);
    calls.push({ url, init });
    const { status = 200, body, headers = {} } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  };
  return { fn, calls };
}

describe("money parsing", () => {
  it("converts decimal strings exactly", () => {
    expect(decimalToMinor("12.34")).toBe(1234);
    expect(decimalToMinor("12.345")).toBe(1235);
    expect(decimalToMinor("12.344")).toBe(1234);
    expect(decimalToMinor("0.1")).toBe(10);
    expect(decimalToMinor("1,234.5")).toBe(123450);
    expect(decimalToMinor("-0.5")).toBe(-50);
    expect(decimalToMinor("")).toBe(0);
    expect(decimalToMinor(undefined)).toBe(0);
  });
});

describe("Meta insights parsing", () => {
  it("uses the first preferred action type only (no double counting)", () => {
    const actions = [
      { action_type: "offsite_conversion.fb_pixel_lead", value: "4" },
      { action_type: "lead", value: "6" },
      { action_type: "link_click", value: "80" },
    ];
    expect(pickAction(actions, ["lead", "offsite_conversion.fb_pixel_lead"])).toBe(6);
    expect(pickAction(undefined, ["lead"])).toBe(0);
  });

  it("maps a daily campaign row", () => {
    const { rows, campaigns } = parseInsights([
      {
        campaign_id: "555",
        campaign_name: "Lead Gen",
        date_start: "2026-10-15",
        spend: "123.456",
        impressions: "10000",
        clicks: "150",
        reach: "8000",
        actions: [{ action_type: "lead", value: "6" }, { action_type: "omni_purchase", value: "2" }, { action_type: "purchase", value: "2" }],
        action_values: [{ action_type: "omni_purchase", value: "199.99" }],
      },
      { campaign_id: "555", date_start: "2026-10-16", spend: "0" },
    ]);
    expect(rows[0]).toEqual({ campaignExternalId: "555", date: "2026-10-15", costMinor: 12346, costIsEstimated: false, impressions: 10000, clicks: 150, reach: 8000, conversions: 8, conversionValueMinor: 19999, leads: 6 });
    expect(rows[1]).toMatchObject({ costMinor: 0, conversions: 0, leads: 0 });
    expect(campaigns).toEqual([{ externalId: "555", name: "Lead Gen", status: "UNKNOWN" }]);
  });
});

describe("Meta error classification", () => {
  const e = (code: number, extra: object = {}) => ({ error: { message: "m", type: "OAuthException", code, ...extra } });
  it("maps Graph error codes", () => {
    expect(classifyMetaError(400, e(190)).kind).toBe("AUTH_REVOKED");
    expect(classifyMetaError(400, e(17)).kind).toBe("RATE_LIMITED");
    expect(classifyMetaError(400, e(80004)).kind).toBe("RATE_LIMITED");
    expect(classifyMetaError(403, e(200)).kind).toBe("PERMISSION_DENIED");
    // App or developer account blocked by Meta: not a per-account permission loss.
    expect(classifyMetaError(403, e(200, { message: "API access blocked." })).kind).toBe("APP_BLOCKED");
    expect(classifyMetaError(400, e(1, { is_transient: true })).kind).toBe("TRANSIENT");
    expect(classifyMetaError(400, e(100)).kind).toBe("INVALID_REQUEST");
    expect(classifyMetaError(500, undefined).kind).toBe("TRANSIENT");
  });

  it("reads the wait time from usage headers", () => {
    const headers = new Headers({ "x-business-use-case-usage": JSON.stringify({ "123": [{ type: "ads_insights", estimated_time_to_regain_access: 5 }] }) });
    expect(classifyMetaError(400, e(80000), headers).retryAfterMs).toBe(300000);
  });
});

describe("Meta adapter (mocked HTTP)", () => {
  it("builds the Facebook Login URL with ads scopes", () => {
    const url = new URL(createMetaAdsAdapter({ config }).authorizationUrl("st", "https://app.example.com/cb"));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(url.searchParams.get("scope")).toBe("ads_read,business_management");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("uses a Facebook Login for Business configuration instead of scopes when set", () => {
    const url = new URL(createMetaAdsAdapter({ config: { ...config, loginConfigId: "987654" } }).authorizationUrl("st", "https://app.example.com/cb"));
    expect(url.searchParams.get("config_id")).toBe("987654");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("exchanges the code for a long-lived token", async () => {
    const m = mockFetch((url) =>
      url.searchParams.get("grant_type") === "fb_exchange_token"
        ? { body: { access_token: "LONG", token_type: "bearer", expires_in: 5184000 } }
        : { body: { access_token: "SHORT", token_type: "bearer", expires_in: 3600 } },
    );
    const t = await createMetaAdsAdapter({ config, fetch: m.fn }).exchangeCode("code", "https://app/cb");
    expect(t.accessToken).toBe("LONG");
    expect(t.refreshToken).toBeUndefined();
    expect(t.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    expect(m.calls[1].url.searchParams.get("fb_exchange_token")).toBe("SHORT");
  });

  it("signs calls with appsecret_proof and follows paging", async () => {
    const m = mockFetch((url) => {
      if (url.pathname.endsWith("/me/adaccounts")) {
        return url.searchParams.get("after")
          ? { body: { data: [{ account_id: "2", name: "B", currency: "USD", timezone_name: "America/Chicago", account_status: 101 }] } }
          : { body: { data: [{ account_id: "1", name: "A", currency: "USD", timezone_name: "America/New_York", account_status: 1 }], paging: { next: "https://graph.facebook.com/v26.0/me/adaccounts?after=X" } } };
      }
      if (url.pathname.endsWith("/me/businesses")) return { body: { data: [{ id: "biz" }] } };
      if (url.pathname.endsWith("/biz/owned_ad_accounts")) return { body: { data: [{ account_id: "1", name: "A" }] } };
      if (url.pathname.endsWith("/biz/client_ad_accounts")) return { status: 403, body: { error: { code: 200, message: "no" } } };
      return { status: 404, body: {} };
    });
    const accounts = await createMetaAdsAdapter({ config, fetch: m.fn }).listAccounts("TOKEN");
    expect(accounts.map((a) => [a.externalId, a.displayId, a.timezone, a.statusNote])).toEqual([
      ["1", "act_1", "America/New_York", undefined],
      ["2", "act_2", "America/Chicago", "Closed"],
    ]);
    const proof = createHmac("sha256", "shh").update("TOKEN").digest("hex");
    expect(m.calls.every((c) => c.url.searchParams.get("appsecret_proof") === proof)).toBe(true);
    expect((m.calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
  });

  it("requests daily campaign insights for the range", async () => {
    const m = mockFetch(() => ({ body: { data: [{ campaign_id: "9", date_start: "2026-10-01", spend: "1.00" }] } }));
    const r = await createMetaAdsAdapter({ config, fetch: m.fn }).fetchDailyPerformance("T", { externalId: "42" }, "2026-10-01", "2026-10-31");
    const u = m.calls[0].url;
    expect(u.pathname).toBe("/v26.0/act_42/insights");
    expect(u.searchParams.get("level")).toBe("campaign");
    expect(u.searchParams.get("time_increment")).toBe("1");
    expect(JSON.parse(u.searchParams.get("time_range")!)).toEqual({ since: "2026-10-01", until: "2026-10-31" });
    expect(r.rows[0].costMinor).toBe(100);
  });

  it("refuses paging links to other hosts", async () => {
    const m = mockFetch(() => ({ body: { data: [], paging: { next: "https://evil.example.com/steal" } } }));
    await expect(createMetaAdsAdapter({ config, fetch: m.fn }).listCampaigns("T", { externalId: "1" })).rejects.toMatchObject({ kind: "INVALID_REQUEST" });
  });

  it("validates a pasted system-user token", async () => {
    const m = mockFetch((url) =>
      url.pathname.endsWith("/debug_token")
        ? { body: { data: { is_valid: true, app_id: "123", expires_at: 0, scopes: ["ads_read", "business_management"] } } }
        : { body: { id: "77", name: "Pacing Bot" } },
    );
    const r = await createMetaAdsAdapter({ config, fetch: m.fn }).connectWithToken!("SYS");
    expect(r.label).toContain("Pacing Bot");
    expect(r.tokens.expiresAt).toBeUndefined(); // never expires
    expect(m.calls[0].url.searchParams.get("access_token")).toBeNull(); // app token goes in the header, not the URL
  });

  it("rejects a token without ads_read", async () => {
    const m = mockFetch(() => ({ body: { data: { is_valid: true, app_id: "123", scopes: ["pages_show_list"] } } }));
    await expect(createMetaAdsAdapter({ config, fetch: m.fn }).connectWithToken!("X")).rejects.toMatchObject({ kind: "PERMISSION_DENIED" });
  });

  it("has no refresh: tokens are re-authorized instead", () => {
    expect(createMetaAdsAdapter({ config }).refresh).toBeUndefined();
  });
});

describe("Meta ad detail for the AI assistant", () => {
  it("reads each ad's creative separately (no multi-id lookup) and keeps going when one fails", async () => {
    const urls: URL[] = [];
    const fetchFn = async (u: string) => {
      const url = new URL(u);
      urls.push(url);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.pathname.endsWith("/insights")) {
        return json(200, { data: [
          { ad_id: "1", ad_name: "Ad 1", campaign_name: "Leads", spend: "50.00", impressions: "100", clicks: "5", actions: [{ action_type: "lead", value: "2" }] },
          { ad_id: "2", ad_name: "Ad 2", campaign_name: "Leads", spend: "10.00", impressions: "50", clicks: "1" },
        ] });
      }
      if (url.pathname.endsWith("/1")) return json(200, { id: "1", creative: { title: "Book a cleaning" } });
      return json(400, { error: { message: "Unsupported get request", type: "GraphMethodException", code: 100 } });
    };
    const adapter = createMetaAdsAdapter({ config, fetch: fetchFn });
    const ads = await adapter.fetchDetail!("token", { externalId: "555", loginCustomerId: null, timezone: "UTC" }, "ads", "2026-09-01", "2026-09-30");
    expect(ads.map((a) => [a.label, a.attributes?.headline])).toEqual([["Ad 1", "Book a cleaning"], ["Ad 2", undefined]]);
    expect(urls.some((u) => u.searchParams.has("ids"))).toBe(false);
    expect(urls.filter((u) => u.searchParams.get("fields")?.startsWith("creative")).map((u) => u.pathname.split("/").pop()).sort()).toEqual(["1", "2"]);
  });
});

describe("Meta calls as conversions", () => {
  it("counts calls placed from call ads, preferring the native count, alongside leads and purchases", () => {
    const { rows } = parseInsights([
      { campaign_id: "c", campaign_name: "Brand Call only", date_start: "2026-09-10", spend: "40.00", actions: [{ action_type: "click_to_call_native_call_placed", value: "3" }, { action_type: "click_to_call_call_confirm", value: "5" }, { action_type: "lead", value: "1" }] },
      { campaign_id: "c", campaign_name: "Brand Call only", date_start: "2026-09-11", spend: "40.00", actions: [{ action_type: "click_to_call_call_confirm", value: "2" }, { action_type: "landing_page_view", value: "50" }] },
    ]);
    expect(rows.map((r) => [r.date, r.conversions, r.leads])).toEqual([["2026-09-10", 4, 1], ["2026-09-11", 2, 0]]);
  });
});

describe("Meta campaign budgets", () => {
  it("uses the campaign budget when there is one (CBO)", () => {
    expect(metaCampaignBudget({ id: "1", daily_budget: "5000" }, null)).toEqual({ budgetKind: "DAILY", dailyBudgetMinor: 5000, budgetId: "meta:1" });
    expect(metaCampaignBudget({ id: "1", lifetime_budget: "90000" }, null)).toMatchObject({ budgetKind: "LIFETIME" });
  });
  it("adds active ad set daily budgets otherwise (ABO)", () => {
    const sets = [
      { campaign_id: "1", effective_status: "ACTIVE", daily_budget: "2000" },
      { campaign_id: "1", effective_status: "ACTIVE", daily_budget: "3000" },
      { campaign_id: "1", effective_status: "PAUSED", daily_budget: "9000" },
      { campaign_id: "2", effective_status: "ACTIVE", daily_budget: "1000" },
    ];
    expect(metaCampaignBudget({ id: "1" }, sets)).toEqual({ budgetKind: "DAILY", dailyBudgetMinor: 5000, budgetId: "meta:1" });
  });
  it("treats an active lifetime ad set as no fixed daily budget, and unread ad sets as unreported", () => {
    expect(metaCampaignBudget({ id: "1" }, [{ campaign_id: "1", effective_status: "ACTIVE", lifetime_budget: "50000" }])).toMatchObject({ budgetKind: "LIFETIME" });
    expect(metaCampaignBudget({ id: "1" }, null)).toEqual({});
  });
});
