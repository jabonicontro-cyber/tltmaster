// Smart Load Build, increment 2 groundwork (docs/SMART_LOAD_BUILD.md §9): given
// cycle-time components and the hours a delivery may happen, how many trips fit
// and when each load could run. Pure functions — no database, not wired to any
// page yet, and nothing here assigns a truck or driver.
//
// Every duration carries its source ("dispatcher", "measured", "estimate") so the
// UI can say where a number came from; nothing is invented here. There is no
// travel-time data in Taviron today, so callers must supply the minutes.
//
// Model (times are minutes after midnight, local business time):
//   a trip occupies its truck for load + outbound + unload + return minutes;
//   the delivery (arrival → end of unloading) must fall inside the delivery
//   window; the whole trip must end by the end of the driver's shift when one
//   is entered; existing bookings of a truck are never moved or overlapped.

export type DurationSource = "dispatcher" | "measured" | "estimate";

export interface Duration {
  minutes: number;
  source: DurationSource;
}

export interface CycleTime {
  load: Duration;
  outbound: Duration;
  unload: Duration;
  /** Return to the source, or repositioning to the next job. */
  back: Duration;
}

export interface TripTruck {
  id: string;
  /** Capacity in the loads' unit; null = unknown (never used). */
  capacity: number | null;
  /** Active, in service and without an open safety report (decided by the caller). */
  usable: boolean;
  /** Existing bookings that day: [start, end) in minutes. Never moved. */
  busy: Array<[number, number]>;
}

export interface TripInput {
  cycle: CycleTime;
  /** When the customer accepts deliveries: [start, end) in minutes. */
  window: [number, number];
  /** Earliest a truck may leave for the first load (e.g. yard opening); defaults to the window start minus load + outbound. */
  earliestStart?: number;
  /** End of the driver's shift, if entered (no hours-of-service rule is assumed). */
  shiftEnd?: number;
  /** Load quantities for this day, already sized (Smart Load Build increment 1). */
  loads: number[];
  trucks: TripTruck[];
}

export interface PlannedTrip {
  load: number;
  quantity: number;
  /** For feasibility only — this is not an assignment; a dispatcher still assigns through Smart Dispatch. */
  truckId: string;
  start: number;
  arrive: number;
  unloaded: number;
  end: number;
}

export interface TripResult {
  ok: boolean;
  cycleMinutes: number;
  trips: PlannedTrip[];
  /** Loads (indexes) that do not fit, with the reason. */
  unplanned: Array<{ load: number; reason: string }>;
  notes: string[];
}

const DURATION_LIMIT = 24 * 60;

/** Validate a cycle: whole minutes, not negative, at least one minute in total. */
export function cycleProblems(c: CycleTime): string[] {
  const out: string[] = [];
  for (const [name, d] of Object.entries(c) as Array<[string, Duration]>) {
    if (!Number.isInteger(d.minutes) || d.minutes < 0 || d.minutes > DURATION_LIMIT) out.push(`Enter ${name} time in whole minutes (0–1440).`);
  }
  if (!out.length && cycleMinutes(c) < 1) out.push("A trip must take at least one minute.");
  return out;
}

export const cycleMinutes = (c: CycleTime) => c.load.minutes + c.outbound.minutes + c.unload.minutes + c.back.minutes;

const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

/** The earliest start ≥ `from` at which [start, start + length) clears every booking, or null within `until`. */
export function nextFreeStart(busy: Array<[number, number]>, from: number, length: number, until: number): number | null {
  let start = from;
  const sorted = [...busy].sort((a, b) => a[0] - b[0]);
  for (let guard = 0; guard <= sorted.length; guard++) {
    const clash = sorted.find((b) => overlaps([start, start + length], b));
    if (!clash) return start + length <= until ? start : null;
    start = clash[1];
  }
  return null;
}

/**
 * Trips for one day: each load goes, in order, to the usable truck that can
 * carry it and finish it soonest, without touching existing bookings. A load
 * that cannot be delivered inside the window (or finished within the shift) is
 * reported as unplanned with the reason — never squeezed in or moved to another day.
 */
export function planTrips(input: TripInput): TripResult {
  const notes: string[] = [];
  const problems = cycleProblems(input.cycle);
  const [winStart, winEnd] = input.window;
  if (!(winEnd > winStart)) problems.push("The delivery window must end after it starts.");
  if (problems.length) return { ok: false, cycleMinutes: 0, trips: [], unplanned: input.loads.map((_, i) => ({ load: i, reason: problems[0] })), notes };

  const c = input.cycle;
  const total = cycleMinutes(c);
  const toSite = c.load.minutes + c.outbound.minutes;
  const unloadEnd = toSite + c.unload.minutes;
  // Leaving earlier than this would arrive before the customer accepts deliveries.
  const earliest = Math.max(input.earliestStart ?? winStart - toSite, winStart - toSite);
  const until = input.shiftEnd ?? 24 * 60;
  const estimated = (Object.values(c) as Duration[]).filter((d) => d.source === "estimate").length;
  if (estimated) notes.push(`${estimated} of the 4 trip times ${estimated === 1 ? "is an estimate" : "are estimates"}.`);
  if (input.shiftEnd === undefined) notes.push("No shift end entered: only the delivery window limits the day.");

  const usable = input.trucks.filter((t) => t.usable && t.capacity !== null);
  const booked = new Map(usable.map((t) => [t.id, [...t.busy]]));
  const trips: PlannedTrip[] = [];
  const unplanned: TripResult["unplanned"] = [];

  input.loads.forEach((quantity, load) => {
    const carriers = usable.filter((t) => (t.capacity as number) >= quantity);
    if (!carriers.length) {
      unplanned.push({ load, reason: `No usable truck can carry ${quantity}.` });
      return;
    }
    let best: PlannedTrip | null = null;
    for (const t of carriers) {
      // Latest start that still finishes unloading inside the window.
      const lastStart = winEnd - unloadEnd;
      const start = nextFreeStart(booked.get(t.id)!, earliest, total, Math.min(until, lastStart + total));
      if (start === null || start > lastStart) continue;
      const trip = { load, quantity, truckId: t.id, start, arrive: start + toSite, unloaded: start + unloadEnd, end: start + total };
      if (!best || trip.unloaded < best.unloaded) best = trip;
    }
    if (!best) {
      unplanned.push({ load, reason: "Not enough time: no truck that can carry it is free to deliver inside the window" + (input.shiftEnd !== undefined ? " and finish within the shift." : ".") });
      return;
    }
    booked.get(best.truckId)!.push([best.start, best.end]);
    trips.push(best);
  });

  return { ok: unplanned.length === 0, cycleMinutes: total, trips, unplanned, notes };
}

/** Upper bound of trips one free truck can make in a day (the arithmetic, before bookings). */
export function maxTripsPerTruck(input: Pick<TripInput, "cycle" | "window" | "earliestStart" | "shiftEnd">): number {
  if (cycleProblems(input.cycle).length) return 0;
  const c = input.cycle;
  const total = cycleMinutes(c);
  const toSite = c.load.minutes + c.outbound.minutes;
  const unloadEnd = toSite + c.unload.minutes;
  const earliest = Math.max(input.earliestStart ?? input.window[0] - toSite, input.window[0] - toSite);
  const lastStart = input.window[1] - unloadEnd;
  const shiftLastStart = input.shiftEnd !== undefined ? input.shiftEnd - total : lastStart;
  const latest = Math.min(lastStart, shiftLastStart);
  return latest < earliest ? 0 : Math.floor((latest - earliest) / total) + 1;
}
