// AI Optimization Core, first slice (master plan §12 B5; docs/OPTIMIZATION.md): a whole-day plan for every
// unassigned load across the fleet, ranked by the company's chosen priorities. Pure and deterministic — the same
// inputs and priorities always give the same plans. It never assigns anything: a dispatcher approves assignments,
// each of which goes through the same re-check and public.assign_load as a single Smart Dispatch approval.
//
// Hard constraints come from Smart Dispatch (`checkPair`: service status, safety work orders, shop dates, driver
// reports, capacity, tractors without a trailer, qualifications, time off, existing bookings, dispatcher
// rejections) plus no overlapping work for one truck, trailer or driver inside the plan. A tractor is planned only with
// a trailer, under the database's own trailer rules (active and in service, compatible with the truck type, not
// booked, combined capacity, class A CDL, no unresolved breakdown or inspection report). A higher score never
// overrides a hard constraint.
//
// Measured quantities are calculated, never guessed: revenue is an estimate from the order's own line rate × the
// load's planned quantity (labelled; missing when the order has no matching rate); operating costs and margin are
// not evaluated because no cost data is recorded; travel distance is not calculated because no truck locations are
// recorded (site continuity is used as the efficiency proxy, and said so); hours of service are not verified
// because no ELD data is connected — so no assignment is ever "Verified feasible" yet, only "Needs review".

import { checkPair, HOS_NOTE, orderLoads, type SmartInput, type SmartLoad, type SmartTruck } from "@/lib/dispatch/smart";
import { driverChecks, eligibilityMessage } from "@/lib/fleet/eligibility";

export type FeasibilityStatus = "verified" | "needs_review" | "blocked";

/** 0 (ignore) – 5 (most important). Configurable per plan run; no single universal weighting. */
export interface Priorities {
  service: number; // urgent orders, overdue and due-soon requested dates
  revenue: number; // estimated load revenue (never margin: costs are unknown)
  utilization: number; // use of each truck's recorded capacity
  efficiency: number; // keeping a truck and driver on one site or job (fewer empty repositioning trips — proxy)
  balance: number; // spreading loads evenly across drivers
}

export const PRIORITY_KEYS = ["service", "revenue", "utilization", "efficiency", "balance"] as const;

export const PRIORITY_LABELS: Record<keyof Priorities, string> = {
  service: "Service reliability",
  revenue: "Revenue (estimate)",
  utilization: "Truck utilization",
  efficiency: "Fewer empty trips",
  balance: "Driver workload balance",
};

export const PRESETS: Record<string, { label: string; priorities: Priorities }> = {
  balanced: { label: "Balanced", priorities: { service: 3, revenue: 3, utilization: 3, efficiency: 3, balance: 3 } },
  service: { label: "Service first", priorities: { service: 5, revenue: 1, utilization: 2, efficiency: 2, balance: 2 } },
  revenue: { label: "Revenue first", priorities: { service: 2, revenue: 5, utilization: 3, efficiency: 2, balance: 1 } },
  efficiency: { label: "Efficiency first", priorities: { service: 2, revenue: 2, utilization: 5, efficiency: 5, balance: 1 } },
};

export interface OptTrailer {
  id: string;
  unit_number: string;
  active: boolean;
  service_status: "in_service" | "out_of_service";
  weight_capacity: number | null;
  weight_unit: "ton" | "lb" | null;
  volume_capacity: number | null;
  capacity_verified_at: string | null;
  /** Empty: compatibility not recorded (a warning, as in the database). */
  compatible_truck_types: string[];
}

export interface OptimizationInput extends SmartInput {
  /** Active trailers, for tractors (omit when the fleet has none). */
  trailers?: OptTrailer[];
  /** Existing active assignments that use a trailer. */
  trailerBookings?: Array<{ trailer_id: string; load_id: string; starts_at: string; ends_at: string }>;
  /** Unresolved driver reports about trailers. */
  trailerReports?: Array<{ trailer_id: string; kind: string }>;
  /** Estimated revenue per load in cents (order line rate × planned quantity); null when it cannot be estimated. */
  revenueCents: Record<string, number | null>;
  /** Hours of service from an ELD or driver logs. Not connected yet: always false. */
  hoursOfServiceVerified?: boolean;
  /**
   * Latest registration, insurance, inspection or permit on record per vehicle and kind, where it expired before the
   * day (Fleet documents). Shown for review only: no assignment rule uses vehicle documents today.
   */
  expiredDocuments?: Array<{ truck_id: string | null; trailer_id: string | null; kind: string; expires_on: string }>;
  /** False when vehicle documents could not be read (for example without fleet access). */
  documentsChecked?: boolean;
}

export interface PlannedAssignment {
  loadId: string;
  truckId: string;
  truckLabel: string;
  trailerId: string | null;
  trailerLabel: string | null;
  driverId: string;
  driverLabel: string;
  status: Exclude<FeasibilityStatus, "blocked">;
  /** Why this pair (score contributions in plain words). */
  reasons: string[];
  /** What a person must confirm before relying on it. */
  review: string[];
}

export interface UncoveredLoad {
  loadId: string;
  why: string;
}

export interface PlanMetrics {
  loads: number;
  covered: number;
  urgentTotal: number;
  urgentCovered: number;
  overdueTotal: number;
  overdueCovered: number;
  revenueCoveredCents: number;
  revenueUnknownLoads: number;
  trucksUsed: number;
  driversUsed: number;
  /** Mean planned quantity ÷ recorded capacity over assignments where both are known (0–1), or null. */
  averageFill: number | null;
  /** Times a truck changes site within a day in this plan (proxy for empty repositioning). */
  siteChanges: number;
  /** Most minus fewest loads per driver who works in the plan. */
  workloadSpread: number;
  needsReview: number;
}

export interface Plan {
  key: string;
  label: string;
  priorities: Priorities;
  assignments: PlannedAssignment[];
  uncovered: UncoveredLoad[];
  metrics: PlanMetrics;
  score: number;
}

export interface Optimization {
  plans: Plan[];
  /** The plan for the requested priorities (first) and the trade-offs of each alternative against it. */
  tradeoffs: Array<{ key: string; label: string; differences: string[] }>;
  /** Missing, estimated or unverified information that applies to every plan. */
  dataNotes: string[];
  /** Load-level hard-constraint results, for explaining blocked loads. */
  blocked: UncoveredLoad[];
}

type Pair = { truck: SmartTruck; trailer: OptTrailer | null; driverId: string; driverLabel: string; review: string[] };

const overlaps = (a: { starts_at: string; ends_at: string }, b: { starts_at: string; ends_at: string }) => a.starts_at < b.ends_at && b.starts_at < a.ends_at;

type Equipment = Pick<SmartTruck, "weight_capacity" | "weight_unit" | "volume_capacity">;
function equipmentCapacity(t: Equipment, unit: string | null): number | null {
  if (unit === "ton" && t.weight_capacity !== null) return t.weight_unit === "lb" ? t.weight_capacity / 2000 : t.weight_capacity;
  if (unit === "cu_yd" && t.volume_capacity !== null) return t.volume_capacity;
  return null;
}
/** Recorded capacity of a truck plus its trailer (as the database adds them); null when neither is recorded. */
function capacity(t: SmartTruck, unit: string | null, trailer: OptTrailer | null = null): number | null {
  const a = equipmentCapacity(t, unit);
  const b = trailer ? equipmentCapacity(trailer, unit) : null;
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}
const equipmentLabel = (truck: SmartTruck, trailer: OptTrailer | null) => `truck ${truck.unit_number}${trailer ? ` with trailer ${trailer.unit_number}` : ""}`;

/** Hard trailer rules for a tractor pulling `trailer` on `load` (beyond the tractor's own checks). */
function trailerBlockers(input: OptimizationInput, load: SmartLoad, truck: SmartTruck, trailer: OptTrailer, driverId: string): string[] {
  const out: string[] = [];
  if (!trailer.active) out.push(`Trailer ${trailer.unit_number} is deactivated.`);
  if (trailer.service_status === "out_of_service") out.push(`Trailer ${trailer.unit_number} is out of service.`);
  if (trailer.compatible_truck_types.length && !trailer.compatible_truck_types.includes(truck.truck_type)) out.push(`Trailer ${trailer.unit_number} is not compatible with a ${truck.truck_type.replace(/_/g, " ")}.`);
  if ((input.trailerReports ?? []).some((r) => r.trailer_id === trailer.id && (r.kind === "breakdown" || r.kind === "inspection_issue"))) out.push(`A driver reported a breakdown or inspection problem on trailer ${trailer.unit_number} that is not resolved.`);
  if ((input.trailerBookings ?? []).some((b) => b.trailer_id === trailer.id && b.load_id !== load.id && overlaps(b, load))) out.push(`Trailer ${trailer.unit_number} is already booked at an overlapping time.`);
  const cap = capacity(truck, load.unit_code, trailer);
  if (load.planned_quantity !== null && cap !== null && load.planned_quantity > cap) out.push(`Planned ${load.planned_quantity} ${load.unit_code ?? ""} exceeds the recorded capacity of ${equipmentLabel(truck, trailer)}.`);
  const driver = input.drivers.find((d) => d.id === driverId);
  if (driver) out.push(...driverChecks({ active: driver.active, qualifications: driver.qualifications }, true, load.load_date).blockers.map((b) => `${driver.name}: ${eligibilityMessage(b)}`));
  return out;
}

/**
 * Every hard constraint for one assignment, against existing bookings (not other proposals). Used to build plans and
 * again with fresh data right before an approved assignment is made.
 */
export function checkAssignment(input: OptimizationInput, loadId: string, truckId: string, trailerId: string | null, driverId: string): { ok: boolean; reasons: string[] } {
  const truck = input.trucks.find((t) => t.id === truckId);
  const load = input.loads.find((l) => l.id === loadId);
  if (!truck || !load) return checkPair(input, loadId, truckId, driverId);
  const trailer = trailerId ? (input.trailers ?? []).find((t) => t.id === trailerId) ?? null : null;
  if (trailerId && !trailer) return { ok: false, reasons: ["The trailer is no longer active."] };
  if (truck.truck_type !== "tractor" && !trailer) return checkPair(input, loadId, truckId, driverId);
  if (truck.truck_type === "tractor" && !trailer) return { ok: false, reasons: [`Truck ${truck.unit_number} is a tractor: it needs a trailer.`] };
  // The tractor's own checks (service, safety, shop, reports, bookings, driver) without the "needs a trailer" rule and
  // with the combined capacity checked below instead of the tractor's alone.
  const asCarrier: OptimizationInput = { ...input, trucks: input.trucks.map((t) => (t.id === truckId ? { ...t, truck_type: "tractor (with trailer)", weight_capacity: null, volume_capacity: null } : t)) };
  const own = checkPair(asCarrier, loadId, truckId, driverId);
  const reasons = [...own.reasons, ...trailerBlockers(input, load, truck, trailer!, driverId)];
  return { ok: reasons.length === 0, reasons };
}

/** Feasible truck(-and-trailer)-and-driver pairs for each load (hard constraints only, against existing bookings). */
export function feasiblePairs(input: OptimizationInput): Map<string, Pair[]> {
  const out = new Map<string, Pair[]>();
  for (const load of input.loads) {
    const pairs: Pair[] = [];
    for (const truck of input.trucks) {
      // A tractor is tried with each usable trailer, best capacity fit first (at most three per tractor and driver).
      const trailers: Array<OptTrailer | null> = truck.truck_type === "tractor"
        ? [...(input.trailers ?? [])].sort((a, b) => (capacity(truck, load.unit_code, a) ?? Infinity) - (capacity(truck, load.unit_code, b) ?? Infinity) || a.unit_number.localeCompare(b.unit_number))
        : [null];
      for (const driver of input.drivers) {
        let found = 0;
        for (const trailer of trailers) {
          if (found >= 3) break;
          if (!checkAssignment(input, load.id, truck.id, trailer?.id ?? null, driver.id).ok) continue;
          found++;
          pairs.push({ truck, trailer, driverId: driver.id, driverLabel: driver.name, review: reviewReasons(input, load, truck, trailer, driver.id) });
        }
      }
    }
    out.set(load.id, pairs);
  }
  return out;
}

/** Information a person must confirm for a pair that passed every hard constraint. */
function reviewReasons(input: OptimizationInput, load: SmartLoad, truck: SmartTruck, trailer: OptTrailer | null, driverId: string): string[] {
  const r: string[] = [];
  if (!input.hoursOfServiceVerified) r.push("Hours of service not verified (no ELD or driver-log data).");
  if (load.planned_quantity !== null && capacity(truck, load.unit_code, trailer) === null) r.push(`No recorded capacity for ${load.unit_code ?? "this unit"} on ${equipmentLabel(truck, trailer)}.`);
  else if (load.planned_quantity !== null && (trailer ? !trailer.capacity_verified_at : !truck.capacity_verified_at)) r.push(`${trailer ? `Trailer ${trailer.unit_number}` : `Truck ${truck.unit_number}`}'s capacity is not verified.`);
  if (trailer && !trailer.compatible_truck_types.length) r.push(`Trailer ${trailer.unit_number}'s compatible truck types are not recorded.`);
  if (trailer && (input.trailerReports ?? []).some((x) => x.trailer_id === trailer.id)) r.push(`Trailer ${trailer.unit_number} has an open equipment report.`);
  if (input.truckReports.some((x) => x.truck_id === truck.id)) r.push(`Truck ${truck.unit_number} has an open equipment report.`);
  if ((input.timeOff ?? []).some((t) => t.driver_id === driverId && t.status === "pending" && overlaps(t, load))) r.push("The driver has a pending time-off request that day.");
  for (const d of input.expiredDocuments ?? []) {
    if (d.expires_on >= load.load_date) continue;
    const kind = d.kind.replace(/_/g, " ");
    if (d.truck_id === truck.id) r.push(`Truck ${truck.unit_number}'s ${kind} on record expired ${d.expires_on} — confirm it was renewed.`);
    if (trailer && d.trailer_id === trailer.id) r.push(`Trailer ${trailer.unit_number}'s ${kind} on record expired ${d.expires_on} — confirm it was renewed.`);
  }
  if (input.maintenanceChecked === false) r.push("Maintenance shop dates could not be checked.");
  if (input.timeOffChecked === false) r.push("Driver time off could not be checked.");
  return r;
}

function loadValue(load: SmartLoad, input: OptimizationInput, p: Priorities, maxRevenue: number): { value: number; reasons: string[] } {
  const reasons: string[] = [];
  let value = 100; // covering a load always matters
  if (load.urgent) { value += 12 * p.service; reasons.push("urgent order"); }
  if (load.requested_date && load.requested_date < load.load_date) { value += 8 * p.service; reasons.push(`customer asked for ${load.requested_date}`); }
  else if (load.requested_date && load.requested_date <= load.load_date) { value += 4 * p.service; reasons.push("due on this date"); }
  const rev = input.revenueCents[load.id];
  if (rev !== null && rev !== undefined && maxRevenue > 0) value += (10 * p.revenue * rev) / maxRevenue;
  return { value, reasons };
}

function pairScore(load: SmartLoad, pair: Pair, p: Priorities, plan: PlannedAssignment[], loads: Map<string, SmartLoad>, input: OptimizationInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const cap = capacity(pair.truck, load.unit_code, pair.trailer);
  if (cap && load.planned_quantity) {
    const fill = Math.min(load.planned_quantity / cap, 1);
    score += 6 * p.utilization * fill;
    if (fill >= 0.8) reasons.push(`uses ${Math.round(fill * 100)}% of the capacity of ${equipmentLabel(pair.truck, pair.trailer)}`);
  }
  const sameDay = (truckOrDriver: (a: PlannedAssignment) => boolean) =>
    plan.filter((a) => truckOrDriver(a) && loads.get(a.loadId)!.load_date === load.load_date).map((a) => loads.get(a.loadId)!);
  const bookedSites = input.bookings.filter((b) => b.truck_id === pair.truck.id && b.load_date === load.load_date).map((b) => b.site);
  const truckSites = [...sameDay((a) => a.truckId === pair.truck.id).map((l) => l.site), ...bookedSites];
  if (truckSites.length && truckSites.includes(load.site)) { score += 6 * p.efficiency; reasons.push(`truck ${pair.truck.unit_number} is already at this site that day`); }
  else if (truckSites.length) score -= 3 * p.efficiency; // a site change: an empty repositioning trip
  const driverLoads = sameDay((a) => a.driverId === pair.driverId).length + input.bookings.filter((b) => b.driver_id === pair.driverId && b.load_date === load.load_date).length;
  score -= 2 * p.balance * driverLoads;
  if (driverLoads === 0 && p.balance > 0) reasons.push(`${pair.driverLabel} has no other load that day`);
  score -= pair.review.length - (input.hoursOfServiceVerified ? 0 : 1); // prefer pairs with complete data
  return { score, reasons };
}

const conflicts = (plan: PlannedAssignment[], loads: Map<string, SmartLoad>, load: SmartLoad, pair: Pair) =>
  plan.some((a) => (a.truckId === pair.truck.id || a.driverId === pair.driverId || (pair.trailer !== null && a.trailerId === pair.trailer.id)) && overlaps(loads.get(a.loadId)!, load));
const trailerOf = (input: OptimizationInput, id: string | null) => (id ? (input.trailers ?? []).find((t) => t.id === id) ?? null : null);

function metricsOf(input: OptimizationInput, assignments: PlannedAssignment[], loads: Map<string, SmartLoad>): PlanMetrics {
  const covered = new Set(assignments.map((a) => a.loadId));
  const overdue = (l: SmartLoad) => l.requested_date !== null && l.requested_date < l.load_date;
  let revenue = 0;
  let unknown = 0;
  for (const a of assignments) {
    const r = input.revenueCents[a.loadId];
    if (r === null || r === undefined) unknown++;
    else revenue += r;
  }
  const fills: number[] = [];
  for (const a of assignments) {
    const l = loads.get(a.loadId)!;
    const t = input.trucks.find((x) => x.id === a.truckId)!;
    const cap = capacity(t, l.unit_code, trailerOf(input, a.trailerId));
    if (cap && l.planned_quantity) fills.push(Math.min(l.planned_quantity / cap, 1));
  }
  let siteChanges = 0;
  const byTruckDay = new Map<string, SmartLoad[]>();
  for (const a of assignments) {
    const l = loads.get(a.loadId)!;
    const k = `${a.truckId}|${l.load_date}`;
    byTruckDay.set(k, [...(byTruckDay.get(k) ?? []), l]);
  }
  for (const list of byTruckDay.values()) {
    list.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
    for (let i = 1; i < list.length; i++) if (list[i].site !== list[i - 1].site) siteChanges++;
  }
  const perDriver = new Map<string, number>();
  for (const a of assignments) perDriver.set(a.driverId, (perDriver.get(a.driverId) ?? 0) + 1);
  const counts = [...perDriver.values()];
  return {
    loads: input.loads.length,
    covered: covered.size,
    urgentTotal: input.loads.filter((l) => l.urgent).length,
    urgentCovered: input.loads.filter((l) => l.urgent && covered.has(l.id)).length,
    overdueTotal: input.loads.filter(overdue).length,
    overdueCovered: input.loads.filter((l) => overdue(l) && covered.has(l.id)).length,
    revenueCoveredCents: revenue,
    revenueUnknownLoads: unknown,
    trucksUsed: new Set(assignments.map((a) => a.truckId)).size,
    driversUsed: perDriver.size,
    averageFill: fills.length ? fills.reduce((s, f) => s + f, 0) / fills.length : null,
    siteChanges,
    workloadSpread: counts.length ? Math.max(...counts) - Math.min(...counts) : 0,
    needsReview: assignments.filter((a) => a.status === "needs_review").length,
  };
}

function planScore(input: OptimizationInput, assignments: PlannedAssignment[], loads: Map<string, SmartLoad>, p: Priorities, maxRevenue: number): number {
  let score = 0;
  const done: PlannedAssignment[] = [];
  for (const a of [...assignments].sort((x, y) => loads.get(x.loadId)!.starts_at.localeCompare(loads.get(y.loadId)!.starts_at) || x.loadId.localeCompare(y.loadId))) {
    const l = loads.get(a.loadId)!;
    const pair: Pair = { truck: input.trucks.find((t) => t.id === a.truckId)!, trailer: trailerOf(input, a.trailerId), driverId: a.driverId, driverLabel: a.driverLabel, review: a.review };
    score += loadValue(l, input, p, maxRevenue).value + pairScore(l, pair, p, done, loads, input).score;
    done.push(a);
  }
  return Math.round(score * 100) / 100;
}

/** One plan for one set of priorities: greedy by load value, then improving single-load moves until none helps. */
export function optimize(input: OptimizationInput, priorities: Priorities, key = "custom", label = "Your priorities", shared?: Map<string, Pair[]>): Plan {
  const loads = new Map(input.loads.map((l) => [l.id, l]));
  // The hard-constraint pairs depend only on the input, so callers comparing several priorities share one matrix.
  const pairs = shared ?? feasiblePairs(input);
  const maxRevenue = Math.max(0, ...Object.values(input.revenueCents).map((v) => v ?? 0));
  const urgencyOrder = new Map(orderLoads(input.loads, input.today).map((l, i) => [l.id, i]));
  const order = [...input.loads].sort((a, b) =>
    loadValue(b, input, priorities, maxRevenue).value - loadValue(a, input, priorities, maxRevenue).value ||
    urgencyOrder.get(a.id)! - urgencyOrder.get(b.id)! || a.id.localeCompare(b.id));

  const build = (load: SmartLoad, pair: Pair, plan: PlannedAssignment[]): PlannedAssignment => {
    const { reasons } = pairScore(load, pair, priorities, plan, loads, input);
    return {
      loadId: load.id, truckId: pair.truck.id, truckLabel: pair.truck.unit_number, trailerId: pair.trailer?.id ?? null, trailerLabel: pair.trailer?.unit_number ?? null,
      driverId: pair.driverId, driverLabel: pair.driverLabel,
      status: pair.review.length ? "needs_review" : "verified",
      reasons: [...loadValue(load, input, priorities, maxRevenue).reasons, ...reasons],
      review: pair.review,
    };
  };
  const best = (load: SmartLoad, plan: PlannedAssignment[]): Pair | null => {
    let top: { pair: Pair; score: number } | null = null;
    for (const pair of pairs.get(load.id) ?? []) {
      if (conflicts(plan, loads, load, pair)) continue;
      const s = pairScore(load, pair, priorities, plan, loads, input).score;
      const key = (x: Pair) => `${x.truck.unit_number}|${x.trailer?.unit_number ?? ""}|${x.driverLabel}`;
      if (!top || s > top.score || (s === top.score && key(pair) < key(top.pair))) top = { pair, score: s };
    }
    return top?.pair ?? null;
  };

  let plan: PlannedAssignment[] = [];
  for (const load of order) {
    const pair = best(load, plan);
    if (pair) plan.push(build(load, pair, plan));
  }

  // Improvement: move one load to another pair, or drop a covered load to cover a more valuable uncovered one.
  let score = planScore(input, plan, loads, priorities, maxRevenue);
  for (let round = 0; round < 50; round++) {
    let improved = false;
    for (const load of order) {
      const without = plan.filter((a) => a.loadId !== load.id);
      for (const pair of pairs.get(load.id) ?? []) {
        if (conflicts(without, loads, load, pair)) continue;
        const current = plan.find((a) => a.loadId === load.id);
        if (current && current.truckId === pair.truck.id && current.driverId === pair.driverId && current.trailerId === (pair.trailer?.id ?? null)) continue;
        const candidate = [...without, build(load, pair, without)];
        const s = planScore(input, candidate, loads, priorities, maxRevenue);
        if (s > score + 1e-9) { plan = candidate; score = s; improved = true; break; }
      }
      if (!plan.some((a) => a.loadId === load.id)) {
        // An uncovered load: try freeing one conflicting assignment of lower value.
        for (const victim of plan) {
          const rest = plan.filter((a) => a !== victim);
          const pair = best(load, rest);
          if (!pair) continue;
          let candidate = [...rest, build(load, pair, rest)];
          const vLoad = loads.get(victim.loadId)!;
          const vPair = best(vLoad, candidate);
          if (vPair) candidate = [...candidate, build(vLoad, vPair, candidate)];
          const s = planScore(input, candidate, loads, priorities, maxRevenue);
          if (s > score + 1e-9) { plan = candidate; score = s; improved = true; break; }
        }
      }
    }
    if (!improved) break;
  }
  // Rebuild reasons in time order so they describe the final plan.
  const final: PlannedAssignment[] = [];
  for (const a of [...plan].sort((x, y) => loads.get(x.loadId)!.starts_at.localeCompare(loads.get(y.loadId)!.starts_at) || x.loadId.localeCompare(y.loadId))) {
    final.push(build(loads.get(a.loadId)!, { truck: input.trucks.find((t) => t.id === a.truckId)!, trailer: trailerOf(input, a.trailerId), driverId: a.driverId, driverLabel: a.driverLabel, review: a.review }, final));
  }
  const covered = new Set(final.map((a) => a.loadId));
  const uncovered = orderLoads(input.loads, input.today)
    .filter((l) => !covered.has(l.id))
    .map((l) => ({ loadId: l.id, why: (pairs.get(l.id) ?? []).length ? "Every feasible truck and driver is used by a higher-priority load at that time." : "No truck-and-driver pair passes the hard constraints (see Smart Dispatch for each reason)." }));
  return { key, label, priorities, assignments: final, uncovered, metrics: metricsOf(input, final, loads), score: planScore(input, final, loads, priorities, maxRevenue) };
}

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** Plain-language differences of `alt` against `base` (only material ones). */
export function tradeoffs(base: Plan, alt: Plan): string[] {
  const d: string[] = [];
  const m = base.metrics;
  const n = alt.metrics;
  const diff = (a: number, b: number, more: string, fewer: string) => {
    if (b > a) d.push(`${b - a} ${more}`);
    if (b < a) d.push(`${a - b} ${fewer}`);
  };
  diff(m.covered, n.covered, "more load(s) covered", "fewer load(s) covered");
  diff(m.urgentCovered, n.urgentCovered, "more urgent load(s) covered", "fewer urgent load(s) covered");
  diff(m.overdueCovered, n.overdueCovered, "more overdue load(s) covered", "fewer overdue load(s) covered");
  if (n.revenueCoveredCents !== m.revenueCoveredCents) d.push(`${n.revenueCoveredCents > m.revenueCoveredCents ? "+" : "−"}${money(Math.abs(n.revenueCoveredCents - m.revenueCoveredCents))} estimated revenue covered`);
  diff(m.trucksUsed, n.trucksUsed, "more truck(s) in use", "fewer truck(s) in use");
  diff(m.siteChanges, n.siteChanges, "more site change(s)", "fewer site change(s)");
  diff(m.workloadSpread, n.workloadSpread, "more uneven driver workload", "more even driver workload");
  const changed = alt.assignments.filter((a) => !base.assignments.some((b) => b.loadId === a.loadId && b.truckId === a.truckId && b.trailerId === a.trailerId && b.driverId === a.driverId)).length;
  if (changed) d.push(`${changed} assignment(s) differ`);
  return d.length ? d : ["Same assignments and results."];
}

/** The plan for `priorities` plus one plan per preset, de-duplicated, with trade-offs against the first. */
export function optimizeWithAlternatives(input: OptimizationInput, priorities: Priorities, presetKey: string | null): Optimization {
  const pairs = feasiblePairs(input);
  const main = optimize(input, priorities, presetKey ?? "custom", presetKey ? PRESETS[presetKey]?.label ?? "Your priorities" : "Your priorities", pairs);
  const plans: Plan[] = [main];
  const signature = (p: Plan) => p.assignments.map((a) => `${a.loadId}:${a.truckId}:${a.trailerId ?? ""}:${a.driverId}`).sort().join(",");
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (key === presetKey) continue;
    const p = optimize(input, preset.priorities, key, preset.label, pairs);
    if (!plans.some((x) => signature(x) === signature(p))) plans.push(p);
  }
  const loads = new Map(input.loads.map((l) => [l.id, l]));
  const dataNotes = [
    input.hoursOfServiceVerified ? null : HOS_NOTE,
    "Travel distance and drive time are not calculated: no truck locations or routing provider are connected. “Fewer empty trips” counts site changes instead.",
    "Operating costs (fuel, wages, maintenance) are not recorded, so margin is not evaluated. Revenue is an estimate from each order's rate × planned quantity.",
    Object.values(input.revenueCents).some((v) => v === null) ? `${Object.values(input.revenueCents).filter((v) => v === null).length} load(s) have no rate to estimate revenue from.` : null,
    input.maintenanceChecked === false ? "Maintenance shop dates were not checked (database update not installed)." : null,
    input.timeOffChecked === false ? "Driver time off was not checked (database update not installed)." : null,
    input.documentsChecked === false ? "Vehicle registrations, insurance and inspections could not be checked." : null,
  ].filter((x): x is string => Boolean(x));
  const blocked = [...loads.values()].filter((l) => !(pairs.get(l.id) ?? []).length).map((l) => ({ loadId: l.id, why: "No truck-and-driver pair passes the hard constraints." }));
  return { plans, tradeoffs: plans.slice(1).map((p) => ({ key: p.key, label: p.label, differences: tradeoffs(main, p) })), dataNotes, blocked };
}

/** Parse priorities from form/query values (0–5 each), falling back to a preset. */
export function parsePriorities(values: Partial<Record<keyof Priorities, string | undefined>>, fallback: Priorities = PRESETS.balanced.priorities): Priorities {
  const out = { ...fallback };
  for (const k of PRIORITY_KEYS) {
    const v = Number.parseInt(values[k] ?? "", 10);
    if (Number.isFinite(v)) out[k] = Math.min(Math.max(v, 0), 5);
  }
  return out;
}
