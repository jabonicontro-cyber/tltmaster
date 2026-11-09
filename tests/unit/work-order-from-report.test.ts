import { describe, expect, it } from "vitest";
import { reportTitle, workOrderFromReport } from "@/lib/maintenance-triage";

// A work order drafted from a driver report (first-day review 2026-11-09): the driver's words, and suggestions from the
// report's own kind and text that the person creating the work order checks and changes.
describe("work order from a driver report", () => {
  it("uses the driver's words for the title and description", () => {
    const d = workOrderFromReport({ kind: "equipment_issue", description: "Air hissing near the rear axle when parked. Brakes still feel normal." }, "Equipment problem");
    expect(d.title).toBe("Air hissing near the rear axle when parked");
    expect(d.description).toBe("Air hissing near the rear axle when parked. Brakes still feel normal.");
    expect(d.category).toBe("brakes");
    expect(d.safety_critical).toBe(true);
    expect(d.urgency).toBe("high");
    expect(d.reasons.length).toBeGreaterThan(0);
  });
  it("a breakdown suggests safety-critical and at least high urgency, with the reason", () => {
    const d = workOrderFromReport({ kind: "breakdown", description: "Truck lost power on the haul road." }, "Breakdown");
    expect(d.safety_critical).toBe(true);
    expect(["high", "immediate"]).toContain(d.urgency);
    expect(d.reasons.join(" ")).toMatch(/breakdown/);
  });
  it("a minor problem is not flagged", () => {
    const d = workOrderFromReport({ kind: "equipment_issue", description: "Driver seat cushion is torn." }, "Equipment problem");
    expect(d.safety_critical).toBe(false);
    expect(d.urgency).toBe("normal");
    expect(d.category).toBe("body");
  });
  it("keeps titles short and falls back to the kind", () => {
    expect(reportTitle("", "Breakdown")).toBe("Breakdown");
    const long = reportTitle("The left rear marker light on the trailer flickers whenever the road gets rough and then goes out completely", "x");
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith("…")).toBe(true);
  });
});
