import { describe, expect, it } from "vitest";
import { INDUSTRIES, industryOf, navLabels, vocabulary } from "@/lib/industry";

// Industry profile (MK1): the words follow what a company hauls; anything unknown or missing reads as aggregate.
describe("industry profile", () => {
  it("defaults to aggregate for companies from before the setting, and for anything unknown", () => {
    expect(industryOf(undefined)).toBe("aggregate");
    expect(industryOf("trains")).toBe("aggregate");
    expect(INDUSTRIES.map(industryOf)).toEqual(["aggregate", "freight", "both"]);
  });

  it("names the delivery documents the way each kind of hauler does", () => {
    expect(vocabulary("aggregate")).toMatchObject({ documents: "Delivery Tickets", document: "Ticket", enter: "Enter ticket", one: "ticket", many: "tickets" });
    expect(vocabulary("freight")).toMatchObject({ documents: "Bills of Lading", document: "BOL", enter: "Enter BOL", one: "BOL", many: "BOLs" });
    expect(vocabulary("freight").description).toContain("bills of lading");
    // Plain punctuation in everything people read.
    for (const i of ["aggregate", "freight", "both"]) expect(JSON.stringify(vocabulary(i))).not.toContain("\u2014");
    expect(vocabulary("both").documents).toBe("Tickets and BOLs");
    expect(navLabels("freight")).toEqual({ "/tickets": "Bills of Lading" });
  });
});
