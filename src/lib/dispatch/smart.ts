// Smart Dispatch: recommendations for unassigned loads. Pure and
// deterministic — the same inputs always give the same proposals, in the same
// order. It never assigns anything: a dispatcher approves a proposal, and the
// approval goes through public.assign_load, which re-checks every rule against
// the database at that moment (eligibility, conflicts, capacity, stale state).
//
// Hard constraints (a truck or driver is excluded, with the reason):
//   truck/driver deactivated · truck out of service · an open safety-critical
//   work order · a shop visit scheduled on the load date · an unresolved driver
//   report of a breakdown or inspection problem on the truck · the load's
//   planned quantity exceeds the truck's recorded capacity · a tractor (needs a
//   trailer — choose one on the board) · the driver's CDL or medical card is
//   missing, expired, unverified or of too low a class on the load date · the
//   truck or driver is already booked at an overlapping time.
// Soft preferences (scored; never override a hard constraint):
//   keeping a truck/driver on the same job or site that day (fewer empty
//   trips — travel distance itself is NOT calculated: no locations are
//   recorded for trucks), using the truck's capacity well, spreading loads
//   across drivers, and avoiding equipment with an open equipment-issue report
//   or unknown/unverified capacity (warnings).
// Dispatch bases (multi-location): a truck or driver at another base than the load's order is excluded unless the
// company allows cross-base dispatch; then it is proposed with a warning and ranked after same-base resources.
// Loads are handled most urgent first (open urgent flag, customer's requested
// date passed, earliest load), and a truck or driver proposed for a more urgent
// load is not proposed again for an overlapping one.

import { addDays } from "@/lib/dates";
import { driverChecks, eligibilityMessage, type EligibilityQualification } from "@/lib/fleet/eligibility";

export interface SmartLoad {
  id: string;
  /** The order's dispatch base (undefined/null before bases or when unset). */
  base_id?: string | null;
  order_id: string;
  order_number: string;
  customer_name: string | null;
  site: string;
  load_number: number;
  load_date: string;
  starts_at: string;
  ends_at: string;
  planned_quantity: number | null;
  unit_code: string | null;
  requested_date: string | null;
  urgent: boolean;
  needed_by: string | null;
}

export interface SmartBooking {
  load_id: string;
  order_id: string;
  truck_id: string;
  driver_id: string;
  load_date: string;
  starts_at: string;
  ends_at: string;
  site: string;
}

export interface SmartTruck {
  id: string;
  base_id?: string | null;
  unit_number: string;
  truck_type: string;
  active: boolean;
  service_status: "in_service" | "out_of_service";
  expected_return_date: string | null;
  weight_capacity: number | null;
  weight_unit: "ton" | "lb" | null;
  volume_capacity: number | null;
  capacity_verified_at: string | null;
}

export interface SmartDriver {
  id: string;
  base_id?: string | null;
  name: string;
  active: boolean;
  qualifications: EligibilityQualification[];
  /** The driver's primary truck (drivers.primary_truck_id), for Keep crews together; optional. */
  primary_truck_id?: string | null;
}

export interface SmartReport {
  truck_id: string;
  kind: string;
}

export interface SmartInput {
  today: string;
  loads: SmartLoad[];
  bookings: SmartBooking[];
  trucks: SmartTruck[];
  drivers: SmartDriver[];
  /** Unresolved driver reports about trucks (open or acknowledged). */
  truckReports: SmartReport[];
  /** Pairs a dispatcher rejected for a load. */
  rejections: Array<{ load_id: string; truck_id: string; driver_id: string }>;
  /** Open work orders from Maintenance (shop visits, restrictions, shop work in progress). */
  shopVisits?: SmartShopVisit[];
  /**
   * Expired registration, insurance, inspection or permit on record (latest per vehicle and kind; 20261112000200).
   * `blocks` = verified and the company's rule for that kind is "block": the equipment is excluded, as the database
   * refuses it. Anything else is a warning to confirm the renewal. Undefined when the rules are not installed.
   */
  documentIssues?: SmartDocumentIssue[];
  /** False when the maintenance schedule could not be read (database update not installed). */
  maintenanceChecked?: boolean;
  /** Approved and pending time off of drivers (no category or reason). */
  timeOff?: SmartTimeOff[];
  /** False when time off could not be read (database update not installed). */
  timeOffChecked?: boolean;
  /** Drivers whose employee record says On leave (an HR status, separate from dated time off): a warning, never a block. */
  driversOnLeave?: string[];
  /**
   * Chooses a usable trailer for a tractor (the trailer rules of Plan the day; null = none usable). Without it a tractor
   * is excluded with "choose a trailer on the board", as before.
   */
  pickTrailer?: (truck: SmartTruck, load: SmartLoad, driver: SmartDriver | null, busy: string[]) => { id: string; unit_number: string } | null;
  /** Dispatch bases, when the company has more than one: names by id and whether cross-base dispatch is allowed. */
  bases?: { crossBase: boolean; names: Record<string, string> };
}

/** Base rule for one truck or driver on a load: a block (cross-base off), a warning (allowed), or nothing. */
export function baseCheck(resourceBase: string | null | undefined, l: SmartLoad, input: Pick<SmartInput, "bases">): { block?: string; warn?: string } {
  if (!input.bases || !resourceBase || !l.base_id || resourceBase === l.base_id) return {};
  const theirs = input.bases.names[resourceBase] ?? "another base";
  const load = input.bases.names[l.base_id] ?? "the order's base";
  return input.bases.crossBase
    ? { warn: `From ${theirs}; this load is dispatched from ${load}.` }
    : { block: `Based at ${theirs}; this load is dispatched from ${load}, and cross-base dispatch is off.` };
}

export interface SmartDocumentIssue {
  truck_id: string | null;
  trailer_id: string | null;
  kind: string;
  expires_on: string;
  verified: boolean;
  action: "block" | "warn";
  blocks: boolean;
}

/** Plain words for a document issue: "insurance expired 2026-09-30". */
export const documentLabel = (d: Pick<SmartDocumentIssue, "kind" | "expires_on">) => `${d.kind.replace(/_/g, " ")} expired ${d.expires_on}`;

export interface SmartTimeOff {
  driver_id: string;
  status: "approved" | "pending";
  starts_at: string;
  ends_at: string;
}

export interface SmartShopVisit {
  truck_id: string;
  number: string;
  status: string;
  scheduled_for: string | null;
  safety_critical: boolean;
}

/** Hours of service are never assumed: Taviron has no ELD or driver-log data. */
export const HOS_NOTE = "Hours of service are not checked: no ELD or driver-log data is connected. Confirm each driver's available hours before dispatching.";

export interface Candidate {
  truckId: string;
  truckLabel: string;
  /** The trailer a tractor pulls (chosen by the trailer rules); null for trucks that carry the load themselves. */
  trailerId?: string | null;
  trailerLabel?: string | null;
  driverId: string;
  driverLabel: string;
  score: number;
  reasons: string[];
  warnings: string[];
}

export interface Exclusion {
  id: string;
  label: string;
  reasons: string[];
}

export interface LoadPlan {
  load: SmartLoad;
  priority: { rank: number; reasons: string[] };
  /** The proposal; null when no feasible truck-and-driver pair exists. */
  proposal: Candidate | null;
  alternatives: Candidate[];
  excludedTrucks: Exclusion[];
  excludedDrivers: Exclusion[];
  /** When there is no proposal: what prevents it, and options that need a dispatcher's decision. */
  blocked: { why: string[]; options: string[] } | null;
  rejectedPairs: number;
  /** Limits that apply to every proposal. */
  notes: string[];
}

const overlaps = (a: { starts_at: string; ends_at: string }, b: { starts_at: string; ends_at: string }) =>
  new Date(a.starts_at).getTime() < new Date(b.ends_at).getTime() && new Date(b.starts_at).getTime() < new Date(a.ends_at).getTime();

/** Capacity of a truck in the load's unit, or null when unknown or not comparable. */
export function capacityIn(t: Pick<SmartTruck, "weight_capacity" | "weight_unit" | "volume_capacity">, unit: string | null): number | null {
  if (unit === "ton" && t.weight_capacity !== null) return t.weight_unit === "lb" ? Number(t.weight_capacity) / 2000 : Number(t.weight_capacity);
  if (unit === "cu_yd" && t.volume_capacity !== null) return Number(t.volume_capacity);
  return null;
}
const comparableUnit = (unit: string | null) => unit === "ton" || unit === "cu_yd";
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const unitLabel = (u: string | null) => (u === "cu_yd" ? "cu yd" : u ?? "");

function priorityOf(l: SmartLoad, today: string): { rank: number; reasons: string[] } {
  const reasons: string[] = [];
  let rank = 3;
  if (l.urgent) {
    rank = 0;
    reasons.push(l.needed_by ? "Urgent order (flagged by the office, needed by a set time)" : "Urgent order (flagged by the office)");
  }
  if (l.requested_date && l.requested_date < l.load_date) {
    rank = Math.min(rank, 1);
    reasons.push(`Planned after the customer's requested date (${l.requested_date})`);
  }
  if (l.load_date <= today) {
    rank = Math.min(rank, 1);
    reasons.push(l.load_date < today ? "Load date has passed" : "Due today");
  } else if (l.load_date <= addDays(today, 1)) {
    rank = Math.min(rank, 2);
    reasons.push("Due tomorrow");
  }
  return { rank, reasons };
}

/** Deterministic order: most urgent first, then earliest. */
export function orderLoads(loads: SmartLoad[], today: string): SmartLoad[] {
  return [...loads].sort((a, b) => {
    const pa = priorityOf(a, today).rank;
    const pb = priorityOf(b, today).rank;
    return pa - pb || a.load_date.localeCompare(b.load_date) || a.starts_at.localeCompare(b.starts_at) || a.order_number.localeCompare(b.order_number) || a.load_number - b.load_number || a.id.localeCompare(b.id);
  });
}

interface Reservation {
  load: SmartLoad;
  truckId: string;
  driverId: string;
  trailerId?: string | null;
}

/**
 * Lookups by truck and driver, built once per input (P8: scanning every list for every truck and driver of every load
 * was the board's main cost with large fleets). Same data and rules as the plain filters it replaces.
 */
interface InputIndex {
  shopByTruck: Map<string, NonNullable<SmartInput["shopVisits"]>>;
  reportsByTruck: Map<string, SmartInput["truckReports"]>;
  docsByTruck: Map<string, NonNullable<SmartInput["documentIssues"]>>;
  bookingsByTruck: Map<string, SmartBooking[]>;
  bookingsByDriver: Map<string, SmartBooking[]>;
  timeOffByDriver: Map<string, SmartTimeOff[]>;
  onLeave: Set<string>;
  trucksById: Map<string, SmartTruck>;
  driversById: Map<string, SmartDriver>;
  checks: Map<string, ReturnType<typeof driverChecks>>;
}
const INDEXES = new WeakMap<SmartInput, InputIndex>();
function groupBy<T>(rows: readonly T[], key: (r: T) => string | null | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    const list = m.get(k);
    if (list) list.push(r); else m.set(k, [r]);
  }
  return m;
}
function indexOf(input: SmartInput): InputIndex {
  let ix = INDEXES.get(input);
  if (!ix) {
    ix = {
      shopByTruck: groupBy(input.shopVisits ?? [], (v) => v.truck_id),
      reportsByTruck: groupBy(input.truckReports, (r) => r.truck_id),
      docsByTruck: groupBy(input.documentIssues ?? [], (d) => d.truck_id),
      bookingsByTruck: groupBy(input.bookings, (b) => b.truck_id),
      bookingsByDriver: groupBy(input.bookings, (b) => b.driver_id),
      timeOffByDriver: groupBy(input.timeOff ?? [], (t) => t.driver_id),
      onLeave: new Set(input.driversOnLeave ?? []),
      trucksById: new Map(input.trucks.map((t) => [t.id, t])),
      driversById: new Map(input.drivers.map((d) => [d.id, d])),
      checks: new Map(),
    };
    INDEXES.set(input, ix);
  }
  return ix;
}
const NONE: never[] = [];

/**
 * Proposals made so far that overlap one load, worked out once per load instead of once per truck and driver: the
 * trailers already proposed (not offered again), and the first overlapping proposal per truck and per driver.
 */
interface Overlaps { busy: string[]; truck: Map<string, Reservation>; driver: Map<string, Reservation> }
const NO_OVERLAPS: Overlaps = { busy: [], truck: new Map(), driver: new Map() };
function overlapsFor(reserved: Reservation[], l: SmartLoad): Overlaps {
  if (!reserved.length) return NO_OVERLAPS;
  const o: Overlaps = { busy: [], truck: new Map(), driver: new Map() };
  for (const r of reserved) {
    if (!overlaps(r.load, l)) continue;
    if (r.trailerId) o.busy.push(r.trailerId);
    if (!o.truck.has(r.truckId)) o.truck.set(r.truckId, r);
    if (!o.driver.has(r.driverId)) o.driver.set(r.driverId, r);
  }
  return o;
}

/** Qualification checks depend only on the driver and the date: computed once per driver per day. */
function checksOn(d: SmartDriver, date: string, input: SmartInput) {
  const cache = indexOf(input).checks;
  const key = `${d.id}|${date}`;
  let c = cache.get(key);
  if (!c) cache.set(key, (c = driverChecks({ active: d.active, qualifications: d.qualifications }, false, date)));
  return c;
}

function truckExclusions(t: SmartTruck, l: SmartLoad, input: SmartInput, taken: Overlaps): string[] {
  const ix = indexOf(input);
  const out: string[] = [];
  if (!t.active) out.push(eligibilityMessage("truck_inactive"));
  if (t.service_status === "out_of_service") out.push(`Out of service${t.expected_return_date ? ` (expected back ${t.expected_return_date})` : ""}.`);
  const shop = ix.shopByTruck.get(t.id) ?? NONE;
  const restricted = shop.find((v) => v.safety_critical);
  if (restricted) out.push(`Safety-critical work order ${restricted.number} is open — the truck returns only through clearance in Maintenance.`);
  const visit = shop.find((v) => v.scheduled_for === l.load_date && v.status !== "awaiting_inspection");
  if (visit) out.push(`In the shop on this date (${visit.number}).`);
  const safety = (ix.reportsByTruck.get(t.id) ?? NONE).filter((r) => r.kind === "breakdown" || r.kind === "inspection_issue");
  if (safety.length) out.push("A driver reported a breakdown or inspection problem that is not resolved — resolve the report before assigning it.");
  const base = baseCheck(t.base_id, l, input).block;
  if (base) out.push(base);
  const tractor = t.truck_type === "tractor";
  if (tractor && !input.pickTrailer) out.push("A tractor needs a trailer; Smart Dispatch does not choose trailers — assign it on the board.");
  else if (tractor && !input.pickTrailer!(t, l, null, taken.busy)) out.push("No usable trailer is free at this time (compatible, in service, not booked, enough combined capacity).");
  for (const d of (ix.docsByTruck.get(t.id) ?? NONE).filter((x) => x.blocks && x.expires_on < l.load_date)) {
    out.push(`Its ${documentLabel(d)} (verified) — the company rule blocks it until the renewed document is recorded in Fleet.`);
  }
  // A tractor's capacity is checked together with its trailer (pickTrailer).
  if (!(tractor && input.pickTrailer) && l.planned_quantity !== null && comparableUnit(l.unit_code)) {
    const cap = capacityIn(t, l.unit_code);
    if (cap !== null && l.planned_quantity > cap) out.push(`Planned ${fmt(l.planned_quantity)} ${unitLabel(l.unit_code)} exceeds its recorded capacity of ${fmt(cap)} ${unitLabel(l.unit_code)}.`);
  }
  const clash = (ix.bookingsByTruck.get(t.id) ?? NONE).find((b) => b.load_id !== l.id && overlaps(b, l));
  if (clash) out.push("Already booked at an overlapping time.");
  const r = taken.truck.get(t.id);
  if (r) out.push(`Proposed for ${r.load.order_number} load ${r.load.load_number}, which is more urgent or earlier.`);
  return out;
}

function driverExclusions(d: SmartDriver, l: SmartLoad, taken: Overlaps, input: SmartInput): { blockers: string[]; warnings: string[] } {
  const ix = indexOf(input);
  const checks = checksOn(d, l.load_date, input);
  const blockers = checks.blockers.map(eligibilityMessage);
  const base = baseCheck(d.base_id, l, input);
  if (base.block) blockers.push(base.block);
  const leave = (ix.timeOffByDriver.get(d.id) ?? NONE).filter((t) => overlaps(t, l));
  if (leave.some((t) => t.status === "approved")) blockers.push("Approved time off covers this load's time.");
  const pendingLeave = leave.some((t) => t.status === "pending");
  if ((ix.bookingsByDriver.get(d.id) ?? NONE).find((b) => b.load_id !== l.id && overlaps(b, l))) blockers.push("Already booked at an overlapping time.");
  const r = taken.driver.get(d.id);
  if (r) blockers.push(`Proposed for ${r.load.order_number} load ${r.load.load_number}, which is more urgent or earlier.`);
  const warnings = checks.warnings.map(eligibilityMessage);
  if (base.warn) warnings.push(base.warn);
  if (pendingLeave) warnings.push("Has a pending time-off request for this time — confirm before relying on them.");
  if (ix.onLeave.has(d.id)) warnings.push("Their employee record says On leave — confirm they are working that day.");
  return { blockers, warnings };
}

interface Scored {
  id: string;
  label: string;
  score: number;
  reasons: string[];
  warnings: string[];
}

function scoreTruck(t: SmartTruck, l: SmartLoad, input: SmartInput, dayWork: Array<{ truck_id: string; driver_id: string; order_id: string; site: string; load_date: string }>): Scored {
  let score = 0;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const sameDay = dayWork.filter((w) => w.truck_id === t.id && w.load_date === l.load_date);
  const other = baseCheck(t.base_id, l, input).warn;
  if (other) {
    score -= 25; // same-base trucks first
    warnings.push(other);
  }
  if (sameDay.some((w) => w.order_id === l.order_id)) {
    score += 30;
    reasons.push("Already working this job that day (no extra trip to a new site).");
  } else if (l.site && sameDay.some((w) => w.site === l.site)) {
    score += 20;
    reasons.push("Already delivering to the same site that day.");
  }
  if (l.planned_quantity !== null && comparableUnit(l.unit_code)) {
    const cap = capacityIn(t, l.unit_code);
    if (cap !== null && cap > 0) {
      const used = Math.min(l.planned_quantity / cap, 1);
      score += Math.round(used * 20);
      reasons.push(`Uses ${Math.round(used * 100)}% of its recorded capacity (${fmt(cap)} ${unitLabel(l.unit_code)}).`);
    } else {
      score -= 5;
      warnings.push(`Capacity in ${unitLabel(l.unit_code)} is not recorded — check the truck can carry ${fmt(l.planned_quantity)} ${unitLabel(l.unit_code)}.`);
    }
  }
  if (t.capacity_verified_at === null && (t.weight_capacity !== null || t.volume_capacity !== null)) {
    score -= 3;
    warnings.push(eligibilityMessage("truck_capacity_unverified"));
  }
  const ix = indexOf(input);
  for (const d of (ix.docsByTruck.get(t.id) ?? NONE).filter((x) => !x.blocks && x.expires_on < l.load_date)) {
    warnings.push(`Its ${documentLabel(d)} on record${d.verified ? "" : " (not verified)"} — confirm it was renewed.`);
  }
  const inShop = (ix.shopByTruck.get(t.id) ?? NONE).find((v) => v.status === "in_progress" || v.status === "awaiting_parts");
  if (inShop) {
    score -= 10;
    warnings.push(`Shop work ${inShop.number} is ${inShop.status.replace("_", " ")} — check with the shop.`);
  }
  if ((ix.reportsByTruck.get(t.id) ?? NONE).some((r) => r.kind === "equipment_issue")) {
    score -= 10;
    warnings.push(eligibilityMessage("truck_equipment_report_open"));
  }
  if (sameDay.length > 0 && !reasons.length) reasons.push(`Already running ${sameDay.length} load${sameDay.length === 1 ? "" : "s"} that day.`);
  return { id: t.id, label: t.unit_number, score, reasons, warnings };
}

function scoreDriver(d: SmartDriver, l: SmartLoad, warnings: string[], dayWork: Array<{ truck_id: string; driver_id: string; order_id: string; load_date: string }>, input: Pick<SmartInput, "bases"> = {}): Scored {
  let score = baseCheck(d.base_id, l, input).warn ? -25 : 0; // same-base drivers first
  const reasons: string[] = [];
  const sameDay = dayWork.filter((w) => w.driver_id === d.id && w.load_date === l.load_date);
  if (sameDay.some((w) => w.order_id === l.order_id)) {
    score += 20;
    reasons.push("Already driving this job that day.");
  }
  score -= sameDay.length * 8;
  const total = dayWork.filter((w) => w.driver_id === d.id).length;
  score -= total * 2;
  reasons.push(sameDay.length === 0 ? "Has no other loads that day." : `Has ${sameDay.length} other load${sameDay.length === 1 ? "" : "s"} that day.`);
  score -= warnings.length * 3;
  return { id: d.id, label: d.name, score, reasons, warnings };
}

const byScore = (a: Scored, b: Scored) => b.score - a.score || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

/** Plan every unassigned load in the input, most urgent first. */
export function recommend(input: SmartInput): LoadPlan[] {
  const reserved: Reservation[] = [];
  const plans: LoadPlan[] = [];
  const notes = [
    "Travel distance is not calculated: no truck locations are recorded. Job and site continuity are used instead.",
    HOS_NOTE,
    ...(input.maintenanceChecked === false ? ["Maintenance shop dates were not checked: the maintenance database update is not installed yet."] : []),
    ...(input.timeOffChecked === false ? ["Driver time off was not checked: the time-off database update is not installed yet."] : []),
  ];

  // Existing bookings, then each proposal as it is made: each truck and driver only looks at its own work.
  const dayWork = input.bookings.map((b) => ({ truck_id: b.truck_id, driver_id: b.driver_id, order_id: b.order_id, site: b.site, load_date: b.load_date }));
  const workByTruck = groupBy(dayWork, (w) => w.truck_id);
  const workByDriver = groupBy(dayWork, (w) => w.driver_id);

  for (const load of orderLoads(input.loads, input.today)) {
    const taken = overlapsFor(reserved, load);
    const excludedTrucks: Exclusion[] = [];
    const okTrucks: Scored[] = [];
    for (const t of input.trucks) {
      const why = truckExclusions(t, load, input, taken);
      if (why.length) excludedTrucks.push({ id: t.id, label: t.unit_number, reasons: why });
      else okTrucks.push(scoreTruck(t, load, input, workByTruck.get(t.id) ?? NONE));
    }
    const excludedDrivers: Exclusion[] = [];
    const okDrivers: Scored[] = [];
    for (const d of input.drivers) {
      const x = driverExclusions(d, load, taken, input);
      if (x.blockers.length) excludedDrivers.push({ id: d.id, label: d.name, reasons: x.blockers });
      else okDrivers.push(scoreDriver(d, load, x.warnings, workByDriver.get(d.id) ?? NONE, input));
    }
    okTrucks.sort(byScore);
    okDrivers.sort(byScore);
    excludedTrucks.sort((a, b) => a.label.localeCompare(b.label));
    excludedDrivers.sort((a, b) => a.label.localeCompare(b.label));

    const rejected = input.rejections.filter((r) => r.load_id === load.id);
    const pairs: Candidate[] = [];
    for (const t of okTrucks.slice(0, 4)) {
      const truck = indexOf(input).trucksById.get(t.id)!;
      for (const d of okDrivers.slice(0, 4)) {
        if (rejected.some((r) => r.truck_id === t.id && r.driver_id === d.id)) continue;
        // A tractor needs a trailer the driver may pull (combination licence); otherwise the pair is not offered.
        const trailer = truck.truck_type === "tractor" && input.pickTrailer ? input.pickTrailer(truck, load, indexOf(input).driversById.get(d.id) ?? null, taken.busy) : null;
        if (truck.truck_type === "tractor" && !trailer) continue;
        pairs.push({
          truckId: t.id, truckLabel: trailer ? `${t.label} + ${trailer.unit_number}` : t.label, trailerId: trailer?.id ?? null, trailerLabel: trailer?.unit_number ?? null,
          driverId: d.id, driverLabel: d.label, score: t.score + d.score, reasons: [...t.reasons, ...d.reasons], warnings: [...t.warnings, ...d.warnings],
        });
      }
    }
    pairs.sort((a, b) => b.score - a.score || a.truckLabel.localeCompare(b.truckLabel) || a.driverLabel.localeCompare(b.driverLabel) || a.truckId.localeCompare(b.truckId) || a.driverId.localeCompare(b.driverId));
    const proposal = pairs[0] ?? null;
    // Alternatives: prefer a different truck, then a different driver, then the rest — so
    // the options are real choices rather than the same truck with every driver.
    const alternatives: Candidate[] = [];
    if (proposal) {
      const rest = pairs.slice(1);
      const pick = (pred: (c: Candidate) => boolean) => {
        const c = rest.find((x) => pred(x) && !alternatives.includes(x));
        if (c) alternatives.push(c);
      };
      pick((c) => c.truckId !== proposal.truckId && c.driverId !== proposal.driverId);
      pick((c) => c.truckId !== proposal.truckId);
      pick((c) => c.driverId !== proposal.driverId);
      for (const c of rest) if (alternatives.length < 3 && !alternatives.includes(c)) alternatives.push(c);
    }

    let blocked: LoadPlan["blocked"] = null;
    if (!proposal) {
      const why: string[] = [];
      const options: string[] = [];
      if (input.trucks.length === 0) why.push("No active trucks are recorded.");
      else if (okTrucks.length === 0) why.push(`None of the ${input.trucks.length} trucks can take this load (see the reasons below).`);
      if (input.drivers.length === 0) why.push("No active drivers are recorded.");
      else if (okDrivers.length === 0) why.push(`None of the ${input.drivers.length} drivers can take this load (see the reasons below).`);
      if (okTrucks.length && okDrivers.length) why.push("Every remaining truck-and-driver pair was rejected by a dispatcher. Reconsider them, or assign manually.");
      // Options that need a dispatcher's decision — never applied automatically.
      for (const t of excludedTrucks) {
        const truck = input.trucks.find((x) => x.id === t.id)!;
        if (truck.service_status === "out_of_service" && truck.expected_return_date && t.reasons.length === 1) {
          options.push(`Truck ${t.label} is expected back in service on ${truck.expected_return_date}${truck.expected_return_date > load.load_date ? " — after this load's date" : ""}.`);
        }
        if (t.reasons.length === 1 && t.reasons[0].startsWith("Already booked") ) options.push(`Truck ${t.label} is free at another time that day — moving the load's time would need the customer's agreement.`);
      }
      for (const d of excludedDrivers) {
        if (d.reasons.every((r) => /not been verified/.test(r))) options.push(`${d.label} would be eligible once the qualification is verified in Fleet → Drivers.`);
        if (d.reasons.length === 1 && d.reasons[0].startsWith("Already booked")) options.push(`${d.label} is free at another time that day — moving the load's time would need the customer's agreement.`);
      }
      // Feasible on a later day? (same hours; resources' existing bookings only)
      for (let i = 1; i <= 3; i++) {
        const day = addDays(load.load_date, i);
        const shift = (iso: string) => new Date(new Date(iso).getTime() + i * 86400_000).toISOString();
        const moved = { ...load, load_date: day, starts_at: shift(load.starts_at), ends_at: shift(load.ends_at) };
        const anyTruck = input.trucks.some((t) => truckExclusions(t, moved, input, NO_OVERLAPS).length === 0);
        const anyDriver = input.drivers.some((d) => driverExclusions(d, moved, NO_OVERLAPS, input).blockers.length === 0);
        if (anyTruck && anyDriver) {
          const late = load.requested_date !== null && day > load.requested_date;
          options.push(`A truck and a driver are available on ${day} at the same time${late ? ` — later than the customer's requested date (${load.requested_date}); confirm with the customer first` : ""}.`);
          break;
        }
      }
      blocked = { why, options };
    } else {
      reserved.push({ load, truckId: proposal.truckId, driverId: proposal.driverId, trailerId: proposal.trailerId ?? null });
      const work = { truck_id: proposal.truckId, driver_id: proposal.driverId, order_id: load.order_id, site: load.site, load_date: load.load_date };
      for (const [m, k] of [[workByTruck, work.truck_id], [workByDriver, work.driver_id]] as const) {
        const list = m.get(k);
        if (list) list.push(work); else m.set(k, [work]);
      }
    }

    plans.push({
      load,
      priority: priorityOf(load, input.today),
      proposal,
      alternatives,
      excludedTrucks,
      excludedDrivers,
      blocked,
      rejectedPairs: rejected.length,
      notes,
    });
  }
  return plans;
}

/**
 * Re-check one truck/driver pair for one load right before approval, ignoring
 * proposals for other loads (the dispatcher may choose differently). Hard
 * constraints only; the database re-checks them again when assigning.
 */
/**
 * Why each truck and driver cannot take `loadId` on its own (hard rules only, against existing bookings; no proposals).
 * The same rules as checkPair, per resource, so a planner can say which trucks and drivers are unavailable and why.
 * Resources with no reason are omitted.
 */
export function resourceExclusions(input: SmartInput, loadId: string): { trucks: Map<string, string[]>; drivers: Map<string, string[]> } {
  const load = input.loads.find((l) => l.id === loadId);
  const trucks = new Map<string, string[]>();
  const drivers = new Map<string, string[]>();
  if (!load) return { trucks, drivers };
  for (const t of input.trucks) {
    const r = truckExclusions(t, load, input, NO_OVERLAPS);
    if (r.length) trucks.set(t.id, r);
  }
  for (const d of input.drivers) {
    const r = driverExclusions(d, load, NO_OVERLAPS, input).blockers;
    if (r.length) drivers.set(d.id, r);
  }
  return { trucks, drivers };
}

/**
 * checkPair's halves for one load, for callers that test every truck against every driver (Plan the day): a pair is
 * feasible exactly when the truck has no blocker, the driver has none, and a dispatcher has not rejected the pair.
 */
export const truckBlockers = (input: SmartInput, load: SmartLoad, truck: SmartTruck): string[] => truckExclusions(truck, load, input, NO_OVERLAPS);
export const driverBlockers = (input: SmartInput, load: SmartLoad, driver: SmartDriver): string[] =>
  driverExclusions(driver, load, NO_OVERLAPS, input).blockers;

export function checkPair(input: SmartInput, loadId: string, truckId: string, driverId: string): { ok: boolean; reasons: string[] } {
  const load = input.loads.find((l) => l.id === loadId);
  if (!load) return { ok: false, reasons: ["The load is no longer waiting for a truck (it was assigned, canceled or rescheduled)."] };
  const truck = input.trucks.find((t) => t.id === truckId);
  const driver = input.drivers.find((d) => d.id === driverId);
  const reasons: string[] = [];
  if (!truck) reasons.push("The truck is no longer active.");
  else reasons.push(...truckExclusions(truck, load, input, NO_OVERLAPS).map((r) => `Truck ${truck.unit_number}: ${r}`));
  if (!driver) reasons.push("The driver is no longer active.");
  else reasons.push(...driverExclusions(driver, load, NO_OVERLAPS, input).blockers.map((r) => `${driver.name}: ${r}`));
  if (input.rejections.some((r) => r.load_id === loadId && r.truck_id === truckId && r.driver_id === driverId)) reasons.push("This pair was rejected by a dispatcher.");
  return { ok: reasons.length === 0, reasons };
}

/** Exclusions grouped by reason for the board: how many units each reason rules out, with a few examples. */
export interface ExclusionGroup { kind: "truck" | "driver"; reason: string; count: number; examples: string[] }

/** What the board sends to the browser per load: the plan without one row per excluded unit (P8, docs/OPTIMIZATION.md). */
export type BoardPlan = Omit<LoadPlan, "excludedTrucks" | "excludedDrivers"> & {
  excluded: { trucks: number; drivers: number; groups: ExclusionGroup[] };
};

/**
 * Groups a plan's exclusions by reason (a unit with two reasons counts under both), most common first, with up to
 * `examples` unit labels each. Keeps every reason visible while the page stays small with large fleets.
 */
/**
 * The reason without unit-specific details (work order numbers, dates), so units ruled out for the same cause share
 * one line; the examples still name the units. Unit pages show the details.
 */
export function reasonKey(reason: string): string {
  return reason
    .replace(/\s*\((?:expected back|WO-)[^)]*\)/g, "")
    .replace(/ (?:work order )?WO-\d{4}-\d+/g, (m) => (m.startsWith(" work order") ? " work order" : ""))
    .replace(/ expired \d{4}-\d{2}-\d{2}/g, " has expired")
    .replace(/^Proposed for \S+ load \d+, which is more urgent or earlier\.$/, "Proposed for a more urgent or earlier load.")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function toBoardPlan(plan: LoadPlan, examples = 6): BoardPlan {
  const { excludedTrucks, excludedDrivers, ...rest } = plan;
  const groups = new Map<string, ExclusionGroup>();
  const add = (kind: "truck" | "driver", list: Exclusion[]) => {
    for (const e of list) {
      for (const raw of e.reasons) {
        const reason = reasonKey(raw);
        const key = `${kind}\u0000${reason}`;
        const g = groups.get(key) ?? { kind, reason, count: 0, examples: [] };
        g.count += 1;
        if (g.examples.length < examples) g.examples.push(e.label);
        groups.set(key, g);
      }
    }
  };
  add("truck", excludedTrucks);
  add("driver", excludedDrivers);
  const sorted = [...groups.values()].sort((a, b) => (a.kind === b.kind ? b.count - a.count : a.kind === "truck" ? -1 : 1));
  return { ...rest, excluded: { trucks: excludedTrucks.length, drivers: excludedDrivers.length, groups: sorted } };
}
