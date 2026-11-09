import { formatTime } from "@/lib/orders/schedule";
import type { Stop } from "@/lib/dispatch/wait-times";

// My Day (src/app/(app)/driver/page.tsx): what comes next, which trucks must not be driven, which pre-trip
// inspections are still due, and when a ticket quantity looks wrong. Pure, so it is unit tested
// (tests/unit/driver-my-day.test.ts). Every rule here only explains or asks; the database decides.

type LoadRef = { load: { date: string; start_time: string; end_time?: string }; tickets: unknown[]; truck: string | null };

/** Today's loads in the order they start. */
export function todayInOrder<T extends LoadRef>(assignments: T[], today: string): T[] {
  return assignments.filter((a) => a.load.date === today).sort((a, b) => a.load.start_time.localeCompare(b.load.start_time));
}

/** The next load today: the earliest one without a ticket yet; null when every load of today has one (or there are none). */
export function nextLoad<T extends LoadRef>(assignments: T[], today: string): T | null {
  return todayInOrder(assignments, today).find((a) => a.tickets.length === 0) ?? null;
}

/**
 * One plain line for the top of My Day: "Next: 7:30 AM · Pick up at River Gravel Pit · Truck 103". The pickup is
 * named when known, otherwise where the load goes; the truck only when one is assigned.
 */
export function nextLoadLine(a: LoadRef, place: { pickup?: string | null; site?: string | null }): string {
  const parts = [formatTime(a.load.start_time)];
  if (place.pickup) parts.push(`Pick up at ${place.pickup}`);
  else if (place.site) parts.push(`Deliver to ${place.site}`);
  if (a.truck) parts.push(`Truck ${a.truck}`);
  return `Next: ${parts.filter(Boolean).join(" · ")}`;
}

/** Unique trucks of today's loads, in the order the loads start (the trucks the driver needs today). */
export function todaysTrucks(assignments: LoadRef[], today: string): string[] {
  return [...new Set(todayInOrder(assignments, today).map((a) => a.truck).filter((t): t is string => Boolean(t)))];
}

/**
 * Trucks the driver must not drive, by unit number, from what My Day already reads:
 *   - the latest of the driver's own inspections today on each truck found a safety defect (the database takes the
 *     truck out of service when that happens), and
 *   - a safety-critical shop job on the driver's truck that is still open ("out of service until it is cleared").
 * Unknown is never shown as safe or unsafe: this only adds warnings.
 */
export function restrictedTrucks(input: {
  inspections: Array<{ truck_id: string; safety_defect: boolean; created_at: string }>;
  trucks: Array<{ id: string; unit: string }>;
  notices?: Array<{ unit_number: string; equipment?: "truck" | "trailer"; safety_critical: boolean; notice: string; status: string }>;
}): Set<string> {
  const out = new Set<string>();
  const unitOf = new Map(input.trucks.map((t) => [t.id, t.unit]));
  const latest = new Map<string, { safety_defect: boolean; created_at: string }>();
  for (const i of input.inspections) {
    const seen = latest.get(i.truck_id);
    if (!seen || i.created_at > seen.created_at) latest.set(i.truck_id, i);
  }
  for (const [truckId, i] of latest) {
    const unit = unitOf.get(truckId);
    if (unit && i.safety_defect) out.add(unit);
  }
  for (const n of input.notices ?? []) {
    if ((n.equipment ?? "truck") !== "truck" || !n.safety_critical || n.notice === "canceled") continue;
    if (["completed", "closed", "canceled"].includes(n.status)) continue;
    out.add(n.unit_number);
  }
  return out;
}

/** Pre-trip inspections today: which of the trucks the driver needs are done and which are still to inspect. */
export function preTripProgress(rows: Array<{ unit: string; pre_trip: boolean }>, needed: string[]): { done: string[]; left: string[] } {
  // With loads today, only their trucks count; without, every truck the driver may inspect.
  const relevant = needed.length ? needed.map((u) => rows.find((r) => r.unit === u)).filter((r): r is { unit: string; pre_trip: boolean } => Boolean(r)) : rows;
  return { done: relevant.filter((r) => r.pre_trip).map((r) => r.unit), left: relevant.filter((r) => !r.pre_trip).map((r) => r.unit) };
}

const trucksText = (units: string[]) => units.map((u) => `Truck ${u}`).join(", ");

/** The inspection banner: "Truck 103 done · Truck 101 still to inspect"; null once every truck needed today is done. */
export function preTripBanner(p: { done: string[]; left: string[] }): string | null {
  if (p.left.length === 0) return null;
  if (p.done.length === 0) return `Pre-trip inspection: do this before you drive${p.left.length ? ` (${trucksText(p.left)})` : ""}`;
  return `${trucksText(p.done)} done · ${trucksText(p.left)} still to inspect`;
}

/**
 * The truck the inspection form starts on: the preferred one (the next load's truck) while its pre-trip is due, else
 * the first truck needed today whose pre-trip is due, else the preferred one, else the first with anything due.
 * `needed` (ids of the trucks on today's loads) keeps a truck the driver does not need today from being chosen first.
 */
export function pickInspectionTruck(trucks: Array<{ id: string; pending: string[] }>, preferredId?: string | null, needed?: string[]): string {
  const preferred = preferredId ? trucks.find((t) => t.id === preferredId) : undefined;
  if (preferred?.pending.includes("pre_trip")) return preferred.id;
  const today = needed?.length ? trucks.filter((t) => needed.includes(t.id)) : trucks;
  const pre = today.find((t) => t.pending.includes("pre_trip"));
  if (pre) return pre.id;
  if (preferred?.pending.length) return preferred.id;
  return (today.find((t) => t.pending.length > 0) ?? trucks.find((t) => t.pending.length > 0) ?? trucks[0])?.id ?? "";
}

const unitText = (code: string) => code.replace(/_/g, " ");
const plain = (n: number) => String(Number(n.toFixed(2)));

/**
 * Before a ticket is sent: a quantity far above the load's planned quantity (more than 3 times, same unit) is asked
 * about in plain words, e.g. "152 ton is about 10× the planned 15 ton. Is that right?". Null when it looks plausible or
 * nothing is known to compare with. The driver can still send it: the office reviews every ticket.
 */
export function implausibleQuantity(quantity: string, unit: string, planned: { quantity: number | string | null; unit: string | null }): string | null {
  const q = Number(quantity.trim());
  const p = planned.quantity === null || planned.quantity === "" ? NaN : Number(planned.quantity);
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0 || !planned.unit || planned.unit !== unit) return null;
  if (q <= p * 3) return null;
  return `${plain(q)} ${unitText(unit)} is about ${Math.round(q / p)}× the planned ${plain(p)} ${unitText(unit)}. Is that right?`;
}

/** A ticket number safe to carry in a link and prefill ("T-1042"); null for anything else. */
export function ticketRef(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(v) ? v : null;
}

/** "Truck 103" or "Trailer 7" for a report's equipment, from the load's own truck and trailer; "Unit 103" when unknown. */
export function reportEquipmentLabel(unit: string, load?: { truck: string | null; trailer: string | null } | null): string {
  if (load?.truck === unit) return `Truck ${unit}`;
  if (load?.trailer === unit) return `Trailer ${unit}`;
  return `Unit ${unit}`;
}

/** The Arrived / Left button says where and what: "Arrived at pickup" / "Leaving pickup", "Arrived at site" / "Leaving site". */
export function stopButtonLabel(stop: Stop, event: "arrive" | "depart"): string {
  const place = stop === "pickup" ? "pickup" : stop === "site" ? "site" : "this stop";
  return event === "arrive" ? `Arrived at ${place}` : `Leaving ${place}`;
}
