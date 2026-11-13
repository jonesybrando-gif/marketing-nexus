import { describe, expect, it } from "vitest";
import { budgetLeft, buildSimpleRows, classifySimplePacing, formatSignedMoney, prioritySort, type LineInput, type SimpleRow } from "../simple";

const $ = (m: number) => `$${(m / 100).toLocaleString("en-US")}`;
const st = (budget: number | null, spend: number | null, f: number | null) => classifySimplePacing({ budgetMinor: budget, spendMinor: spend, elapsedFraction: f }, $);

describe("classifySimplePacing", () => {
  it("is on pace within ±10% of expected", () => {
    // $4,000 budget, half the month gone → expected $2,000; $1,940 is 3% below
    const s = st(400000, 194000, 0.5);
    expect(s.status).toBe("ON_PACE");
    expect(s.tone).toBe("green");
    expect(s.message).toBe("On pace — spending is 3% below expected.");
  });
  it("flags overspending and underspending beyond 10%", () => {
    expect(st(400000, 248000, 0.5)).toMatchObject({ status: "OVERSPENDING", tone: "amber", message: "Overspending — 24% above expected pace." });
    expect(st(400000, 164000, 0.5)).toMatchObject({ status: "UNDERSPENDING", tone: "amber", message: "Underspending — 18% below expected pace." });
  });
  it("treats exactly 10% as on pace", () => {
    expect(st(100000, 55000, 0.5).status).toBe("ON_PACE");
    expect(st(100000, 45000, 0.5).status).toBe("ON_PACE");
  });
  it("is red once spend passes the monthly budget, whatever the pace", () => {
    expect(st(200000, 227500, 1)).toMatchObject({ status: "OVER_BUDGET", tone: "red", message: "Over budget — $275 over monthly budget." });
    expect(st(0, 500, 0.5).status).toBe("OVER_BUDGET");
  });
  it("never treats missing data as zero spend", () => {
    expect(st(400000, null, 0.5)).toMatchObject({ status: "UNKNOWN", tone: "gray" });
  });
  it("handles the start of the month, zero budgets and no budget safely", () => {
    expect(st(400000, 0, 0).status).toBe("UNKNOWN");
    expect(st(400000, 0, null).status).toBe("UNKNOWN");
    expect(st(0, 0, 0.5).status).toBe("UNKNOWN");
    expect(st(null, 1000, 0.5).status).toBe("UNKNOWN");
  });
});

describe("budget left formatting", () => {
  it("subtracts and writes negatives as -$275", () => {
    expect(budgetLeft({ budgetMinor: 400000, spendMinor: 145000 })).toBe(255000);
    expect(budgetLeft({ budgetMinor: 400000, spendMinor: null })).toBeNull();
    expect(formatSignedMoney(-27500, $)).toBe("-$275");
    expect(formatSignedMoney(0, $)).toBe("$0");
  });
});

const line = (o: Partial<LineInput>): LineInput => ({
  key: "b1", clientId: "c1", clientName: "Amazon Cleaning", level: "ACCOUNT", platforms: ["GOOGLE_ADS"], accountIds: ["a1"], currency: "USD",
  budgetMinor: 400000, spendMinor: 145000, elapsedDays: 15, totalDays: 30, asOf: "2026-11-15",
  notConnected: false, hasAccounts: true, stale: false, disconnected: false, spendUnverified: false, ...o,
});

describe("buildSimpleRows", () => {
  it("gives each client/platform its own row", () => {
    const rows = buildSimpleRows([line({}), line({ key: "b2", platforms: ["META_ADS"], accountIds: ["a2"], budgetMinor: 150000, spendMinor: 48000 })], () => 0.5);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.platforms[0]).sort()).toEqual(["GOOGLE_ADS", "META_ADS"]);
    expect(rows.every((r) => r.edit?.kind === "revise")).toBe(true);
  });
  it("adds two accounts on one platform without double counting, and sends edits to the client's budgets", () => {
    const rows = buildSimpleRows([line({}), line({ key: "b2", accountIds: ["a2"], budgetMinor: 100000, spendMinor: 50000 })], () => 0.5);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ budgetMinor: 500000, spendMinor: 195000, edit: null });
    expect(rows[0].editNote).toMatch(/more than one budget/);
  });
  it("keeps unbudgeted spend out of Budget Used but flags it", () => {
    const rows = buildSimpleRows([line({}), line({ key: "unbudgeted:a2", level: "UNBUDGETED", accountIds: ["a2"], budgetMinor: null, spendMinor: 9999 })], () => 0.5);
    expect(rows[0].spendMinor).toBe(145000);
    expect(rows[0].warning).toMatch(/no budget/);
  });
  it("lets a budget be added for a single unbudgeted account", () => {
    const [r] = buildSimpleRows([line({ key: "unbudgeted:a1", level: "UNBUDGETED", budgetMinor: null, spendMinor: 30000, elapsedDays: null, totalDays: null })], () => 0.4);
    expect(r).toMatchObject({ budgetMinor: null, spendMinor: 30000, elapsedFraction: 0.4, edit: { kind: "create", accountId: "a1" } });
  });
  it("shows no spend (not $0) for a budget with no synced account", () => {
    const [r] = buildSimpleRows([line({ notConnected: true, spendMinor: 0 })], () => 0.5);
    expect(r.spendMinor).toBeNull();
    expect(r.warning).toBeTruthy();
  });
  it("keeps a combined client budget as one row listing its platforms", () => {
    const [r] = buildSimpleRows([line({ level: "CLIENT", platforms: ["GOOGLE_ADS", "META_ADS"], accountIds: ["a1", "a2"] })], () => 0.5);
    expect(r.platforms).toEqual(["GOOGLE_ADS", "META_ADS"]);
    expect(r.edit).toEqual({ kind: "revise", budgetId: "b1" });
  });
  it("flags stale and disconnected data", () => {
    expect(buildSimpleRows([line({ stale: true })], () => 0.5)[0].warning).toMatch(/out of date/);
    expect(buildSimpleRows([line({ disconnected: true })], () => 0.5)[0].warning).toMatch(/disconnected/);
  });
});

describe("prioritySort", () => {
  const row = (key: string, clientName: string, budget: number, spend: number, platform: SimpleRow["platforms"][number] = "GOOGLE_ADS"): SimpleRow => ({
    key, clientId: key, clientName, platforms: [platform], currency: "USD", budgetMinor: budget, spendMinor: spend, elapsedFraction: 0.5, asOf: null, warning: null, edit: null, editNote: null,
  });
  it("orders over budget, overspending, underspending, on pace, unknown; then by size of variance; then by name", () => {
    const rows = [
      row("on", "Alpha", 1000, 500),
      row("under", "Bravo", 1000, 300),
      row("over2", "Charlie", 1000, 700),
      row("over1", "Delta", 1000, 900),
      row("ob", "Echo", 1000, 1100),
      { ...row("x", "Aaron", 1000, 0), spendMinor: null },
      row("on2", "Able", 1000, 500),
    ];
    const s = prioritySort(rows, (r) => classifySimplePacing(r, $), (r) => r.platforms[0]);
    expect(s.map((r) => r.key)).toEqual(["ob", "over1", "over2", "under", "on2", "on", "x"]);
  });
});
