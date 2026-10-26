// Pure dispatch-board logic. The database is authoritative (assign_load,
// exclusion constraints); these helpers explain the state before a request.
import { driverChecks, evaluateAssignment, type EligibilityQualification, type EligibilityResult, type EligibilityTrailer, type EligibilityTruck } from "@/lib/fleet/eligibility";

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
 * State of one resource for a load:
 *   unavailable — inactive, out of service or not qualified (never assignable);
 *   busy        — otherwise eligible, but already assigned at an overlapping time;
 *   available   — may be assigned (warnings may still apply).
 */
export type ResourceState = { state: "unavailable"; reasons: string[] } | { state: "busy"; with: ActiveAssignment[] } | { state: "available"; warnings: string[] };

export function truckState(truck: EligibilityTruck & { id: string }, interval: Interval, assignments: ActiveAssignment[], on: string, exceptId?: string | null): ResourceState {
  const r = evaluateAssignment({ truck }, on);
  if (!r.eligible) return { state: "unavailable", reasons: r.blockers };
  const busy = conflictsFor(assignments, "truck", truck.id, interval, exceptId);
  return busy.length ? { state: "busy", with: busy } : { state: "available", warnings: r.warnings };
}

export function trailerState(trailer: EligibilityTrailer & { id: string }, interval: Interval, assignments: ActiveAssignment[], on: string, exceptId?: string | null): ResourceState {
  const r = evaluateAssignment({ trailer }, on);
  if (!r.eligible) return { state: "unavailable", reasons: r.blockers };
  const busy = conflictsFor(assignments, "trailer", trailer.id, interval, exceptId);
  return busy.length ? { state: "busy", with: busy } : { state: "available", warnings: r.warnings };
}

export function driverState(
  driver: { id: string; active: boolean; qualifications: EligibilityQualification[] },
  withTrailer: boolean,
  interval: Interval,
  assignments: ActiveAssignment[],
  on: string,
  exceptId?: string | null,
): ResourceState {
  const r = driverChecks(driver, withTrailer, on);
  const blockers = r.blockers;
  if (blockers.length) return { state: "unavailable", reasons: blockers };
  const busy = conflictsFor(assignments, "driver", driver.id, interval, exceptId);
  return busy.length ? { state: "busy", with: busy } : { state: "available", warnings: r.warnings };
}

/** Combined check for a chosen combination, including "a tractor needs a trailer". */
export function combinationCheck(
  input: { truck?: (EligibilityTruck & { id: string }) | null; trailer?: (EligibilityTrailer & { id: string }) | null; driver?: { id: string; active: boolean; qualifications: EligibilityQualification[] } | null },
  interval: Interval,
  assignments: ActiveAssignment[],
  on: string,
  exceptId?: string | null,
): EligibilityResult & { conflicts: Array<{ kind: ResourceKind; with: ActiveAssignment }> } {
  const r = evaluateAssignment(input, on);
  const blockers = [...r.blockers];
  if (input.truck?.truck_type === "tractor" && !input.trailer) blockers.push("trailer_required");
  const conflicts: Array<{ kind: ResourceKind; with: ActiveAssignment }> = [];
  if (input.truck) conflictsFor(assignments, "truck", input.truck.id, interval, exceptId).forEach((a) => conflicts.push({ kind: "truck", with: a }));
  if (input.trailer) conflictsFor(assignments, "trailer", input.trailer.id, interval, exceptId).forEach((a) => conflicts.push({ kind: "trailer", with: a }));
  if (input.driver) conflictsFor(assignments, "driver", input.driver.id, interval, exceptId).forEach((a) => conflicts.push({ kind: "driver", with: a }));
  return { eligible: blockers.length === 0 && conflicts.length === 0, blockers, warnings: r.warnings, conflicts };
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
