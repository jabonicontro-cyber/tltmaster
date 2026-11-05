import { describe, expect, it } from "vitest";
import { adaptWording, navLabels, vocabulary } from "@/lib/industry";
import { trailerTypesFor, truckTypesFor } from "@/lib/fleet/labels";
import { locationKindsFor } from "@/lib/routing/locations";

describe("freight wording (MK4)", () => {
  it("rewords ticket and job-site sentences for a freight carrier only", () => {
    expect(adaptWording("1 delivered load without a ticket", "freight")).toBe("1 delivered load without a BOL");
    expect(adaptWording("Missing delivery tickets", "freight")).toBe("Missing bills of lading");
    expect(adaptWording("Tickets to review", "freight")).toBe("BOLs to review");
    expect(adaptWording("No paper / scale ticket number was entered", "freight")).toBe("No BOL number was entered");
    expect(adaptWording("Median wait at job sites", "freight")).toBe("Median wait at delivery locations");
    expect(adaptWording("Job site directions", "freight")).toBe("Delivery location directions");
    expect(adaptWording("Job site / materials", "freight")).toBe("Delivery location / commodities");
    expect(adaptWording("Tickets to review", "aggregate")).toBe("Tickets to review");
    expect(adaptWording("Tickets to review", "both")).toBe("Tickets to review");
    expect(adaptWording("Tickets to review", undefined)).toBe("Tickets to review");
  });
  it("names the pricing page and documents for each industry", () => {
    expect(navLabels("freight")).toEqual({ "/tickets": "Bills of Lading", "/materials": "Rates & Charges" });
    expect(navLabels("aggregate")["/materials"]).toBe("Materials & Pricing");
    expect(vocabulary("freight").Site).toBe("Delivery location");
  });
  it("offers freight equipment and places to freight carriers, and keeps a unit's current type", () => {
    expect(truckTypesFor("freight")).toEqual(["tractor", "straight_truck", "other"]);
    expect(truckTypesFor("freight", "tri_axle_dump")).toContain("tri_axle_dump");
    expect(truckTypesFor("aggregate")).not.toContain("straight_truck");
    expect(trailerTypesFor("freight")).toEqual(["dry_van", "reefer", "flatbed", "step_deck", "lowboy", "other"]);
    expect(trailerTypesFor("aggregate")).not.toContain("reefer");
    expect(trailerTypesFor("both")).toContain("reefer");
    expect(trailerTypesFor("both")).toContain("end_dump");
    expect(locationKindsFor("freight")).toEqual(["yard", "terminal", "shipper", "receiver", "warehouse", "other"]);
    expect(locationKindsFor("aggregate")).not.toContain("shipper");
  });
});
