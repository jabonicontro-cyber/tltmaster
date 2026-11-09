/**
 * Can this truck or trailer run on a day, and is this driver ready? One rule each for every page (owner decisions
 * 2026-11-09, master plan WK1). The driver rule is at the end of this file (driverReadyOn).
 *
 * A truck (and likewise a trailer) is NOT READY on a day when it has:
 *   - an open safety-critical work order (any date; it returns only through clearance in Maintenance);
 *   - a work order scheduled for that day that is not finished (reported, triaged, scheduled, in progress or waiting
 *     for parts);
 *   - shop work in progress or waiting for parts (any date): it is in the shop until the work is done;
 *   - or it is out of service. Today it is not ready whatever its expected return date says; on a later day it counts
 *     as ready from its expected return date (a projection for planning only: assigning still needs a person to put it
 *     back in service, and assign_load refuses it until then).
 * Inactive equipment is never ready. The database applies the same shop rules in private.assignment_eligibility
 * (codes *_safety_restricted, *_shop_scheduled, *_shop_work_open: all blockers since 20261120009800).
 */

import { driverChecks, type EligibilityQualification } from "@/lib/fleet/eligibility";

/** Work-order statuses that keep the unit in the shop on the day the order is scheduled for. */
export const SHOP_DAY_STATUSES: readonly string[] = ["reported", "triaged", "scheduled", "in_progress", "awaiting_parts"];
/** Work-order statuses that keep the unit in the shop whatever date the order carries. */
export const IN_SHOP_STATUSES: readonly string[] = ["in_progress", "awaiting_parts"];
/** Finished work orders: never a restriction. */
const FINISHED = new Set(["completed", "closed", "canceled"]);

export interface ReadinessWorkOrder {
  status: string;
  scheduled_for: string | null;
  safety_critical: boolean;
  number?: string;
}

export interface ReadinessVehicle {
  active?: boolean;
  service_status: string;
  expected_return_date: string | null;
}

/** Why a unit cannot run, in the order of consequence. */
export type NotReadyReason = "inactive" | "safety_restricted" | "out_of_service" | "shop_scheduled" | "in_shop";

export type ShopReason = Extract<NotReadyReason, "safety_restricted" | "shop_scheduled" | "in_shop">;

export interface ShopHold<W extends ReadinessWorkOrder = ReadinessWorkOrder> {
  reason: ShopReason;
  workOrder: W;
}

/**
 * Every shop hold of one unit on `day`, as the database lists them: a safety-critical order, then either a visit
 * scheduled that day or shop work in progress / waiting for parts (one of the two, the visit first).
 */
export function shopHolds<W extends ReadinessWorkOrder>(workOrders: readonly W[], day: string): ShopHold<W>[] {
  const out: ShopHold<W>[] = [];
  const open = workOrders.filter((w) => !FINISHED.has(w.status));
  const safety = open.find((w) => w.safety_critical);
  if (safety) out.push({ reason: "safety_restricted", workOrder: safety });
  const visit = open.find((w) => w.scheduled_for === day && SHOP_DAY_STATUSES.includes(w.status));
  const working = open.find((w) => IN_SHOP_STATUSES.includes(w.status));
  if (visit) out.push({ reason: "shop_scheduled", workOrder: visit });
  else if (working) out.push({ reason: "in_shop", workOrder: working });
  return out;
}

export interface DayReadiness<W extends ReadinessWorkOrder = ReadinessWorkOrder> {
  ready: boolean;
  reason: NotReadyReason | null;
  /** The work order behind a shop reason. */
  workOrder: W | null;
  /** Out of service now, counted as ready on this later day from its expected return date. */
  expectedBack: string | null;
}

/** Whether out-of-service equipment counts as back on `day` (only a later day, from its expected return date). */
export function backInServiceBy(v: ReadinessVehicle, day: string, today: string): boolean {
  return v.service_status === "out_of_service" && day > today && v.expected_return_date !== null && v.expected_return_date <= day;
}

/** The shared rule: can this truck or trailer run on `day` (today is the company's business date)? */
export function vehicleReadyOn<W extends ReadinessWorkOrder>(v: ReadinessVehicle, workOrders: readonly W[], day: string, today: string): DayReadiness<W> {
  const no = (reason: NotReadyReason, workOrder: W | null = null): DayReadiness<W> => ({ ready: false, reason, workOrder, expectedBack: null });
  if (v.active === false) return no("inactive");
  const holds = shopHolds(workOrders, day);
  const safety = holds.find((h) => h.reason === "safety_restricted");
  if (safety) return no("safety_restricted", safety.workOrder);
  const projected = backInServiceBy(v, day, today);
  if (v.service_status === "out_of_service" && !projected) return no("out_of_service");
  const shop = holds[0];
  if (shop) return no(shop.reason, shop.workOrder);
  return { ready: true, reason: null, workOrder: null, expectedBack: projected ? v.expected_return_date : null };
}

/** Plain words for a reason, for one unit ("Truck 101 is in the shop (WO-12)."). */
export function notReadyText(kind: "truck" | "trailer", r: Pick<DayReadiness, "reason" | "workOrder">): string | null {
  const unit = kind === "truck" ? "Truck" : "Trailer";
  const wo = r.workOrder?.number ? ` (${r.workOrder.number})` : "";
  switch (r.reason) {
    case "inactive": return `${unit} is deactivated.`;
    case "safety_restricted": return `${unit} has an open safety-critical work order${wo}. It returns only through clearance in Maintenance.`;
    case "out_of_service": return `${unit} is out of service.`;
    case "shop_scheduled": return `${unit} is in the shop on this date${wo}.`;
    case "in_shop": return `${unit} is in the shop${wo}: work is in progress or waiting for parts. It cannot be assigned until the work is done.`;
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Drivers (owner decision 2026-11-09, master plan WK1)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Is this driver READY on a day? One rule for every page that reports drivers ready (Command Center, Taviron Live,
 * Fleet, Driver & truck availability and the assistant's outlook):
 *   - active;
 *   - a valid, verified CDL (class B or higher) and a valid, verified medical card on that day (the same qualification
 *     check as dispatch, src/lib/fleet/eligibility.ts: unknown is never treated as valid);
 *   - and not on approved full-day time off that day. Approved partial-day time off and pending requests do not make a
 *     driver not ready; they are reported apart so a dispatcher checks the load times.
 * Hired-truck drivers (drivers of a hauler, `drivers.hauler_id`) are another company's drivers: they are counted
 * separately and never in the company's own ready count.
 */

export interface ReadinessDriver {
  id: string;
  active: boolean;
  qualifications: EligibilityQualification[];
  /** A hired-truck (hauler) driver. */
  hired?: boolean;
}

/** One time-off request touching the driver (dates are the company's business dates, first and last day). */
export interface ReadinessTimeOff {
  driver_id: string;
  status: string;
  start_date: string;
  end_date: string;
  full_day: boolean;
}

export type DriverNotReadyReason = "inactive" | "not_qualified" | "time_off";
export type DriverDocument = "cdl" | "medical_card";

export interface DriverDayReadiness {
  ready: boolean;
  reason: DriverNotReadyReason | null;
  /** The qualification blockers behind not_qualified (eligibility codes such as cdl_expired, medical_card_unverified). */
  blockers: string[];
  /** Which documents fail, for the words ("CDL", "medical card"). */
  documents: DriverDocument[];
  /** Approved time off for part of the day: still counted ready; check the load times. */
  partialTimeOff: boolean;
  /** A pending request on that day: still counted ready until it is approved. */
  pendingTimeOff: boolean;
  hired: boolean;
}

const coversDay = (t: ReadinessTimeOff, day: string) => t.start_date <= day && t.end_date >= day;

/** The shared rule: is this driver ready on `day`? `timeOff` may hold every driver's requests; only this driver's count. */
export function driverReadyOn(driver: ReadinessDriver, timeOff: readonly ReadinessTimeOff[], day: string): DriverDayReadiness {
  const mine = timeOff.filter((t) => t.driver_id === driver.id && coversDay(t, day));
  const off = mine.some((t) => t.status === "approved" && t.full_day);
  const partialTimeOff = !off && mine.some((t) => t.status === "approved" && !t.full_day);
  const pendingTimeOff = !off && mine.some((t) => t.status === "pending");
  const checks = driverChecks({ active: driver.active, qualifications: driver.qualifications }, false, day);
  const blockers = checks.blockers.filter((b) => b !== "driver_inactive");
  const documents: DriverDocument[] = [];
  if (blockers.some((b) => b.startsWith("cdl_"))) documents.push("cdl");
  if (blockers.some((b) => b.startsWith("medical_card_"))) documents.push("medical_card");
  const reason: DriverNotReadyReason | null = !driver.active ? "inactive" : blockers.length ? "not_qualified" : off ? "time_off" : null;
  return { ready: reason === null, reason, blockers, documents, partialTimeOff, pendingTimeOff, hired: Boolean(driver.hired) };
}

/** Plain words for why a driver is not ready ("Not qualified: CDL and medical card."), or null when ready. */
export function driverNotReadyText(r: Pick<DriverDayReadiness, "reason" | "documents">): string | null {
  switch (r.reason) {
    case "inactive": return "Driver is inactive.";
    case "not_qualified": {
      const docs = r.documents.map((d) => (d === "cdl" ? "CDL" : "medical card"));
      return `Not qualified: ${docs.length ? docs.join(" and ") : "qualifications"} not valid and verified on this date.`;
    }
    case "time_off": return "On approved full-day time off.";
    default: return null;
  }
}

export interface DriverReadySummary {
  /** The company's own active drivers (hired drivers left out). */
  total: number;
  ready: number;
  notQualified: number;
  /** Qualified, on approved full-day time off. */
  off: number;
  partial: number;
  pending: number;
  /** Hired-truck drivers, counted apart: how many are active, and how many are ready by the same rule. */
  hired: { total: number; ready: number };
}

/** Count drivers ready on `day` by the shared rule. Pass active drivers; inactive ones are left out of every figure. */
export function summarizeDriversReady(drivers: readonly ReadinessDriver[], timeOff: readonly ReadinessTimeOff[], day: string): DriverReadySummary {
  const out: DriverReadySummary = { total: 0, ready: 0, notQualified: 0, off: 0, partial: 0, pending: 0, hired: { total: 0, ready: 0 } };
  for (const d of drivers) {
    if (!d.active) continue;
    const r = driverReadyOn(d, timeOff, day);
    if (r.hired) {
      out.hired.total++;
      if (r.ready) out.hired.ready++;
      continue;
    }
    out.total++;
    if (r.ready) out.ready++;
    else if (r.reason === "not_qualified") out.notQualified++;
    else if (r.reason === "time_off") out.off++;
    if (r.partialTimeOff) out.partial++;
    if (r.pendingTimeOff) out.pending++;
  }
  return out;
}

/** The short line under a drivers-ready figure: why the rest are not ready ("1 not qualified, 2 off"). */
export function driverReadyCaption(s: DriverReadySummary, timeOffChecked = true): string {
  const parts = [s.notQualified ? `${s.notQualified} not qualified` : "", s.off ? `${s.off} on time off` : ""].filter(Boolean);
  const why = parts.length ? parts.join(", ") : s.total ? "Verified CDL and medical card, not off" : "No drivers yet";
  return timeOffChecked ? why : `${why}; time off not checked`;
}
