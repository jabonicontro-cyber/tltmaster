import { describe, expect, it } from "vitest";
import { cycleProblems, maxTripsPerTruck, nextFreeStart, planTrips, type CycleTime, type TripInput, type TripTruck } from "@/lib/dispatch/trip-plan";

const m = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const d = (minutes: number, source: "dispatcher" | "measured" | "estimate" = "dispatcher") => ({ minutes, source });
// 15 load + 45 out + 15 unload + 45 back = 2 h per trip.
const cycle: CycleTime = { load: d(15), outbound: d(45), unload: d(15), back: d(45) };
const truck = (id: string, capacity: number | null = 25, extra: Partial<TripTruck> = {}): TripTruck => ({ id, capacity, usable: true, busy: [], ...extra });
const base: TripInput = { cycle, window: [m("07:00"), m("17:00")], loads: [25, 25, 25, 18], trucks: [truck("A")] };

describe("trips per truck", () => {
  it("counts how many 2-hour trips one truck can deliver inside a 7:00–17:00 window", () => {
    // Leaves 6:00 (arrives 7:00); the last start that finishes unloading by 17:00 is 15:45 → 6:00, 8:00 … 14:00.
    expect(maxTripsPerTruck({ cycle, window: base.window })).toBe(5);
  });

  it("a shift end limits the day further, and no shift end is stated as such", () => {
    expect(maxTripsPerTruck({ cycle, window: base.window, shiftEnd: m("12:00") })).toBe(3);
    expect(planTrips(base).notes.join(" ")).toMatch(/No shift end entered/);
  });
});

describe("planning a day's loads", () => {
  it("staggers one truck's loads back to back, each delivered inside the window", () => {
    const r = planTrips(base);
    expect(r.ok).toBe(true);
    expect(r.trips.map((t) => t.start)).toEqual([m("06:00"), m("08:00"), m("10:00"), m("12:00")]);
    for (const t of r.trips) {
      expect(t.arrive).toBeGreaterThanOrEqual(base.window[0]);
      expect(t.unloaded).toBeLessThanOrEqual(base.window[1]);
    }
    // Quantities are passed through unchanged (exactness comes from increment 1).
    expect(r.trips.map((t) => t.quantity)).toEqual([25, 25, 25, 18]);
  });

  it("uses a second truck to finish earlier", () => {
    const r = planTrips({ ...base, trucks: [truck("A"), truck("B")] });
    expect(r.trips.map((t) => [t.truckId, t.start])).toEqual([["A", m("06:00")], ["B", m("06:00")], ["A", m("08:00")], ["B", m("08:00")]]);
  });

  it("reports loads that do not fit in the time instead of squeezing them in or moving them to another day", () => {
    const r = planTrips({ ...base, window: [m("07:00"), m("11:00")] });
    expect(r.ok).toBe(false);
    expect(r.trips).toHaveLength(2);
    expect(r.unplanned.map((u) => u.load)).toEqual([2, 3]);
    expect(r.unplanned[0].reason).toMatch(/Not enough time/);
  });

  it("never plans a load on a truck too small for it", () => {
    const r = planTrips({ ...base, trucks: [truck("small", 18)] });
    expect(r.unplanned.map((u) => u.load)).toEqual([0, 1, 2]);
    expect(r.unplanned[0].reason).toMatch(/No usable truck can carry 25/);
    expect(r.trips.map((t) => t.quantity)).toEqual([18]);
  });

  it("ignores unusable and unknown-capacity trucks", () => {
    const r = planTrips({ ...base, trucks: [truck("off", 25, { usable: false }), truck("unknown", null)] });
    expect(r.trips).toHaveLength(0);
    expect(r.unplanned).toHaveLength(4);
  });

  it("works around existing bookings without moving them", () => {
    const busy: Array<[number, number]> = [[m("07:00"), m("09:30")]];
    const r = planTrips({ ...base, loads: [25], trucks: [truck("A", 25, { busy })] });
    expect(r.trips[0].start).toBe(m("09:30"));
    expect(nextFreeStart(busy, m("06:00"), 120, m("08:00"))).toBeNull();
  });

  it("respects the end of the driver's shift", () => {
    const r = planTrips({ ...base, shiftEnd: m("10:00") });
    expect(r.trips).toHaveLength(2); // 6:00–8:00 and 8:00–10:00
    expect(r.unplanned[0].reason).toMatch(/finish within the shift/);
  });

  it("labels estimated durations and refuses invalid ones", () => {
    expect(planTrips({ ...base, cycle: { ...cycle, outbound: d(45, "estimate") } }).notes.join(" ")).toMatch(/1 of the 4 trip times is an estimate/);
    expect(cycleProblems({ ...cycle, unload: d(-5) })).toHaveLength(1);
    expect(planTrips({ ...base, cycle: { ...cycle, load: d(1.5) } }).ok).toBe(false);
    expect(planTrips({ ...base, window: [m("17:00"), m("07:00")] }).unplanned[0].reason).toMatch(/window must end after/);
  });
});
