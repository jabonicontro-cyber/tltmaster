import { formatDate } from "@/lib/dates";

/**
 * Taviron Live — the operation's next days, computed from recorded data only (no prediction, no guessed values).
 *
 * For each day: planned loads and how many have a truck and driver, trucks that can run (active, in service, not in
 * the shop that day, no open safety-critical work order), drivers not on approved time off, booked work whose truck
 * cannot run that day (a conflict to fix before it happens), and — for people who may see figures — the estimated
 * revenue of loads still without a truck (from the orders' own rates; loads without a rate are counted, not guessed).
 */

export interface OutlookLoad {
  id: string;
  load_date: string;
  /** The truck on the active assignment, or null when nobody is assigned. */
  truck_id: string | null;
  revenue_cents: number | null;
}

export interface OutlookTruck {
  id: string;
  service_status: string;
  expected_return_date: string | null;
}

export interface OutlookShopVisit {
  truck_id: string;
  status: string;
  scheduled_for: string | null;
  safety_critical: boolean;
}

export interface OutlookTimeOff {
  driver_id: string;
  status: "approved" | "pending";
  /** Business dates the request covers (first and last day). */
  first_day: string;
  last_day: string;
  /** False = part of each day only (the driver may still run other loads that day). */
  full_day: boolean;
}

export interface OutlookInput {
  days: string[];
  loads: OutlookLoad[];
  trucks: OutlookTruck[];
  shop: OutlookShopVisit[];
  drivers: number;
  timeOff: OutlookTimeOff[];
}

export type TruckDownReason = "out_of_service" | "shop" | "safety_restricted";

export interface OutlookDay {
  date: string;
  loads: number;
  assigned: number;
  unassigned: number;
  trucksReady: number;
  trucksDown: number;
  downReasons: Record<TruckDownReason, number>;
  driversAvailable: number;
  driversOff: number;
  /** Approved time off for part of the day. */
  driversPartial: number;
  driversPending: number;
  /** Assigned loads whose truck cannot run that day. */
  conflicts: number;
  uncoveredValueCents: number;
  uncoveredWithoutRate: number;
}

/** Why a truck cannot run on `day`, or null when it can (the same rules dispatch applies). */
export function truckDownReason(t: OutlookTruck, day: string, shopByTruck: Map<string, OutlookShopVisit[]>): TruckDownReason | null {
  const visits = shopByTruck.get(t.id) ?? [];
  if (visits.some((v) => v.safety_critical)) return "safety_restricted";
  if (t.service_status === "out_of_service" && (!t.expected_return_date || t.expected_return_date > day)) return "out_of_service";
  if (visits.some((v) => (v.scheduled_for === day && v.status !== "awaiting_inspection") || v.status === "in_progress" || v.status === "awaiting_parts")) return "shop";
  return null;
}

export function buildOutlook(input: OutlookInput): OutlookDay[] {
  const shopByTruck = new Map<string, OutlookShopVisit[]>();
  for (const v of input.shop) shopByTruck.set(v.truck_id, [...(shopByTruck.get(v.truck_id) ?? []), v]);
  return input.days.map((date) => {
    const loads = input.loads.filter((l) => l.load_date === date);
    const down = new Map<string, TruckDownReason>();
    for (const t of input.trucks) {
      const r = truckDownReason(t, date, shopByTruck);
      if (r) down.set(t.id, r);
    }
    const downReasons: Record<TruckDownReason, number> = { out_of_service: 0, shop: 0, safety_restricted: 0 };
    for (const r of down.values()) downReasons[r]++;
    const covers = (x: OutlookTimeOff) => x.first_day <= date && x.last_day >= date;
    const off = new Set(input.timeOff.filter((x) => x.status === "approved" && x.full_day && covers(x)).map((x) => x.driver_id));
    const partial = new Set(input.timeOff.filter((x) => x.status === "approved" && !x.full_day && covers(x) && !off.has(x.driver_id)).map((x) => x.driver_id));
    const pending = new Set(input.timeOff.filter((x) => x.status === "pending" && covers(x) && !off.has(x.driver_id)).map((x) => x.driver_id));
    const unassigned = loads.filter((l) => !l.truck_id);
    return {
      date,
      loads: loads.length,
      assigned: loads.length - unassigned.length,
      unassigned: unassigned.length,
      trucksReady: input.trucks.length - down.size,
      trucksDown: down.size,
      downReasons,
      driversAvailable: Math.max(input.drivers - off.size, 0),
      driversOff: off.size,
      driversPartial: partial.size,
      driversPending: pending.size,
      conflicts: loads.filter((l) => l.truck_id && down.has(l.truck_id)).length,
      uncoveredValueCents: unassigned.reduce((sum, l) => sum + (l.revenue_cents ?? 0), 0),
      uncoveredWithoutRate: unassigned.filter((l) => l.revenue_cents === null).length,
    };
  });
}

export interface OutlookTotals {
  loads: number;
  unassigned: number;
  conflicts: number;
  uncoveredValueCents: number;
  uncoveredWithoutRate: number;
  /** The first day with loads still without a truck, if any. */
  firstGap: string | null;
}

export function outlookTotals(days: readonly OutlookDay[]): OutlookTotals {
  return {
    loads: days.reduce((n, d) => n + d.loads, 0),
    unassigned: days.reduce((n, d) => n + d.unassigned, 0),
    conflicts: days.reduce((n, d) => n + d.conflicts, 0),
    uncoveredValueCents: days.reduce((n, d) => n + d.uncoveredValueCents, 0),
    uncoveredWithoutRate: days.reduce((n, d) => n + d.uncoveredWithoutRate, 0),
    firstGap: days.find((d) => d.unassigned > 0)?.date ?? null,
  };
}

/**
 * The next step for the operation, in order of consequence: booked work on equipment that cannot run, then loads
 * without a truck (earliest first). Nothing is suggested from data that is not recorded.
 */
export function nextSteps(days: readonly OutlookDay[], today: string): Array<{ key: string; text: string; href: string; urgent: boolean }> {
  const out: Array<{ key: string; text: string; href: string; urgent: boolean }> = [];
  for (const d of days) {
    if (d.conflicts > 0) out.push({ key: `conflict:${d.date}`, text: `${d.conflicts} booked load${d.conflicts === 1 ? "" : "s"} on ${d.date === today ? "today" : formatDate(d.date)} use${d.conflicts === 1 ? "s" : ""} a truck that cannot run that day — reassign before it starts.`, href: `/dispatch?date=${d.date}`, urgent: true });
  }
  for (const d of days) {
    if (d.unassigned > 0) out.push({ key: `gap:${d.date}`, text: `${d.unassigned} load${d.unassigned === 1 ? "" : "s"} on ${d.date === today ? "today" : formatDate(d.date)} still need${d.unassigned === 1 ? "s" : ""} a truck and driver.`, href: `/dispatch?date=${d.date}`, urgent: d.date === today });
  }
  return out.slice(0, 5);
}
