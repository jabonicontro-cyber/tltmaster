import { describe, expect, it } from "vitest";
import { shiftProblem, type SmartShift } from "@/lib/dispatch/smart";

// The Smart Dispatch / Plan the day shift rule mirrors private.driver_shift_problem (20261120003300).

const shift = (date: string, start: string, end: string, label = "6:00 AM–4:30 PM"): SmartShift => ({ driver_id: "d1", date, status: "shift", start_at: start, end_at: end, label });
const off = (date: string): SmartShift => ({ driver_id: "d1", date, status: "off", start_at: null, end_at: null, label: "" });
const none = (date: string): SmartShift => ({ driver_id: "d1", date, status: "none", start_at: null, end_at: null, label: "" });
const load = (starts: string | null, ends: string | null, date = "2026-10-27") => ({ load_date: date, starts_at: starts, ends_at: ends });

describe("shiftProblem", () => {
  const day = [none("2026-10-26"), shift("2026-10-27", "2026-10-27T11:00:00Z", "2026-10-27T21:30:00Z")];
  it("passes a load inside the shift and refuses one before or after it", () => {
    expect(shiftProblem("d1", load("2026-10-27T13:00:00Z", "2026-10-27T15:00:00Z"), day)).toBeNull();
    expect(shiftProblem("d1", load("2026-10-27T10:00:00Z", "2026-10-27T12:00:00Z"), day)).toBe("Not on shift: works 6:00 AM–4:30 PM on Tue, Oct 27");
    expect(shiftProblem("d1", load("2026-10-27T21:00:00Z", "2026-10-27T22:00:00Z"), day)).toMatch(/^Not on shift/);
  });
  it("a day off refuses; no schedule and other drivers are not checked", () => {
    expect(shiftProblem("d1", load("2026-10-27T13:00:00Z", "2026-10-27T14:00:00Z"), [none("2026-10-26"), off("2026-10-27")])).toBe("Day off on Tue, Oct 27");
    expect(shiftProblem("d1", load("2026-10-27T13:00:00Z", "2026-10-27T14:00:00Z"), [none("2026-10-26"), none("2026-10-27")])).toBeNull();
    expect(shiftProblem("d2", load("2026-10-27T13:00:00Z", "2026-10-27T14:00:00Z"), day)).toBeNull();
    expect(shiftProblem("d1", load("2026-10-27T13:00:00Z", "2026-10-27T14:00:00Z"), undefined)).toBeNull();
  });
  it("the previous evening's overnight shift covers an early load; a date-only load needs a shift that day", () => {
    const nights = [shift("2026-10-26", "2026-10-27T01:00:00Z", "2026-10-27T11:00:00Z", "8:00 PM–6:00 AM"), off("2026-10-27")];
    expect(shiftProblem("d1", load("2026-10-27T08:00:00Z", "2026-10-27T10:00:00Z"), nights)).toBeNull();
    expect(shiftProblem("d1", load(null, null), day)).toBeNull();
    expect(shiftProblem("d1", load(null, null), nights)).toBe("Day off on Tue, Oct 27");
  });
});
