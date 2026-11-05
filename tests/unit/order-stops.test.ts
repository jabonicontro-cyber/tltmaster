// Stops on an order (MK2 slice 1): the editor's checks match the database rules, and the summaries read well.
import { describe, expect, it } from "vitest";
import { appointmentText, emptyStop, routeLine, stopAddress, stopProblems, stopsSummary, type StopInput } from "@/lib/orders/stops";

const stop = (kind: "pickup" | "delivery", over: Partial<StopInput> = {}): StopInput => ({ ...emptyStop(kind), name: kind === "pickup" ? "Acme Steel" : "Lakeside Build", ...over });

describe("stopProblems", () => {
  it("accepts an empty list and a pickup followed by deliveries", () => {
    expect(stopProblems([])).toEqual([]);
    expect(stopProblems([stop("pickup"), stop("delivery"), stop("delivery")])).toEqual([]);
    expect(stopProblems([stop("pickup"), stop("pickup"), stop("delivery")])).toEqual([]);
  });

  it("needs a pickup first and a delivery last", () => {
    expect(stopProblems([stop("delivery"), stop("pickup")])).toEqual(["The first stop must be a pickup.", "The last stop must be a delivery."]);
    expect(stopProblems([stop("pickup")])).toContain("The last stop must be a delivery.");
  });

  it("needs a place name on every stop", () => {
    expect(stopProblems([stop("pickup", { name: "  " }), stop("delivery")])).toEqual(["Stop 1: enter the place name."]);
  });

  it("checks the appointment date and window like the database", () => {
    expect(stopProblems([stop("pickup", { appointment_date: "0026-11-05" }), stop("delivery")])[0]).toMatch(/^Stop 1: Enter a full date/);
    expect(stopProblems([stop("pickup", { appointment_date: "2026-11-05", window_start: "08:00" }), stop("delivery")])).toEqual(["Stop 1: enter both window times or neither."]);
    expect(stopProblems([stop("pickup", { appointment_date: "2026-11-05", window_start: "09:00", window_end: "08:30" }), stop("delivery")])).toEqual(["Stop 1: the window must end after it starts."]);
    expect(stopProblems([stop("pickup", { window_start: "08:00", window_end: "09:00" }), stop("delivery")])).toEqual(["Stop 1: a time window needs an appointment date."]);
    expect(stopProblems([stop("pickup", { appointment_date: "2026-11-05", window_start: "25:00", window_end: "26:00" }), stop("delivery")])).toEqual(["Stop 1: check the window times."]);
    expect(stopProblems([stop("pickup", { appointment_date: "2026-11-05", window_start: "07:00", window_end: "09:00" }), stop("delivery")])).toEqual([]);
  });

  it("refuses more than 25 stops", () => {
    const many = [stop("pickup"), ...Array.from({ length: 25 }, () => stop("delivery"))];
    expect(stopProblems(many)).toContain("An order can have at most 25 stops.");
  });
});

describe("summaries", () => {
  it("writes the address on one line without empty parts", () => {
    expect(stopAddress({ address_line1: "100 Mill St", city: "Gary", state: "IN", postal_code: "46402" })).toBe("100 Mill St, Gary, IN 46402");
    expect(stopAddress({ address_line1: "", city: "Joliet", state: "IL", postal_code: "" })).toBe("Joliet, IL");
    expect(stopAddress({ address_line1: "", city: "", state: "", postal_code: "" })).toBe("");
  });

  it("counts pickups and deliveries", () => {
    expect(stopsSummary([{ kind: "pickup" }, { kind: "delivery" }])).toBe("1 pickup, 1 delivery");
    expect(stopsSummary([{ kind: "pickup" }, { kind: "pickup" }, { kind: "delivery" }, { kind: "delivery" }, { kind: "delivery" }])).toBe("2 pickups, 3 deliveries");
  });

  it("shows the route from the first to the last stop, with the stops between", () => {
    const a = { name: "Acme Steel", city: "Gary", state: "IN" };
    const b = { name: "Lakeside", city: "Joliet", state: "IL" };
    const c = { name: "Harbor Supply", city: "", state: "" };
    expect(routeLine([])).toBe("");
    expect(routeLine([a, b])).toBe("Gary, IN → Joliet, IL");
    expect(routeLine([a, c, b])).toBe("Gary, IN → Joliet, IL (+1 stop)");
    expect(routeLine([a, c, c, b])).toBe("Gary, IN → Joliet, IL (+2 stops)");
    expect(routeLine([a, c])).toBe("Gary, IN → Harbor Supply");
  });

  it("writes the appointment with its window", () => {
    expect(appointmentText({ appointment_date: null, window_start: null, window_end: null })).toBe("");
    expect(appointmentText({ appointment_date: "2026-11-05", window_start: "", window_end: "" })).toMatch(/Nov 5, 2026$/);
    expect(appointmentText({ appointment_date: "2026-11-05", window_start: "07:00", window_end: "09:30" })).toMatch(/Nov 5, 2026, 7:00 AM – 9:30 AM$/);
  });
});
