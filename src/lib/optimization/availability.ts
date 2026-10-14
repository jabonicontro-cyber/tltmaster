import { resourceExclusions } from "@/lib/dispatch/smart";
import { trailerShopBlockers, type OptimizationInput, type OptTrailer } from "./plan";

// Why loads cannot be covered and which trucks, trailers and drivers cannot work (docs/OPTIMIZATION.md). Explains the
// hard rules the optimizer already applies (Smart Dispatch's per-resource checks and the trailer rules); it never adds
// a rule of its own and never decides anything.

export interface Unavailable {
  kind: "truck" | "trailer" | "driver";
  id: string;
  label: string;
  reasons: string[];
}

export interface LoadExplanation {
  loadId: string;
  /** Resources that cannot take this load on their own, with the rule that stops each. */
  unavailable: Unavailable[];
  /** Plain summary: what is free and why the free ones still do not combine. */
  summary: string;
}

const overlaps = (a: { starts_at: string; ends_at: string }, b: { starts_at: string; ends_at: string }) => a.starts_at < b.ends_at && b.starts_at < a.ends_at;

// Tractor messages that the optimizer replaces with its own trailer rules (it chooses trailers and checks the combined
// capacity of tractor + trailer).
const TRACTOR_HANDLED = [/^A tractor needs a trailer/, /exceeds its recorded capacity/];

/** A trailer's own blockers for one load (state, reports, bookings): the rules of plan.ts that do not depend on the tractor. */
function trailerOwn(input: OptimizationInput, load: { id: string; load_date: string; starts_at: string; ends_at: string }, t: OptTrailer): string[] {
  const out: string[] = [];
  if (!t.active) out.push("Deactivated.");
  if (t.service_status === "out_of_service") out.push("Out of service.");
  if ((input.trailerReports ?? []).some((r) => r.trailer_id === t.id && (r.kind === "breakdown" || r.kind === "inspection_issue"))) out.push("A driver reported a breakdown or inspection problem that is not resolved.");
  if ((input.trailerBookings ?? []).some((b) => b.trailer_id === t.id && b.load_id !== load.id && overlaps(b, load))) out.push("Already booked at an overlapping time.");
  out.push(...trailerShopBlockers(input, load.load_date, t).map((m) => m.replace(`Trailer ${t.unit_number} `, "").replace(/^./, (c) => c.toUpperCase())));
  return out;
}

function perLoad(input: OptimizationInput, loadId: string): Unavailable[] {
  const load = input.loads.find((l) => l.id === loadId);
  if (!load) return [];
  const { trucks, drivers } = resourceExclusions(input, loadId);
  const out: Unavailable[] = [];
  for (const t of input.trucks) {
    const reasons = (trucks.get(t.id) ?? []).filter((r) => !(t.truck_type === "tractor" && TRACTOR_HANDLED.some((re) => re.test(r))));
    if (reasons.length) out.push({ kind: "truck", id: t.id, label: `Truck ${t.unit_number}`, reasons });
  }
  if (input.trucks.some((t) => t.truck_type === "tractor")) {
    for (const t of input.trailers ?? []) {
      const reasons = trailerOwn(input, load, t);
      if (reasons.length) out.push({ kind: "trailer", id: t.id, label: `Trailer ${t.unit_number}`, reasons });
    }
  }
  for (const d of input.drivers) {
    const reasons = drivers.get(d.id) ?? [];
    if (reasons.length) out.push({ kind: "driver", id: d.id, label: d.name, reasons });
  }
  return out;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why one load has no feasible truck, trailer and driver. */
export function explainLoad(input: OptimizationInput, loadId: string): LoadExplanation {
  const unavailable = perLoad(input, loadId);
  const blocked = (kind: Unavailable["kind"]) => new Set(unavailable.filter((u) => u.kind === kind).map((u) => u.id));
  const freeTrucks = input.trucks.filter((t) => !blocked("truck").has(t.id));
  const freeDrivers = input.drivers.filter((d) => !blocked("driver").has(d.id));
  const tractorsOnly = freeTrucks.length > 0 && freeTrucks.every((t) => t.truck_type === "tractor");
  const freeTrailers = (input.trailers ?? []).filter((t) => !blocked("trailer").has(t.id));
  let summary: string;
  if (!input.trucks.length) summary = "There are no active trucks.";
  else if (!input.drivers.length) summary = "There are no active drivers.";
  else if (!freeTrucks.length) summary = `None of the ${count(input.trucks.length, "truck", "trucks")} can take this load (reasons below).`;
  else if (!freeDrivers.length) summary = `None of the ${count(input.drivers.length, "driver", "drivers")} can take this load (reasons below).`;
  else if (tractorsOnly && !freeTrailers.length) summary = (input.trailers ?? []).length ? `Every free truck is a tractor and none of the ${count((input.trailers ?? []).length, "trailer is", "trailers are")} free (reasons below).` : "Every free truck is a tractor and there are no active trailers.";
  else summary = `${count(freeTrucks.length, "truck", "trucks")} and ${count(freeDrivers.length, "driver", "drivers")} are free on their own, but no combination passes every rule — check capacity, trailer compatibility and driver qualifications for this load (Smart Dispatch on the Dispatch board lists each pair).`;
  return { loadId, unavailable, summary };
}

/**
 * Trucks, trailers and drivers that cannot take any open load of the day, with the reasons that apply to every load
 * (for example out of service, safety-critical work, expired qualifications, approved time off covering the day).
 * Resources that are only busy for some loads are not listed here; they show under the loads they block.
 */
export function unavailableResources(input: OptimizationInput): Unavailable[] {
  if (!input.loads.length) return [];
  const lists = input.loads.map((l) => perLoad(input, l.id));
  const first = lists[0];
  return first
    .map((u) => {
      const others = lists.slice(1).map((list) => list.find((x) => x.kind === u.kind && x.id === u.id));
      if (others.some((o) => !o)) return null;
      const common = u.reasons.filter((r) => others.every((o) => o!.reasons.includes(r)));
      return { ...u, reasons: common.length ? common : ["Busy or unavailable at the time of every open load."] };
    })
    .filter((u): u is Unavailable => u !== null);
}
