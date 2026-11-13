import { describe, expect, it } from "vitest";
import { callLead } from "../callrail-lead";
import { buildAiContext } from "../ai-context";

describe("CallRail lead sentence", () => {
  it("describes the change, first-time callers and missed calls from the figures", () => {
    expect(callLead({ "callrail.calls": 142, "callrail.firstTimeCallers": 61, "callrail.missed": 9 }, { "callrail.calls": 120 })).toBe("Calls rose 18% (120 → 142), 61 from first-time callers. 9 were missed (6%).");
    expect(callLead({ "callrail.calls": 100, "callrail.firstTimeCallers": 40, "callrail.missed": 0 }, { "callrail.calls": 98 })).toBe("Calls held steady at 100, 40 from first-time callers.");
    expect(callLead({ "callrail.calls": null }, null)).toBe("No CallRail calls for this period yet.");
  });
});

describe("AI context: CallRail", () => {
  const base = { clientName: "A", currency: "USD", isDemo: false, rangeLabel: "Last 30 days", range: { from: "2026-10-01", to: "2026-10-30" }, comparison: null, kpis: [], totals: { costMinor: 0, impressions: 0, clicks: 0, conversions: 0, conversionValueMinor: 0, leads: 0, hasEstimatedCost: false }, previous: null, accounts: [], campaigns: [], pacing: null, notes: [] } as unknown as Parameters<typeof buildAiContext>[0];
  it("lists call figures with the no-double-counting rule, or says CallRail isn't connected", () => {
    const web = { analytics: null, channels: [], search: null, rankings: null, calls: { totals: [{ label: "Calls", value: "42", previous: "30", changePct: 40 }], sources: [{ source: "Google Ads", calls: { label: "Calls", value: "20", previous: null, changePct: null }, firstTime: { label: "First-time callers", value: "12", previous: null, changePct: null }, qualified: { label: "Qualified calls", value: "5", previous: null, changePct: null } }], fromAds: { current: 25, previous: 18 } } };
    const out = buildAiContext({ ...base, web });
    expect(out).toContain("## Phone calls (CallRail call tracking");
    expect(out).toContain("Calls CallRail traced to paid ads: 25; comparison 18");
    expect(out).toContain("never add CallRail calls to ad conversions");
    expect(buildAiContext({ ...base, web: { ...web, calls: null } })).toContain("CallRail call tracking is not connected");
  });
});
