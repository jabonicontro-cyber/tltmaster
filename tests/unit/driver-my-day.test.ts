import { describe, expect, it } from "vitest";
import {
  implausibleQuantity, nextLoad, nextLoadLine, pickInspectionTruck, preTripBanner, preTripProgress, reportEquipmentLabel,
  restrictedTrucks, stopButtonLabel, ticketRef, todaysTrucks,
} from "@/lib/driver/my-day";
import { hoursBetween, hoursShort, scheduleSummary, scheduledHours, usesText } from "@/lib/time-off";

// First-day walkthrough of the driver's phone (2026-11-09): what comes next, trucks not to drive, which pre-trips are
// still due, the "Is that right?" quantity question, and the time-off preview.

const TODAY = "2030-04-02";
const load = (date: string, start: string, truck: string | null, tickets = 0) => ({ load: { date, start_time: start }, truck, tickets: Array.from({ length: tickets }, () => ({})) });

describe("the next load", () => {
  const day = [load(TODAY, "09:00:00", "101"), load(TODAY, "07:30:00", "103"), load("2030-04-01", "06:00:00", "103"), load("2030-04-03", "05:00:00", "103")];

  it("is today's earliest load without a ticket", () => {
    expect(nextLoad(day, TODAY)?.load.start_time).toBe("07:30:00");
    expect(nextLoad([load(TODAY, "07:30:00", "103", 1), load(TODAY, "09:00:00", "101")], TODAY)?.truck).toBe("101");
    expect(nextLoad([load(TODAY, "07:30:00", "103", 1)], TODAY)).toBeNull();
    expect(nextLoad([load("2030-04-03", "05:00:00", "103")], TODAY)).toBeNull();
  });

  it("reads as one plain line, with the pickup when known", () => {
    expect(nextLoadLine(load(TODAY, "07:30:00", "103"), { pickup: "River Gravel Pit", site: "4th St" })).toBe("Next: 7:30 AM · Pick up at River Gravel Pit · Truck 103");
    expect(nextLoadLine(load(TODAY, "13:00:00", null), { site: "4th St" })).toBe("Next: 1:00 PM · Deliver to 4th St");
  });

  it("lists today's trucks in load order, once each", () => {
    expect(todaysTrucks([...day, load(TODAY, "10:00:00", "103")], TODAY)).toEqual(["103", "101"]);
  });
});

describe("trucks not to drive", () => {
  const trucks = [{ id: "t1", unit: "101" }, { id: "t3", unit: "103" }];

  it("a safety defect on today's latest inspection of the truck", () => {
    const out = restrictedTrucks({ trucks, inspections: [{ truck_id: "t3", safety_defect: true, created_at: "2030-04-02T12:00:00Z" }, { truck_id: "t1", safety_defect: false, created_at: "2030-04-02T12:00:00Z" }] });
    expect([...out]).toEqual(["103"]);
    // A later inspection without a safety defect decides.
    expect(restrictedTrucks({ trucks, inspections: [{ truck_id: "t3", safety_defect: true, created_at: "2030-04-02T06:00:00Z" }, { truck_id: "t3", safety_defect: false, created_at: "2030-04-02T18:00:00Z" }] }).size).toBe(0);
  });

  it("open safety-critical shop work on the truck, never a trailer, a canceled or finished job", () => {
    const n = { unit_number: "101", safety_critical: true, notice: "scheduled", status: "scheduled" };
    expect([...restrictedTrucks({ trucks, inspections: [], notices: [n] })]).toEqual(["101"]);
    expect(restrictedTrucks({ trucks, inspections: [], notices: [{ ...n, equipment: "trailer" }] }).size).toBe(0);
    expect(restrictedTrucks({ trucks, inspections: [], notices: [{ ...n, notice: "canceled" }] }).size).toBe(0);
    expect(restrictedTrucks({ trucks, inspections: [], notices: [{ ...n, status: "completed" }] }).size).toBe(0);
    expect(restrictedTrucks({ trucks, inspections: [], notices: [{ ...n, safety_critical: false }] }).size).toBe(0);
  });

  it("an inspection of a truck the driver does not have is ignored", () => {
    expect(restrictedTrucks({ trucks, inspections: [{ truck_id: "other", safety_defect: true, created_at: "2030-04-02T12:00:00Z" }] }).size).toBe(0);
  });
});

describe("pre-trip inspections still to do", () => {
  const rows = [{ unit: "101", pre_trip: false }, { unit: "103", pre_trip: true }, { unit: "120", pre_trip: false }];

  it("names the trucks done and still to inspect, among today's trucks", () => {
    const p = preTripProgress(rows, ["103", "101"]);
    expect(p).toEqual({ done: ["103"], left: ["101"] });
    expect(preTripBanner(p)).toBe("Truck 103 done · Truck 101 still to inspect");
  });

  it("drops once every truck needed today is done", () => {
    expect(preTripBanner(preTripProgress(rows, ["103"]))).toBeNull();
  });

  it("without loads today, every truck counts; before any is done it says to do it first", () => {
    expect(preTripBanner(preTripProgress([{ unit: "101", pre_trip: false }], []))).toBe("Pre-trip inspection: do this before you drive (Truck 101)");
  });

  it("the form starts on the next load's truck, then moves on to the next truck still due", () => {
    const trucks = [{ id: "t1", pending: ["pre_trip", "post_trip"] }, { id: "t3", pending: ["pre_trip", "post_trip"] }, { id: "t9", pending: ["pre_trip"] }];
    expect(pickInspectionTruck(trucks, "t3", ["t3", "t1"])).toBe("t3");
    const after = [{ id: "t1", pending: ["pre_trip", "post_trip"] }, { id: "t3", pending: ["post_trip"] }, { id: "t9", pending: ["pre_trip"] }];
    expect(pickInspectionTruck(after, "t3", ["t3", "t1"])).toBe("t1");
    // Today's trucks done: back to the next load's truck (its post-trip), not a truck not needed today.
    expect(pickInspectionTruck([{ id: "t3", pending: ["post_trip"] }, { id: "t9", pending: ["pre_trip"] }], "t3", ["t3"])).toBe("t3");
    expect(pickInspectionTruck(trucks)).toBe("t1");
    expect(pickInspectionTruck([])).toBe("");
  });
});

describe("a ticket quantity far above the plan", () => {
  it("asks in plain words when it is more than 3 times the planned quantity", () => {
    expect(implausibleQuantity("152", "ton", { quantity: "15", unit: "ton" })).toBe("152 ton is about 10× the planned 15 ton. Is that right?");
    expect(implausibleQuantity("45", "ton", { quantity: 15, unit: "ton" })).toBeNull();
    expect(implausibleQuantity("46", "cu_yd", { quantity: 15, unit: "cu_yd" })).toBe("46 cu yd is about 3× the planned 15 cu yd. Is that right?");
  });

  it("stays quiet without a plan, with another unit, or with an entry that is not a number", () => {
    expect(implausibleQuantity("152", "ton", { quantity: null, unit: "ton" })).toBeNull();
    expect(implausibleQuantity("152", "load", { quantity: 15, unit: "ton" })).toBeNull();
    expect(implausibleQuantity("abc", "ton", { quantity: 15, unit: "ton" })).toBeNull();
    expect(implausibleQuantity("152", "ton", { quantity: 0, unit: "ton" })).toBeNull();
  });
});

describe("labels", () => {
  it("Arrived and Leaving say where", () => {
    expect(stopButtonLabel("pickup", "arrive")).toBe("Arrived at pickup");
    expect(stopButtonLabel("pickup", "depart")).toBe("Leaving pickup");
    expect(stopButtonLabel("site", "arrive")).toBe("Arrived at site");
    expect(stopButtonLabel("site", "depart")).toBe("Leaving site");
    expect(stopButtonLabel("stop:00000000-0000-4000-8000-000000000001", "depart")).toBe("Leaving this stop");
  });

  it("a report names the truck or trailer", () => {
    expect(reportEquipmentLabel("103", { truck: "103", trailer: "T7" })).toBe("Truck 103");
    expect(reportEquipmentLabel("T7", { truck: "103", trailer: "T7" })).toBe("Trailer T7");
    expect(reportEquipmentLabel("103", null)).toBe("Unit 103");
  });

  it("only a plain ticket number is carried into the report", () => {
    expect(ticketRef("T-1042")).toBe("T-1042");
    expect(ticketRef(" T-1042 ")).toBe("T-1042");
    expect(ticketRef("<script>")).toBeNull();
    expect(ticketRef("")).toBeNull();
    expect(ticketRef(undefined)).toBeNull();
  });
});

describe("time-off preview", () => {
  const week = { mon_hours: 8, tue_hours: 8, wed_hours: 8, thu_hours: 8, fri_hours: 8, sat_hours: 0, sun_hours: 0 };

  it("adds the scheduled hours of the days (2030-04-01 is a Monday)", () => {
    expect(scheduledHours(week, "2030-04-01", "")).toBe(8);
    expect(scheduledHours(week, "2030-04-01", "2030-04-07")).toBe(40);
    expect(scheduledHours(week, "2030-04-06", "2030-04-06")).toBe(0);
    expect(scheduledHours(week, "2030-04-02", "2030-04-01")).toBeNull();
  });

  it("states where the hours come from", () => {
    expect(scheduleSummary(week)).toBe("8 h on Mon, Tue, Wed, Thu, Fri");
    expect(scheduleSummary({ ...week, sat_hours: "4.00" })).toBe("Mon 8 h, Tue 8 h, Wed 8 h, Thu 8 h, Fri 8 h, Sat 4 h");
    expect(scheduleSummary({ ...week, mon_hours: 0, tue_hours: 0, wed_hours: 0, thu_hours: 0, fri_hours: 0 })).toBeNull();
  });

  it("shows whole or one-decimal hours; a balance never rounds up", () => {
    expect(hoursShort(8)).toBe("8 h");
    expect(hoursShort(52.32)).toBe("52.3 h");
    expect(hoursShort(52.36, true)).toBe("52.3 h");
    expect(usesText(8, 52.32, "Paid time off")).toBe("Uses 8 h of your 52.3 h Paid time off.");
    expect(usesText(60, 52.32, "Paid time off")).toBe("Uses 60 h, but only 52.3 h of your Paid time off are available.");
    expect(usesText(null, 52.32, "Paid time off")).toBeNull();
    expect(hoursBetween("08:00", "12:30")).toBe(4.5);
    expect(hoursBetween("12:00", "08:00")).toBeNull();
  });
});
