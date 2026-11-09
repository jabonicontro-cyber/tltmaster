/**
 * Can this truck or trailer run on a day? One rule for every page (owner decision 2026-11-09, master plan WK1).
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
