import { formatDate } from "@/lib/dates";
import { summarizeDriversReady, vehicleReadyOn, type ReadinessDriver } from "@/lib/fleet/readiness";

/**
 * Taviron Live — the operation's next days, computed from recorded data only (no prediction, no guessed values).
 *
 * For each day: planned loads and how many have a truck and driver, trucks that can run (the shared readiness rule,
 * src/lib/fleet/readiness.ts: no open safety-critical work order, not in the shop that day or with work in progress or
 * waiting for parts, in service), drivers ready by the shared driver rule (active, valid verified CDL and medical card,
 * not on approved full-day time off; hired-truck drivers counted apart), booked work whose truck or trailer cannot run that
 * day (a conflict to fix before it happens), and — for people who may see figures — the estimated revenue of loads
 * still without a truck (from the orders' own rates; loads without a rate are counted, not guessed). Loads that have
 * already ended are not counted as needing a truck or as conflicts (the same rule as Assignment problems).
 */

export interface OutlookLoad {
  id: string;
  load_date: string;
  /** The truck on the active assignment, or null when nobody is assigned. */
  truck_id: string | null;
  /** The trailer on the active assignment, if any. */
  trailer_id?: string | null;
  /** When the load ends; a load that has ended no longer needs a truck and is not a conflict. */
  ends_at?: string | null;
  revenue_cents: number | null;
}

export interface OutlookTruck {
  id: string;
  service_status: string;
  expected_return_date: string | null;
}

export interface OutlookShopVisit {
  truck_id: string | null;
  trailer_id?: string | null;
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
  /** Active trailers, so loads booked with a trailer that cannot run count as conflicts too. */
  trailers?: OutlookTruck[];
  shop: OutlookShopVisit[];
  /** Active drivers with their qualifications; hired-truck drivers flagged `hired` (counted apart). */
  drivers: ReadinessDriver[];
  timeOff: OutlookTimeOff[];
  /** The company's business date (defaults to the first day shown). */
  today?: string;
  /** Now, to leave out loads that have already ended (defaults to the current time). */
  now?: Date;
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
  /** The company's own drivers ready that day (src/lib/fleet/readiness.ts driverReadyOn). */
  driversAvailable: number;
  /** The company's own active drivers. */
  driversTotal: number;
  /** Own drivers without a valid verified CDL or medical card that day. */
  driversUnqualified: number;
  /** Own qualified drivers on approved full-day time off. */
  driversOff: number;
  /** Approved time off for part of the day. */
  driversPartial: number;
  driversPending: number;
  /** Hired-truck drivers: active, and ready by the same rule (never in driversAvailable). */
  hiredDrivers: number;
  hiredDriversReady: number;
  /** Assigned loads, not yet ended, whose truck or trailer cannot run that day. */
  conflicts: number;
  uncoveredValueCents: number;
  uncoveredWithoutRate: number;
}

/** Why a truck cannot run on `day`, or null when it can (the shared readiness rule, src/lib/fleet/readiness.ts). */
export function truckDownReason(t: OutlookTruck, day: string, shopByTruck: Map<string, OutlookShopVisit[]>, today: string = day): TruckDownReason | null {
  const r = vehicleReadyOn(t, shopByTruck.get(t.id) ?? [], day, today);
  if (r.ready) return null;
  return r.reason === "safety_restricted" ? "safety_restricted" : r.reason === "out_of_service" || r.reason === "inactive" ? "out_of_service" : "shop";
}

export function buildOutlook(input: OutlookInput): OutlookDay[] {
  const shopByTruck = new Map<string, OutlookShopVisit[]>();
  const shopByTrailer = new Map<string, OutlookShopVisit[]>();
  for (const v of input.shop) {
    if (v.truck_id) shopByTruck.set(v.truck_id, [...(shopByTruck.get(v.truck_id) ?? []), v]);
    if (v.trailer_id) shopByTrailer.set(v.trailer_id, [...(shopByTrailer.get(v.trailer_id) ?? []), v]);
  }
  const today = input.today ?? input.days[0];
  const now = (input.now ?? new Date()).getTime();
  const open = (l: OutlookLoad) => !l.ends_at || Date.parse(l.ends_at) > now;
  const timeOff = input.timeOff.map((x) => ({ driver_id: x.driver_id, status: x.status, start_date: x.first_day, end_date: x.last_day, full_day: x.full_day }));
  return input.days.map((date) => {
    const loads = input.loads.filter((l) => l.load_date === date);
    const down = new Map<string, TruckDownReason>();
    for (const t of input.trucks) {
      const r = truckDownReason(t, date, shopByTruck, today);
      if (r) down.set(t.id, r);
    }
    const trailersDown = new Set((input.trailers ?? []).filter((t) => !vehicleReadyOn(t, shopByTrailer.get(t.id) ?? [], date, today).ready).map((t) => t.id));
    const downReasons: Record<TruckDownReason, number> = { out_of_service: 0, shop: 0, safety_restricted: 0 };
    for (const r of down.values()) downReasons[r]++;
    const drivers = summarizeDriversReady(input.drivers, timeOff, date);
    const unassigned = loads.filter((l) => !l.truck_id && open(l));
    return {
      date,
      loads: loads.length,
      assigned: loads.filter((l) => l.truck_id).length,
      unassigned: unassigned.length,
      trucksReady: input.trucks.length - down.size,
      trucksDown: down.size,
      downReasons,
      driversAvailable: drivers.ready,
      driversTotal: drivers.total,
      driversUnqualified: drivers.notQualified,
      driversOff: drivers.off,
      driversPartial: drivers.partial,
      driversPending: drivers.pending,
      hiredDrivers: drivers.hired.total,
      hiredDriversReady: drivers.hired.ready,
      conflicts: loads.filter((l) => l.truck_id && open(l) && (down.has(l.truck_id) || (l.trailer_id && trailersDown.has(l.trailer_id)))).length,
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
    if (d.conflicts > 0) out.push({ key: `conflict:${d.date}`, text: `${d.conflicts} booked load${d.conflicts === 1 ? "" : "s"} on ${d.date === today ? "today" : formatDate(d.date)} use${d.conflicts === 1 ? "s" : ""} a truck or trailer that cannot run that day. Reassign before it starts.`, href: `/dispatch?date=${d.date}`, urgent: true });
  }
  for (const d of days) {
    if (d.unassigned > 0) out.push({ key: `gap:${d.date}`, text: `${d.unassigned} load${d.unassigned === 1 ? "" : "s"} on ${d.date === today ? "today" : formatDate(d.date)} still need${d.unassigned === 1 ? "s" : ""} a truck and driver.`, href: `/dispatch?date=${d.date}`, urgent: d.date === today });
  }
  return out.slice(0, 5);
}
