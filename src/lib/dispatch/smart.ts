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
// Loads are handled most urgent first (open urgent flag, customer's requested
// date passed, earliest load), and a truck or driver proposed for a more urgent
// load is not proposed again for an overlapping one.

import { addDays } from "@/lib/dates";
import { driverChecks, eligibilityMessage, type EligibilityQualification } from "@/lib/fleet/eligibility";

export interface SmartLoad {
  id: string;
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
  name: string;
  active: boolean;
  qualifications: EligibilityQualification[];
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
  /** False when the maintenance schedule could not be read (database update not installed). */
  maintenanceChecked?: boolean;
  /** Approved and pending time off of drivers (no category or reason). */
  timeOff?: SmartTimeOff[];
  /** False when time off could not be read (database update not installed). */
  timeOffChecked?: boolean;
  /** Drivers whose employee record says On leave (an HR status, separate from dated time off): a warning, never a block. */
  driversOnLeave?: string[];
}

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
}

function truckExclusions(t: SmartTruck, l: SmartLoad, input: SmartInput, reserved: Reservation[], bookingsById: SmartBooking[]): string[] {
  const out: string[] = [];
  if (!t.active) out.push(eligibilityMessage("truck_inactive"));
  if (t.service_status === "out_of_service") out.push(`Out of service${t.expected_return_date ? ` (expected back ${t.expected_return_date})` : ""}.`);
  const shop = (input.shopVisits ?? []).filter((v) => v.truck_id === t.id);
  const restricted = shop.find((v) => v.safety_critical);
  if (restricted) out.push(`Safety-critical work order ${restricted.number} is open — the truck returns only through clearance in Maintenance.`);
  const visit = shop.find((v) => v.scheduled_for === l.load_date && v.status !== "awaiting_inspection");
  if (visit) out.push(`In the shop on this date (${visit.number}).`);
  const safety = input.truckReports.filter((r) => r.truck_id === t.id && (r.kind === "breakdown" || r.kind === "inspection_issue"));
  if (safety.length) out.push("A driver reported a breakdown or inspection problem that is not resolved — resolve the report before assigning it.");
  if (t.truck_type === "tractor") out.push("A tractor needs a trailer; Smart Dispatch does not choose trailers — assign it on the board.");
  if (l.planned_quantity !== null && comparableUnit(l.unit_code)) {
    const cap = capacityIn(t, l.unit_code);
    if (cap !== null && l.planned_quantity > cap) out.push(`Planned ${fmt(l.planned_quantity)} ${unitLabel(l.unit_code)} exceeds its recorded capacity of ${fmt(cap)} ${unitLabel(l.unit_code)}.`);
  }
  const clash = bookingsById.find((b) => b.truck_id === t.id && b.load_id !== l.id && overlaps(b, l));
  if (clash) out.push("Already booked at an overlapping time.");
  const r = reserved.find((x) => x.truckId === t.id && overlaps(x.load, l));
  if (r) out.push(`Proposed for ${r.load.order_number} load ${r.load.load_number}, which is more urgent or earlier.`);
  return out;
}

function driverExclusions(d: SmartDriver, l: SmartLoad, reserved: Reservation[], bookings: SmartBooking[], timeOff: SmartTimeOff[] = [], onLeave: string[] = []): { blockers: string[]; warnings: string[] } {
  const checks = driverChecks({ active: d.active, qualifications: d.qualifications }, false, l.load_date);
  const blockers = checks.blockers.map(eligibilityMessage);
  const leave = timeOff.filter((t) => t.driver_id === d.id && overlaps(t, l));
  if (leave.some((t) => t.status === "approved")) blockers.push("Approved time off covers this load's time.");
  const pendingLeave = leave.some((t) => t.status === "pending");
  if (bookings.find((b) => b.driver_id === d.id && b.load_id !== l.id && overlaps(b, l))) blockers.push("Already booked at an overlapping time.");
  const r = reserved.find((x) => x.driverId === d.id && overlaps(x.load, l));
  if (r) blockers.push(`Proposed for ${r.load.order_number} load ${r.load.load_number}, which is more urgent or earlier.`);
  const warnings = checks.warnings.map(eligibilityMessage);
  if (pendingLeave) warnings.push("Has a pending time-off request for this time — confirm before relying on them.");
  if (onLeave.includes(d.id)) warnings.push("Their employee record says On leave — confirm they are working that day.");
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
  const inShop = (input.shopVisits ?? []).find((v) => v.truck_id === t.id && (v.status === "in_progress" || v.status === "awaiting_parts"));
  if (inShop) {
    score -= 10;
    warnings.push(`Shop work ${inShop.number} is ${inShop.status.replace("_", " ")} — check with the shop.`);
  }
  if (input.truckReports.some((r) => r.truck_id === t.id && r.kind === "equipment_issue")) {
    score -= 10;
    warnings.push(eligibilityMessage("truck_equipment_report_open"));
  }
  if (sameDay.length > 0 && !reasons.length) reasons.push(`Already running ${sameDay.length} load${sameDay.length === 1 ? "" : "s"} that day.`);
  return { id: t.id, label: t.unit_number, score, reasons, warnings };
}

function scoreDriver(d: SmartDriver, l: SmartLoad, warnings: string[], dayWork: Array<{ truck_id: string; driver_id: string; order_id: string; load_date: string }>): Scored {
  let score = 0;
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

  for (const load of orderLoads(input.loads, input.today)) {
    const dayWork = [
      ...input.bookings.map((b) => ({ truck_id: b.truck_id, driver_id: b.driver_id, order_id: b.order_id, site: b.site, load_date: b.load_date })),
      ...reserved.map((r) => ({ truck_id: r.truckId, driver_id: r.driverId, order_id: r.load.order_id, site: r.load.site, load_date: r.load.load_date })),
    ];

    const excludedTrucks: Exclusion[] = [];
    const okTrucks: Scored[] = [];
    for (const t of input.trucks) {
      const why = truckExclusions(t, load, input, reserved, input.bookings);
      if (why.length) excludedTrucks.push({ id: t.id, label: t.unit_number, reasons: why });
      else okTrucks.push(scoreTruck(t, load, input, dayWork));
    }
    const excludedDrivers: Exclusion[] = [];
    const okDrivers: Scored[] = [];
    for (const d of input.drivers) {
      const x = driverExclusions(d, load, reserved, input.bookings, input.timeOff, input.driversOnLeave);
      if (x.blockers.length) excludedDrivers.push({ id: d.id, label: d.name, reasons: x.blockers });
      else okDrivers.push(scoreDriver(d, load, x.warnings, dayWork));
    }
    okTrucks.sort(byScore);
    okDrivers.sort(byScore);
    excludedTrucks.sort((a, b) => a.label.localeCompare(b.label));
    excludedDrivers.sort((a, b) => a.label.localeCompare(b.label));

    const rejected = input.rejections.filter((r) => r.load_id === load.id);
    const pairs: Candidate[] = [];
    for (const t of okTrucks.slice(0, 4)) {
      for (const d of okDrivers.slice(0, 4)) {
        if (rejected.some((r) => r.truck_id === t.id && r.driver_id === d.id)) continue;
        pairs.push({ truckId: t.id, truckLabel: t.label, driverId: d.id, driverLabel: d.label, score: t.score + d.score, reasons: [...t.reasons, ...d.reasons], warnings: [...t.warnings, ...d.warnings] });
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
        const anyTruck = input.trucks.some((t) => truckExclusions(t, moved, input, [], input.bookings).length === 0);
        const anyDriver = input.drivers.some((d) => driverExclusions(d, moved, [], input.bookings, input.timeOff, input.driversOnLeave).blockers.length === 0);
        if (anyTruck && anyDriver) {
          const late = load.requested_date !== null && day > load.requested_date;
          options.push(`A truck and a driver are available on ${day} at the same time${late ? ` — later than the customer's requested date (${load.requested_date}); confirm with the customer first` : ""}.`);
          break;
        }
      }
      blocked = { why, options };
    } else {
      reserved.push({ load, truckId: proposal.truckId, driverId: proposal.driverId });
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
    const r = truckExclusions(t, load, input, [], input.bookings);
    if (r.length) trucks.set(t.id, r);
  }
  for (const d of input.drivers) {
    const r = driverExclusions(d, load, [], input.bookings, input.timeOff, input.driversOnLeave).blockers;
    if (r.length) drivers.set(d.id, r);
  }
  return { trucks, drivers };
}

export function checkPair(input: SmartInput, loadId: string, truckId: string, driverId: string): { ok: boolean; reasons: string[] } {
  const load = input.loads.find((l) => l.id === loadId);
  if (!load) return { ok: false, reasons: ["The load is no longer waiting for a truck (it was assigned, canceled or rescheduled)."] };
  const truck = input.trucks.find((t) => t.id === truckId);
  const driver = input.drivers.find((d) => d.id === driverId);
  const reasons: string[] = [];
  if (!truck) reasons.push("The truck is no longer active.");
  else reasons.push(...truckExclusions(truck, load, input, [], input.bookings).map((r) => `Truck ${truck.unit_number}: ${r}`));
  if (!driver) reasons.push("The driver is no longer active.");
  else reasons.push(...driverExclusions(driver, load, [], input.bookings, input.timeOff, input.driversOnLeave).blockers.map((r) => `${driver.name}: ${r}`));
  if (input.rejections.some((r) => r.load_id === loadId && r.truck_id === truckId && r.driver_id === driverId)) reasons.push("This pair was rejected by a dispatcher.");
  return { ok: reasons.length === 0, reasons };
}
