// Pure dispatch-board logic. The database is authoritative (assign_load,
// exclusion constraints); these helpers explain the state before a request.
import { driverChecks, evaluateAssignment, type EligibilityQualification, type EligibilityResult, type EligibilityTrailer, type EligibilityTruck } from "@/lib/fleet/eligibility";
import { shiftProblem, type SmartShift } from "@/lib/dispatch/smart";
import { shopHolds, type ShopHold } from "@/lib/fleet/readiness";

export interface Interval {
  starts_at: string;
  ends_at: string;
}

/** Half-open [start, end) intervals overlap — back-to-back does not. */
export function overlaps(a: Interval, b: Interval): boolean {
  return Date.parse(a.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(a.ends_at);
}

export interface ActiveAssignment extends Interval {
  id: string;
  load_id: string;
  truck_id: string;
  trailer_id: string | null;
  driver_id: string;
  status: "active" | "canceled";
}

export type ResourceKind = "truck" | "trailer" | "driver";

const idOf = (a: ActiveAssignment, kind: ResourceKind) => (kind === "truck" ? a.truck_id : kind === "trailer" ? a.trailer_id : a.driver_id);

/** Active assignments of a resource that overlap the interval (other than `exceptId`). */
export function conflictsFor(assignments: ActiveAssignment[], kind: ResourceKind, resourceId: string, interval: Interval, exceptId?: string | null): ActiveAssignment[] {
  return assignments.filter((a) => a.status === "active" && a.id !== exceptId && idOf(a, kind) === resourceId && overlaps(a, interval));
}

/** All active assignments of a resource on the board, by start time. */
export function bookingsFor(assignments: ActiveAssignment[], kind: ResourceKind, resourceId: string): ActiveAssignment[] {
  return assignments.filter((a) => a.status === "active" && idOf(a, kind) === resourceId).sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at));
}

/**
 * What the board knows about the shown date beyond the fleet records (read for that date only): open work orders,
 * unresolved driver reports, expired vehicle documents, drivers' time off and scheduled shifts. Each list is empty when
 * it could not be read; the database still checks every rule in assign_load. Produces the same codes as
 * private.assignment_eligibility, so the board and the server's refusal use the same words (ELIGIBILITY_MESSAGES).
 */
export interface DayRestrictions {
  shop: Array<{ truck_id: string | null; trailer_id: string | null; number: string; status: string; scheduled_for: string | null; safety_critical: boolean }>;
  reports: Array<{ equipment: "truck" | "trailer"; truck_id: string | null; trailer_id: string | null; kind: string }>;
  documents: Array<{ truck_id: string | null; trailer_id: string | null; blocks: boolean }>;
  timeOff: Array<{ driver_id: string; status: "approved" | "pending"; full_day: boolean; start_date: string; end_date: string }>;
  shifts: SmartShift[];
}

/** The load being assigned, for capacity and shift checks. */
export interface LoadContext {
  load_date: string;
  starts_at: string | null;
  ends_at: string | null;
  planned_quantity: number | string | null;
  unit_code: string | null;
}

export interface DayContext {
  load?: LoadContext | null;
  restrictions?: DayRestrictions | null;
}

type Codes = { blockers: string[]; warnings: string[] };
type ShopRow = DayRestrictions["shop"][number];
const SHOP_CODE = { safety_restricted: "safety_restricted", shop_scheduled: "shop_scheduled", in_shop: "shop_work_open" } as const;

/** The shop holds of one truck or trailer on a date (the shared readiness rule, src/lib/fleet/readiness.ts). */
function holdsOf(kind: "truck" | "trailer", id: string, on: string, r: DayRestrictions | null | undefined): ShopHold<ShopRow>[] {
  if (!r) return [];
  return shopHolds(r.shop.filter((w) => (kind === "truck" ? w.truck_id : w.trailer_id) === id), on);
}

/** Maintenance, driver reports and documents of one truck or trailer on a date (mirrors private.assignment_eligibility). */
export function vehicleDayChecks(kind: "truck" | "trailer", id: string, on: string, r: DayRestrictions | null | undefined): Codes {
  const out: Codes = { blockers: [], warnings: [] };
  if (!r) return out;
  const mine = <T extends { truck_id: string | null; trailer_id: string | null }>(x: T) => (kind === "truck" ? x.truck_id : x.trailer_id) === id;
  const reports = r.reports.filter((x) => x.equipment === kind && mine(x));
  if (reports.some((x) => x.kind === "breakdown" || x.kind === "inspection_issue")) out.blockers.push(`${kind}_safety_report_open`);
  else if (reports.some((x) => x.kind === "equipment_issue")) out.warnings.push(`${kind}_equipment_report_open`);
  // Shop work: a safety-critical order, a visit that day, or work in progress / waiting for parts all block (WK1).
  for (const h of holdsOf(kind, id, on, r)) out.blockers.push(`${kind}_${SHOP_CODE[h.reason]}`);
  const docs = r.documents.filter(mine);
  if (docs.some((d) => d.blocks)) out.blockers.push(`${kind}_document_expired`);
  else if (docs.length) out.warnings.push(`${kind}_document_review`);
  return out;
}

/**
 * The work order that keeps the truck or trailer in the shop on the date, or null: a safety-critical order, a visit
 * that day, or work in progress or waiting for parts (the shared readiness rule). The board shows "In the shop" with it.
 */
export function shopWorkOn(kind: "truck" | "trailer", id: string, on: string, r: DayRestrictions | null | undefined): ShopRow | null {
  return holdsOf(kind, id, on, r)[0]?.workOrder ?? null;
}

/** True when the truck or trailer is in the shop on the date. */
export function inShop(kind: "truck" | "trailer", id: string, on: string, r: DayRestrictions | null | undefined): boolean {
  return shopWorkOn(kind, id, on, r) !== null;
}

/** Approved and pending time off of one driver on a date (mirrors private.assignment_eligibility). */
export function driverDayChecks(driverId: string, on: string, r: DayRestrictions | null | undefined): Codes {
  const out: Codes = { blockers: [], warnings: [] };
  if (!r) return out;
  const mine = r.timeOff.filter((t) => t.driver_id === driverId && t.start_date <= on && t.end_date >= on);
  if (mine.some((t) => t.status === "approved" && t.full_day)) out.blockers.push("driver_time_off");
  else if (mine.some((t) => t.status === "approved" && !t.full_day && t.start_date === on)) out.warnings.push("driver_partial_time_off");
  if (mine.some((t) => t.status === "pending")) out.warnings.push("driver_time_off_pending");
  return out;
}

/**
 * Why the driver is not on shift for the load ("Day off on Mon, Nov 9"), or null: the words Plan the day uses
 * (shiftProblem). The server does not refuse it outright: assigning asks the dispatcher for a reason.
 */
export function driverShiftProblem(driverId: string, ctx: DayContext | undefined): string | null {
  if (!ctx?.load || !ctx.restrictions) return null;
  return shiftProblem(driverId, ctx.load, ctx.restrictions.shifts);
}

type CapacityRecord = { weight_capacity: string | number | null; weight_unit?: string | null; volume_capacity: string | number | null };
const plain = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * The load's planned quantity against the combined recorded capacity of the truck and trailer, in the same words as
 * private.load_capacity_problem (assign_load refuses it). Null when the unit is not comparable or capacity is unknown.
 */
export function capacityProblem(vehicles: Array<CapacityRecord | null | undefined>, quantity: number | string | null, unit: string | null): string | null {
  if (quantity === null || quantity === "" || (unit !== "ton" && unit !== "cu_yd")) return null;
  const q = Number(quantity);
  if (!Number.isFinite(q)) return null;
  let cap = 0;
  let known = false;
  for (const v of vehicles) {
    if (!v) continue;
    if (unit === "ton" && v.weight_capacity !== null) {
      cap += v.weight_unit === "lb" ? Number(v.weight_capacity) / 2000 : Number(v.weight_capacity);
      known = true;
    } else if (unit === "cu_yd" && v.volume_capacity !== null) {
      cap += Number(v.volume_capacity);
      known = true;
    }
  }
  if (!known || q <= cap) return null;
  const u = unit.replace("_", " ");
  return `The load is planned at ${plain(q)} ${u}, more than the recorded capacity of ${plain(cap)} ${u}. Split the load or choose larger equipment.`;
}

/**
 * State of one resource for a load:
 *   unavailable — inactive, out of service, not qualified, in the shop, too small or on time off (never assignable);
 *   busy        — otherwise eligible, but already assigned at an overlapping time;
 *   available   — may be assigned (warnings may still apply; `needsReason` = off shift, assigning asks for a reason).
 * Reasons and warnings are eligibility codes or ready sentences; show them with eligibilityMessage.
 */
export type ResourceState =
  | { state: "unavailable"; reasons: string[] }
  | { state: "busy"; with: ActiveAssignment[] }
  | { state: "available"; warnings: string[]; needsReason?: string };

const available = (warnings: string[], needsReason?: string | null): ResourceState => (needsReason ? { state: "available", warnings, needsReason } : { state: "available", warnings });

/**
 * A truck for the load. `trailer` is the trailer chosen with it, if any: capacity is checked for the combination, as
 * assign_load does. A tractor without a trailer is not checked for capacity (it needs a trailer anyway).
 */
export function truckState(truck: EligibilityTruck & CapacityRecord & { id: string }, interval: Interval, assignments: ActiveAssignment[], on: string, exceptId?: string | null, ctx?: DayContext, trailer?: CapacityRecord | null): ResourceState {
  const r = evaluateAssignment({ truck }, on);
  const day = vehicleDayChecks("truck", truck.id, on, ctx?.restrictions);
  const reasons = [...r.blockers, ...day.blockers];
  if (ctx?.load && !(truck.truck_type === "tractor" && !trailer)) {
    const cap = capacityProblem([truck, trailer], ctx.load.planned_quantity, ctx.load.unit_code);
    if (cap) reasons.push(cap);
  }
  if (reasons.length) return { state: "unavailable", reasons };
  const busy = conflictsFor(assignments, "truck", truck.id, interval, exceptId);
  return busy.length ? { state: "busy", with: busy } : available([...r.warnings, ...day.warnings]);
}

/** A trailer for the load; `truck` is the truck chosen with it, for the combined capacity. */
export function trailerState(trailer: EligibilityTrailer & CapacityRecord & { id: string }, interval: Interval, assignments: ActiveAssignment[], on: string, exceptId?: string | null, ctx?: DayContext, truck?: CapacityRecord | null): ResourceState {
  const r = evaluateAssignment({ trailer }, on);
  const day = vehicleDayChecks("trailer", trailer.id, on, ctx?.restrictions);
  const reasons = [...r.blockers, ...day.blockers];
  if (ctx?.load && truck) {
    const cap = capacityProblem([truck, trailer], ctx.load.planned_quantity, ctx.load.unit_code);
    if (cap) reasons.push(cap);
  }
  if (reasons.length) return { state: "unavailable", reasons };
  const busy = conflictsFor(assignments, "trailer", trailer.id, interval, exceptId);
  return busy.length ? { state: "busy", with: busy } : available([...r.warnings, ...day.warnings]);
}

export function driverState(
  driver: { id: string; active: boolean; qualifications: EligibilityQualification[] },
  withTrailer: boolean,
  interval: Interval,
  assignments: ActiveAssignment[],
  on: string,
  exceptId?: string | null,
  ctx?: DayContext,
): ResourceState {
  const r = driverChecks(driver, withTrailer, on);
  const day = driverDayChecks(driver.id, on, ctx?.restrictions);
  const blockers = [...r.blockers, ...day.blockers];
  if (blockers.length) return { state: "unavailable", reasons: blockers };
  const busy = conflictsFor(assignments, "driver", driver.id, interval, exceptId);
  return busy.length ? { state: "busy", with: busy } : available([...r.warnings, ...day.warnings], driverShiftProblem(driver.id, ctx));
}

/**
 * Combined check for a chosen combination, including "a tractor needs a trailer", capacity, maintenance, reports,
 * documents, time off and (as `needsReason`) the driver's shift. Only informs: assign_load decides.
 */
export function combinationCheck(
  input: { truck?: (EligibilityTruck & CapacityRecord & { id: string }) | null; trailer?: (EligibilityTrailer & CapacityRecord & { id: string }) | null; driver?: { id: string; active: boolean; qualifications: EligibilityQualification[] } | null },
  interval: Interval,
  assignments: ActiveAssignment[],
  on: string,
  exceptId?: string | null,
  ctx?: DayContext,
): EligibilityResult & { conflicts: Array<{ kind: ResourceKind; with: ActiveAssignment }>; needsReason: string | null } {
  const r = evaluateAssignment(input, on);
  const blockers = [...r.blockers];
  const warnings = [...r.warnings];
  const add = (c: Codes) => {
    blockers.push(...c.blockers);
    warnings.push(...c.warnings);
  };
  if (input.truck) add(vehicleDayChecks("truck", input.truck.id, on, ctx?.restrictions));
  if (input.trailer) add(vehicleDayChecks("trailer", input.trailer.id, on, ctx?.restrictions));
  if (input.driver) add(driverDayChecks(input.driver.id, on, ctx?.restrictions));
  if (input.truck?.truck_type === "tractor" && !input.trailer) blockers.push("trailer_required");
  else if (input.truck && ctx?.load) {
    const cap = capacityProblem([input.truck, input.trailer], ctx.load.planned_quantity, ctx.load.unit_code);
    if (cap) blockers.push(cap);
  }
  const conflicts: Array<{ kind: ResourceKind; with: ActiveAssignment }> = [];
  if (input.truck) conflictsFor(assignments, "truck", input.truck.id, interval, exceptId).forEach((a) => conflicts.push({ kind: "truck", with: a }));
  if (input.trailer) conflictsFor(assignments, "trailer", input.trailer.id, interval, exceptId).forEach((a) => conflicts.push({ kind: "trailer", with: a }));
  if (input.driver) conflictsFor(assignments, "driver", input.driver.id, interval, exceptId).forEach((a) => conflicts.push({ kind: "driver", with: a }));
  const needsReason = input.driver ? driverShiftProblem(input.driver.id, ctx) : null;
  return { eligible: blockers.length === 0 && conflicts.length === 0, blockers, warnings, conflicts, needsReason };
}

/** "07:00:00" → minutes since midnight. */
export function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A crew that worked one load: truck, trailer (optional) and driver. */
export interface Crew {
  truck_id: string;
  trailer_id: string | null;
  driver_id: string;
}

/** A load's assignment on an earlier day (B85 "copy the previous crew"). */
export interface PastCrew extends Crew {
  order_id: string;
  load_date: string;
  starts_at: string;
}

export interface CrewProposal extends Crew {
  load_id: string;
  /** The day the crew is copied from. */
  from_date: string;
}

/**
 * Proposals for today's loads that have no truck yet, from the same order's most recent earlier day: that day's
 * crews in time order (each truck/driver pair once), handed to today's open loads in time order, cycling when today
 * has more loads than that day had crews. Only proposals: each still goes through assign_load after a dispatcher
 * approves, so eligibility, overlaps and shifts are checked there (and pre-checked on the board).
 */
export function proposePreviousCrews(open: Array<{ id: string; order_id: string; starts_at: string }>, past: PastCrew[]): CrewProposal[] {
  const byOrder = new Map<string, PastCrew[]>();
  for (const p of past) byOrder.set(p.order_id, [...(byOrder.get(p.order_id) ?? []), p]);
  const out: CrewProposal[] = [];
  const loadsByOrder = new Map<string, typeof open>();
  for (const l of open) loadsByOrder.set(l.order_id, [...(loadsByOrder.get(l.order_id) ?? []), l]);
  for (const [orderId, loads] of loadsByOrder) {
    const history = byOrder.get(orderId);
    if (!history?.length) continue;
    const lastDay = history.reduce((d, p) => (p.load_date > d ? p.load_date : d), "");
    const seen = new Set<string>();
    const crews = history
      .filter((p) => p.load_date === lastDay)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      .filter((p) => {
        const key = `${p.truck_id}|${p.driver_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    [...loads]
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      .forEach((l, i) => {
        const c = crews[i % crews.length];
        out.push({ load_id: l.id, truck_id: c.truck_id, trailer_id: c.trailer_id, driver_id: c.driver_id, from_date: lastDay });
      });
  }
  return out;
}
