import { describe, expect, it } from "vitest";
import { reasonKey, toBoardPlan, type LoadPlan } from "@/lib/dispatch/smart";

// The board sends exclusions grouped by reason (P8: one row per excluded unit per load made the page 10.7 MB).
const plan = (trucks: Array<[string, string[]]>, drivers: Array<[string, string[]]>): LoadPlan => ({
  load: {} as LoadPlan["load"], priority: { rank: 1, reasons: [] }, proposal: null, alternatives: [], blocked: null, rejectedPairs: 0, notes: [],
  excludedTrucks: trucks.map(([label, reasons], i) => ({ id: `t${i}`, label, reasons })),
  excludedDrivers: drivers.map(([label, reasons], i) => ({ id: `d${i}`, label, reasons })),
});

describe("board plan", () => {
  it("drops unit-specific details from the reason so the same cause groups together", () => {
    expect(reasonKey("Out of service (expected back 2026-10-14).")).toBe("Out of service.");
    expect(reasonKey("Safety-critical work order WO-2026-0002 is open — the truck returns only through clearance in Maintenance."))
      .toBe("Safety-critical work order is open — the truck returns only through clearance in Maintenance.");
    expect(reasonKey("In the shop on this date (WO-2026-0007).")).toBe("In the shop on this date.");
    expect(reasonKey("Its insurance expired 2026-09-24 (verified) — x")).toBe("Its insurance has expired (verified) — x");
    expect(reasonKey("Proposed for O-2026-0014 load 3, which is more urgent or earlier.")).toBe("Proposed for a more urgent or earlier load.");
  });

  it("counts every unit per reason, names a few, and keeps the totals", () => {
    const p = toBoardPlan(plan(
      [["101", ["Out of service (expected back 2026-10-14)."]], ["102", ["Out of service."]], ["103", ["Out of service.", "Capacity unknown."]]],
      [["Ann", ["No DOT medical card is recorded for this driver."]]],
    ), 2);
    expect(p.excluded).toEqual({
      trucks: 3, drivers: 1,
      groups: [
        { kind: "truck", reason: "Out of service.", count: 3, examples: ["101", "102"] },
        { kind: "truck", reason: "Capacity unknown.", count: 1, examples: ["103"] },
        { kind: "driver", reason: "No DOT medical card is recorded for this driver.", count: 1, examples: ["Ann"] },
      ],
    });
    expect("excludedTrucks" in p).toBe(false);
  });
});
