import { describe, expect, it } from "vitest";
import { expectedText, partWaitSchema, partsWaitingText, summarizePartsWaiting } from "@/lib/maintenance/parts-waiting";
import { summarizeParts } from "@/lib/maintenance/parts-summary";

// Parts on order (20261120012300): the dashboard line and the form's rules.
describe("parts waiting", () => {
  const today = "2026-11-09";
  it("counts jobs, the next expected date and late parts", () => {
    const s = summarizePartsWaiting([
      { work_order_id: "a", expected_on: "2026-11-12", status: "waiting" },
      { work_order_id: "a", expected_on: "2026-11-10", status: "waiting" },
      { work_order_id: "b", expected_on: "2026-11-05", status: "waiting" },
      { work_order_id: "c", expected_on: "2026-11-01", status: "received" },
    ], today, ["d"]);
    expect(s).toEqual({ jobs: 3, parts: 3, next: "2026-11-10", late: 1 });
    expect(partsWaitingText(s)).toBe("Waiting for parts: 3, next expected Nov 10, 2026, 1 is past the expected date");
  });
  it("says plainly when nothing has a date, and nothing when nothing waits", () => {
    expect(partsWaitingText(summarizePartsWaiting([], today, ["x"]))).toBe("Waiting for parts: 1, no expected date yet");
    expect(partsWaitingText(summarizePartsWaiting([{ work_order_id: "a", expected_on: null, status: "canceled" }], today))).toBeNull();
  });
  it("words one part's expected date", () => {
    expect(expectedText(null, today)).toEqual({ text: "No expected date", late: false });
    expect(expectedText(today, today)).toEqual({ text: "Expected today", late: false });
    expect(expectedText("2026-11-01", today)).toEqual({ text: "Late: expected Nov 1, 2026", late: true });
  });
  it("needs the part, a full date and a real amount", () => {
    expect(partWaitSchema.safeParse({ description: "" }).success).toBe(false);
    expect(partWaitSchema.safeParse({ description: "Sensor", expected_on: "0026-11-12" }).success).toBe(false);
    expect(partWaitSchema.safeParse({ description: "Sensor", unit_cost: "abc" }).success).toBe(false);
    expect(partWaitSchema.parse({ description: "Sensor", quantity: "", unit_cost: "186.50", expected_on: "2026-11-12" }))
      .toMatchObject({ description: "Sensor", quantity: 1, unit_cost: 18650, expected_on: "2026-11-12", part_id: null });
  });
});

// Return to stock (20261120012600): a returned part comes off the job's parts count.
describe("parts used, less parts returned", () => {
  it("subtracts countable parts returned, and a measured part once fully returned", () => {
    const m = (kind: string, quantity: number, unit = "each", part_id = "p") => ({ work_order_id: "w", part_id, kind, quantity, unit });
    expect(summarizeParts(["w"], [m("returned", 2), m("used", -3)], null).get("w")?.parts).toBe(1);
    expect(summarizeParts(["w"], [m("used", -5, "gal", "oil"), m("returned", 5, "gal", "oil")], null).get("w")?.parts).toBe(0);
    expect(summarizeParts(["w"], [m("used", -5, "gal", "oil"), m("returned", 2, "gal", "oil")], null).get("w")?.parts).toBe(1);
    expect(summarizeParts(["w"], [], [{ work_order_id: "w", kind: "part", quantity: 3, unit_cost_cents: 1895 }, { work_order_id: "w", kind: "part", quantity: -2, unit_cost_cents: 1895 }]).get("w")?.costCents).toBe(1895);
  });
});
