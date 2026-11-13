import { describe, expect, it } from "vitest";
import { resolveAccountScope } from "../client-report";
import { shortChangeWords } from "@/lib/change";

const acc = (id: string, currency = "USD") => ({ id, currency });

describe("resolveAccountScope", () => {
  it("adds up every account by default, without restricting the query", () => {
    const s = resolveAccountScope([acc("a"), acc("b"), acc("c")], "USD", undefined);
    expect(s).toMatchObject({ filtered: false, ids: null, currency: "USD", otherCurrency: [] });
    expect(s.accounts.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });
  it("narrows to the picked accounts and ignores unknown ids", () => {
    const s = resolveAccountScope([acc("a"), acc("b")], "USD", "b,zzz");
    expect(s).toMatchObject({ filtered: true, ids: ["b"] });
    expect(resolveAccountScope([acc("a")], "USD", "zzz")).toMatchObject({ filtered: false, ids: null });
  });
  it("never adds different currencies together", () => {
    const s = resolveAccountScope([acc("a"), acc("b", "EUR")], "USD", undefined);
    expect(s).toMatchObject({ ids: ["a"], currency: "USD" });
    expect(s.otherCurrency.map((a) => a.id)).toEqual(["b"]);
    // Picking only the EUR account reports it in EUR.
    expect(resolveAccountScope([acc("a"), acc("b", "EUR")], "USD", "b")).toMatchObject({ ids: ["b"], currency: "EUR", otherCurrency: [] });
  });
});

describe("shortChangeWords", () => {
  it("is short and readable", () => {
    expect(shortChangeWords("better", 93.4, "previous period")).toBe("↑ 93% vs. previous period");
    expect(shortChangeWords("worse", -33, "previous month")).toBe("↓ 33% vs. previous month");
    expect(shortChangeWords("same", 2, "previous period")).toBe("— No significant change");
    expect(shortChangeWords("few", 50, "previous period")).toBe("— Too few to compare");
    expect(shortChangeWords(null, null, "previous period")).toBe("");
  });
});
