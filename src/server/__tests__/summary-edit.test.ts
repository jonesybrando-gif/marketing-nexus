import { describe, expect, it } from "vitest";
import { parseSummaryEdit } from "../exec-summary";
import { summaryAsText } from "@/lib/exec-summary";

describe("editing the executive summary", () => {
  it("trims, caps steps at three and keeps notes", () => {
    const r = parseSummaryEdit({ takeaway: "  Leads rose. ", happened: "x", meaning: "y", recommendations: ["a", "", "b", "c", "d"], nextSteps: [], notes: "New landing page live Nov 3.\r\n" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.takeaway).toBe("Leads rose.");
      expect(r.summary.recommendations).toEqual(["a", "b", "c"]);
      expect(r.notes).toBe("New landing page live Nov 3.");
    }
    expect(parseSummaryEdit({ takeaway: " ", happened: "", meaning: "", notes: "" }).ok).toBe(false);
    expect(parseSummaryEdit(null).ok).toBe(false);
  });

  it("puts the team's update under the takeaway in copies", () => {
    const text = summaryAsText({ takeaway: "Leads rose.", happened: "H.", meaning: "M.", recommendations: [], nextSteps: [], notes: "Office closed Nov 11." }, "Head");
    expect(text).toBe("Head\n\nLeads rose.\n\nUpdates from our team\nOffice closed Nov 11.\n\nWhat happened?\nH.\n\nWhat does this mean?\nM.");
  });
});
