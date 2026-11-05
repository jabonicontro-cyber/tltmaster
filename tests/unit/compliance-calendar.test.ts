import { describe, expect, it } from "vitest";
import { buildCalendar, dueState, nextIftaDeadline, type CalendarInput } from "@/lib/fleet/compliance-calendar";

// Compliance calendar (CC1): every recorded due date in one list, soonest first; nothing without a date; inactive
// equipment and archived documents left out; the IFTA quarter only for companies that keep trip sheets.
const today = "2026-11-05";
const base: CalendarInput = {
  today,
  drivers: [{ id: "d1", name: "Ana Driver" }],
  quals: [
    { id: "q1", driver_id: "d1", kind: "medical_card", expires_on: "2026-11-20" },
    { id: "q2", driver_id: "d1", kind: "cdl", expires_on: "2029-01-01" }, // beyond the horizon
    { id: "q3", driver_id: "gone", kind: "cdl", expires_on: "2026-11-10" }, // not an active driver
  ],
  docs: [
    { id: "doc1", truck_id: "t1", trailer_id: null, kind: "registration", title: "", expires_on: "2026-10-30", archived_at: null },
    { id: "doc2", truck_id: null, trailer_id: "r1", kind: "inspection", title: "Annual inspection", expires_on: "2027-01-15", archived_at: null },
    { id: "doc3", truck_id: "t1", trailer_id: null, kind: "insurance", title: "", expires_on: "2026-11-06", archived_at: "2026-11-01" },
    { id: "doc4", truck_id: "t2", trailer_id: null, kind: "permit", title: "", expires_on: "2026-11-06", archived_at: null }, // inactive truck
  ],
  trucks: [{ id: "t1", unit_number: "101" }, { id: "t2", unit_number: "102", active: false }],
  trailers: [{ id: "r1", unit_number: "T-7" }],
  service: [{ schedule_id: "s1", truck_id: "t1", unit_number: "101", name: "Oil change", next_due_on: "2026-12-01" }, { schedule_id: "s2", truck_id: "t1", unit_number: "101", name: "Miles only", next_due_on: null }],
  ifta: true,
};

describe("compliance calendar", () => {
  it("lists overdue and upcoming dates soonest first, with what, for whom and where to go", () => {
    const items = buildCalendar(base);
    expect(items.map((i) => [i.due, i.what, i.subject])).toEqual([
      ["2026-10-30", "Registration expires", "Truck 101"],
      ["2026-11-20", "Medical card expires", "Ana Driver"],
      ["2026-12-01", "Oil change due", "Truck 101"],
      ["2027-01-15", "Annual inspection expires", "Trailer T-7"],
      ["2027-01-31", "IFTA return for Q4 2026 due", "Company"],
    ]);
    expect(items[0].href).toBe("/fleet/trucks/t1");
    expect(items[1].href).toBe("/fleet/drivers/d1");
  });

  it("leaves out fuel tax when the company keeps no trip sheets, and service when the person can't see maintenance", () => {
    const items = buildCalendar({ ...base, ifta: false, service: null });
    expect(items.some((i) => i.kind === "ifta" || i.kind === "service")).toBe(false);
  });

  it("knows the IFTA deadlines and how urgent a date is", () => {
    expect(nextIftaDeadline("2026-04-30")).toEqual({ due: "2026-04-30", quarter: "Q1 2026" });
    expect(nextIftaDeadline("2026-05-01")).toEqual({ due: "2026-07-31", quarter: "Q2 2026" });
    expect(nextIftaDeadline("2026-12-31")).toEqual({ due: "2027-01-31", quarter: "Q4 2026" });
    expect(dueState("2026-11-04", today)).toBe("overdue");
    expect(dueState("2026-12-05", today)).toBe("soon");
    expect(dueState("2026-12-06", today)).toBe("later");
  });
});
