// Stops on an order (MK2 slice 1, migration 20261120007800): pure helpers shared by the order page, the stop editor,
// the server action and the driver's load card. The database (save_order_stops) applies the same rules again.
import { formatDate, isOperationalDate, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";
import { formatWindow } from "@/lib/orders/schedule";

export const STOP_KINDS = ["pickup", "delivery"] as const;
export type StopKind = (typeof STOP_KINDS)[number];
export const STOP_KIND_LABELS: Record<StopKind, string> = { pickup: "Pickup", delivery: "Delivery" };
export const MAX_STOPS = 25;

export interface StopInput {
  id?: string;
  kind: StopKind;
  name: string;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
  appointment_date: string;
  window_start: string;
  window_end: string;
  reference: string;
  notes: string;
}

export interface OrderStop extends StopInput {
  id: string;
  seq: number;
}

export function emptyStop(kind: StopKind): StopInput {
  return { kind, name: "", address_line1: "", city: "", state: "", postal_code: "", appointment_date: "", window_start: "", window_end: "", reference: "", notes: "" };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** Problems with a list of stops, in the words the editor shows; empty when it can be saved. */
export function stopProblems(stops: StopInput[]): string[] {
  const out: string[] = [];
  if (stops.length === 0) return out;
  if (stops.length > MAX_STOPS) out.push(`An order can have at most ${MAX_STOPS} stops.`);
  if (stops[0].kind !== "pickup") out.push("The first stop must be a pickup.");
  if (stops[stops.length - 1].kind !== "delivery") out.push("The last stop must be a delivery.");
  stops.forEach((s, i) => {
    const n = `Stop ${i + 1}`;
    if (!s.name.trim()) out.push(`${n}: enter the place name.`);
    if (s.appointment_date && !isOperationalDate(s.appointment_date)) out.push(`${n}: ${OPERATIONAL_DATE_MESSAGE}`);
    const start = s.window_start.trim(), end = s.window_end.trim();
    if ((start === "") !== (end === "")) out.push(`${n}: enter both window times or neither.`);
    else if (start && (!TIME.test(start) || !TIME.test(end))) out.push(`${n}: check the window times.`);
    else if (start && end.slice(0, 5) <= start.slice(0, 5)) out.push(`${n}: the window must end after it starts.`);
    if (start && !s.appointment_date) out.push(`${n}: a time window needs an appointment date.`);
  });
  return out;
}

/** "Gary, IN 46402" style one-line place, without empty parts. */
export function stopAddress(s: Pick<StopInput, "address_line1" | "city" | "state" | "postal_code">): string {
  const region = [s.state, s.postal_code].map((x) => x.trim()).filter(Boolean).join(" ");
  return [s.address_line1.trim(), s.city.trim(), region].filter(Boolean).join(", ");
}

/** "2 pickups, 3 deliveries" */
export function stopsSummary(stops: Array<{ kind: string }>): string {
  const p = stops.filter((s) => s.kind === "pickup").length;
  const d = stops.filter((s) => s.kind === "delivery").length;
  return `${p} ${p === 1 ? "pickup" : "pickups"}, ${d} ${d === 1 ? "delivery" : "deliveries"}`;
}

/** "Gary, IN → Joliet, IL" (first pickup to last delivery), with "+N stops" when there are more in between. */
export function routeLine(stops: Array<{ name: string; city: string; state: string }>): string {
  if (stops.length === 0) return "";
  const place = (s: { name: string; city: string; state: string }) => [s.city, s.state].filter((x) => x.trim()).join(", ") || s.name;
  const first = place(stops[0]);
  if (stops.length === 1) return first;
  const middle = stops.length - 2;
  return `${first} → ${place(stops[stops.length - 1])}${middle > 0 ? ` (+${middle} ${middle === 1 ? "stop" : "stops"})` : ""}`;
}

/** "Nov 5, 2026, 7:00 AM – 9:00 AM", "Nov 5, 2026" or "" when no appointment is set. */
export function appointmentText(s: { appointment_date: string | null; window_start: string | null; window_end: string | null }): string {
  if (!s.appointment_date) return "";
  const w = formatWindow(s.window_start || null, s.window_end || null);
  return w ? `${formatDate(s.appointment_date)}, ${w}` : formatDate(s.appointment_date);
}

/** A stop as the driver's load card receives it (driver_load_stops): the address already on one line. */
export interface DriverStop {
  seq: number;
  kind: StopKind;
  name: string;
  address: string;
  appointment_date: string | null;
  window_start: string | null;
  window_end: string | null;
  reference: string;
  notes: string;
}
