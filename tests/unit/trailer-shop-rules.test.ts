import { describe, expect, it } from "vitest";
import { trailerShopBlockers } from "@/lib/optimization/plan";
import { workOrderSchema, workOrderUnit } from "@/lib/maintenance";

// The planner's trailer maintenance rule mirrors the database codes trailer_safety_restricted, trailer_shop_scheduled
// (20261115000100) and trailer_shop_work_open (a blocker since 20261120009800, owner 2026-11-09 WK1).
const trailer = { id: "t1", unit_number: "T-4" };
const visit = (p: Partial<{ trailer_id: string; number: string; scheduled_for: string | null; status: string; safety_critical: boolean; work_started_at: string | null }>) =>
  ({ trailer_id: "t1", number: "WO-2026-0001", scheduled_for: null, status: "reported", safety_critical: false, ...p });

describe("trailer shop rules", () => {
  it("blocks a safety-critical trailer on any day and a shop visit only on its day", () => {
    expect(trailerShopBlockers({ trailerShopVisits: [visit({ safety_critical: true })] }, "2026-10-20", trailer)).toHaveLength(1);
    const scheduled = { trailerShopVisits: [visit({ scheduled_for: "2026-10-20", status: "scheduled" })] };
    expect(trailerShopBlockers(scheduled, "2026-10-20", trailer)).toEqual(["Trailer T-4 is in the shop on this date (WO-2026-0001)."]);
    expect(trailerShopBlockers(scheduled, "2026-10-21", trailer)).toEqual([]);
  });

  it("blocks a trailer with shop work in progress or waiting for parts on any day", () => {
    for (const status of ["in_progress", "awaiting_parts"]) {
      expect(trailerShopBlockers({ trailerShopVisits: [visit({ status })] }, "2026-12-01", trailer)).toEqual(["Trailer T-4 is in the shop (WO-2026-0001): work is in progress or waiting for parts."]);
    }
  });

  it("does not block a trailer whose job waits for a part and has not started (MD1, 20261120015000)", () => {
    expect(trailerShopBlockers({ trailerShopVisits: [visit({ status: "awaiting_parts", work_started_at: null })] }, "2026-12-01", trailer)).toEqual([]);
    expect(trailerShopBlockers({ trailerShopVisits: [visit({ status: "awaiting_parts", work_started_at: "2026-11-30T10:00:00Z" })] }, "2026-12-01", trailer)).toHaveLength(1);
  });

  it("ignores other trailers, work waiting for inspection, and missing data", () => {
    expect(trailerShopBlockers({ trailerShopVisits: [visit({ trailer_id: "t2", safety_critical: true })] }, "2026-10-20", trailer)).toEqual([]);
    expect(trailerShopBlockers({ trailerShopVisits: [visit({ scheduled_for: "2026-10-20", status: "awaiting_inspection" })] }, "2026-10-20", trailer)).toEqual([]);
    expect(trailerShopBlockers({}, "2026-10-20", trailer)).toEqual([]);
  });
});

describe("work order unit", () => {
  const id = "3f8f1a2e-3b1c-4c2d-9e7a-1b2c3d4e5f60";
  const base = { title: "Air leak", description: "", category: "repair", urgency: "normal" };
  it("needs exactly one truck or trailer", () => {
    expect(workOrderSchema.safeParse({ ...base, truck_id: id }).success).toBe(true);
    expect(workOrderSchema.safeParse({ ...base, trailer_id: id }).success).toBe(true);
    expect(workOrderSchema.safeParse({ ...base }).error?.issues[0].message).toBe("Choose a truck or a trailer.");
    expect(workOrderSchema.safeParse({ ...base, truck_id: id, trailer_id: id }).error?.issues[0].message).toMatch(/not both/);
  });

  it("names the unit", () => {
    const trucks = new Map([["a", "12"]]);
    const trailers = new Map([["b", "T-4"]]);
    expect(workOrderUnit({ truck_id: "a" }, trucks, trailers)).toBe("Truck 12");
    expect(workOrderUnit({ truck_id: null, trailer_id: "b" }, trucks, trailers)).toBe("Trailer T-4");
    expect(workOrderUnit({ truck_id: "x" }, trucks, trailers)).toBe("Truck –");
  });
});
