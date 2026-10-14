// Smart Load Build, increment 1 (docs/SMART_LOAD_BUILD.md): turn the part of an
// order's quantity that has no planned load yet into draft loads, sized to a
// per-load payload that in-service trucks can actually carry, and spread over
// the order's scheduled days. Pure functions: no database, no side effects.
//
// What it does not do yet (and does not pretend to): travel or cycle times,
// quarry/source choice, cost, driver hours, multi-order trips. Loads on the
// same day share the order's daily window, so each needs its own truck until
// cycle times are modeled. Nothing here assigns a truck or creates a load —
// the dispatcher reviews the draft and approves it.

/** Quantities are numeric(12,3) in the database: work in whole thousandths so totals are exact. */
export const QTY_SCALE = 1000;
export const toMilli = (n: number): number => Math.round(n * QTY_SCALE);
export const fromMilli = (m: number): number => m / QTY_SCALE;

/**
 * Units a load can be built in: tons and cubic yards are compared with each truck's recorded capacity; "load" (freight
 * priced per trip) is one trip per truck, so every usable truck carries exactly one.
 */
export const BUILD_UNITS = ["ton", "cu_yd", "load"] as const;
export type BuildUnit = (typeof BUILD_UNITS)[number];

export interface BuildTruck {
  id: string;
  unit_number: string;
  active: boolean;
  service_status: "in_service" | "out_of_service";
  weight_capacity: number | null;
  weight_unit: "ton" | "lb" | null;
  volume_capacity: number | null;
  capacity_verified_at: string | null;
  /** An unresolved driver report of a breakdown or inspection problem (blocks dispatch). */
  safety_report: boolean;
}

/** The truck's recorded capacity in the build unit, or null when unknown. */
export function truckCapacity(t: BuildTruck, unit: BuildUnit): number | null {
  if (unit === "load") return 1;
  if (unit === "ton" && t.weight_capacity !== null) return t.weight_unit === "lb" ? Number(t.weight_capacity) / 2000 : Number(t.weight_capacity);
  if (unit === "cu_yd" && t.volume_capacity !== null) return Number(t.volume_capacity);
  return null;
}

/** Why a truck cannot be counted for this build, or null when it can (at any payload up to its capacity). */
export function truckExclusion(t: BuildTruck, unit: BuildUnit): string | null {
  if (!t.active) return "inactive";
  if (t.service_status !== "in_service") return "out of service";
  if (t.safety_report) return "open breakdown or inspection report";
  if (truckCapacity(t, unit) === null) return "no recorded capacity";
  return null;
}

/**
 * Split a quantity into loads of at most `payload`: full loads, then one partial
 * load for the rest. 93 t at 25 t → 25, 25, 25, 18. Totals are exact (thousandths).
 */
export function splitQuantity(totalMilli: number, payloadMilli: number): number[] {
  if (!Number.isInteger(totalMilli) || !Number.isInteger(payloadMilli) || totalMilli <= 0 || payloadMilli <= 0) return [];
  const full = Math.floor(totalMilli / payloadMilli);
  const rest = totalMilli - full * payloadMilli;
  return [...Array.from({ length: full }, () => payloadMilli), ...(rest > 0 ? [rest] : [])];
}

/** Every date from start to end inclusive (ISO yyyy-mm-dd). */
export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  for (let i = 0; d <= last && i < 366; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Spread `count` loads over `days`, at most `perDay` each day. "even" spreads
 * them across the whole window (so the work is not crowded onto the first day);
 * "earliest" fills each day before the next. Returns null when they do not fit.
 */
export function distributeLoads(count: number, days: string[], perDay: number, mode: "even" | "earliest"): string[] | null {
  if (count === 0) return [];
  if (days.length === 0 || perDay < 1 || count > days.length * perDay) return null;
  const perDayCounts = new Array<number>(days.length).fill(0);
  if (mode === "earliest") {
    for (let i = 0, left = count; left > 0; i++) {
      perDayCounts[i] = Math.min(perDay, left);
      left -= perDayCounts[i];
    }
  } else {
    // Even: the same number each day, earlier days taking any extra one.
    const base = Math.floor(count / days.length);
    let extra = count - base * days.length;
    for (let i = 0; i < days.length; i++) {
      perDayCounts[i] = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
    }
  }
  return perDayCounts.flatMap((n, i) => Array.from({ length: n }, () => days[i]));
}

export interface BuildInput {
  unit: BuildUnit;
  /** Ordered quantity of the order's material in this unit. */
  orderedQty: number;
  /** Quantity already on planned (not canceled) loads in this unit. */
  plannedQty: number;
  /** Per-load quantity chosen by the dispatcher. */
  payload: number;
  /** Loads the dispatcher can run per day (from their own knowledge — no cycle times yet). */
  loadsPerDay: number;
  mode: "even" | "earliest";
  /** The order's scheduled dates, from today on. */
  days: string[];
  trucks: BuildTruck[];
}

export interface BuildLoad {
  quantity: number;
  date: string;
}

export interface BuildResult {
  ok: boolean;
  remaining: number;
  loads: BuildLoad[];
  /** Trucks that can carry the chosen payload. */
  eligibleTrucks: number;
  blockers: string[];
  warnings: string[];
}

const fmt = (n: number) => String(Number(n.toFixed(3)));
/** Short unit for messages and tables: t, yd³, or load(s). */
export const unitShort = (u: BuildUnit | null) => (u === "cu_yd" ? "yd³" : u === "load" ? "load" : "t");

/** Distinct capacities of trucks that could be used, largest first: the payload choices offered. */
export function payloadOptions(trucks: BuildTruck[], unit: BuildUnit): number[] {
  const caps = trucks.filter((t) => truckExclusion(t, unit) === null).map((t) => truckCapacity(t, unit)!);
  return [...new Set(caps.map((c) => fromMilli(toMilli(c))))].sort((a, b) => b - a);
}

/** The draft plan, or the reasons it cannot be made. Never exceeds the remaining quantity or any truck's capacity. */
export function buildLoads(input: BuildInput): BuildResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const unit = unitShort(input.unit);
  const remainingMilli = toMilli(input.orderedQty) - toMilli(input.plannedQty);
  const remaining = fromMilli(Math.max(remainingMilli, 0));
  const payloadMilli = toMilli(input.payload);
  const usable = input.trucks.filter((t) => truckExclusion(t, input.unit) === null);
  const carriers = usable.filter((t) => toMilli(truckCapacity(t, input.unit)!) >= payloadMilli);

  if (remainingMilli <= 0) {
    if (remainingMilli < 0) warnings.push(`Planned loads already add up to ${fmt(input.plannedQty)} ${unit}, more than the ${fmt(input.orderedQty)} ${unit} ordered.`);
    return { ok: false, remaining: 0, loads: [], eligibleTrucks: carriers.length, blockers: ["Nothing left to plan: the planned loads already cover the ordered quantity."], warnings };
  }
  if (!(payloadMilli > 0)) blockers.push("Choose the quantity per load.");
  else if (carriers.length === 0) {
    blockers.push(usable.length
      ? `No in-service truck has a recorded capacity of ${fmt(input.payload)} ${unit} or more. Choose a smaller quantity per load.`
      : input.unit === "load"
        ? "No active, in-service truck without an open safety report."
        : `No active, in-service truck without an open safety report has a recorded capacity in ${input.unit === "ton" ? "tons" : "cubic yards"}.`);
  }
  if (!Number.isInteger(input.loadsPerDay) || input.loadsPerDay < 1) blockers.push("Enter how many loads can run per day.");
  if (input.days.length === 0) blockers.push("The order has no scheduled dates from today on. Schedule the order first.");
  if (blockers.length) return { ok: false, remaining, loads: [], eligibleTrucks: carriers.length, blockers, warnings };

  const quantities = splitQuantity(remainingMilli, payloadMilli);
  const dates = distributeLoads(quantities.length, input.days, input.loadsPerDay, input.mode);
  if (!dates) {
    const needed = Math.ceil(quantities.length / input.loadsPerDay);
    blockers.push(`${quantities.length} loads at ${input.loadsPerDay} a day need ${needed} day${needed === 1 ? "" : "s"}; the order is scheduled for ${input.days.length}. Change the order's dates (with approval) or the loads per day — firm dates are not moved automatically.`);
    return { ok: false, remaining, loads: [], eligibleTrucks: carriers.length, blockers, warnings };
  }
  if (input.loadsPerDay > carriers.length) {
    warnings.push(`${input.loadsPerDay} loads a day, but only ${carriers.length} truck${carriers.length === 1 ? "" : "s"} can carry ${fmt(input.payload)} ${unit}. Loads on the same day share the order's time window, so each needs its own truck until trip times are planned.`);
  }
  const unverified = carriers.filter((t) => t.capacity_verified_at === null).length;
  if (unverified) warnings.push(`${unverified} of the ${carriers.length} trucks that can carry this load ${unverified === 1 ? "has" : "have"} an unverified capacity.`);

  const loads = quantities.map((q, i) => ({ quantity: fromMilli(q), date: dates[i] }));
  // Invariant: the draft never delivers more or less than what is left to plan.
  if (quantities.reduce((a, b) => a + b, 0) !== remainingMilli) throw new Error("Load build total does not match the remaining quantity.");
  return { ok: true, remaining, loads, eligibleTrucks: carriers.length, blockers, warnings };
}

/** A compact description of a draft, to detect changes between the dispatcher's review and approval. */
export function draftKey(loads: BuildLoad[]): string {
  return loads.map((l) => `${l.date}:${l.quantity}`).join(",");
}
