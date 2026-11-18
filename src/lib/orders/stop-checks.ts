// Stop checks and saved places (owner decisions 2026-11-16/17, WK3). Pure helpers shared by the stop editor (live
// warnings, place suggestions) and the server action (the warning repeated in the saved message). Warnings never
// block saving: the office may have agreed a different time with the shipper or receiver.
import { formatDate } from "@/lib/dates";
import { haulsFreight } from "@/lib/industry";
import { formatTime } from "@/lib/orders/schedule";
import type { StopInput, StopKind } from "@/lib/orders/stops";

/** The load's delivery window as the order sets it: its delivery dates and daily time window, each optional. */
export interface LoadWindow {
  firstDay: string | null;
  lastDay: string | null;
  start: string | null;
  end: string | null;
  /** "load" for freight carriers (one order, one load), "order" for aggregate orders that run many loads. */
  noun: "load" | "order";
}

/** The window from an order's schedule fields (scheduled_start / scheduled_end, window_start / window_end). */
export function orderLoadWindow(
  o: { scheduled_start: string | null; scheduled_end: string | null; window_start: string | null; window_end: string | null },
  industry: unknown,
): LoadWindow {
  return {
    firstDay: o.scheduled_start,
    lastDay: o.scheduled_end ?? o.scheduled_start,
    start: o.window_start && o.window_end ? o.window_start.slice(0, 5) : null,
    end: o.window_start && o.window_end ? o.window_end.slice(0, 5) : null,
    noun: haulsFreight(industry) ? "load" : "order",
  };
}

const hhmm = (t: string) => t.trim().slice(0, 5);

/**
 * Whether a stop's appointment falls outside the load's window, in plain words ("This stop is after the load's window
 * ends at 2:00 PM."), or null. A delivery is checked against both ends of the window; a pickup only against the end
 * (loading before the delivery window opens is normal). Stops without an appointment are not checked, and times are
 * checked only on a day the window covers.
 */
export function stopWindowWarning(stop: Pick<StopInput, "kind" | "appointment_date" | "window_start" | "window_end">, w: LoadWindow): string | null {
  const date = (stop.appointment_date ?? "").trim();
  if (!date) return null;
  const its = `the ${w.noun}'s window`;
  if (w.lastDay && date > w.lastDay) {
    return `This stop is on ${formatDate(date)}, after ${its} ends on ${formatDate(w.lastDay)}.`;
  }
  if (w.firstDay && date < w.firstDay && stop.kind === "delivery") {
    return `This stop is on ${formatDate(date)}, before ${its} starts on ${formatDate(w.firstDay)}.`;
  }
  if (w.firstDay && date < w.firstDay) return null;
  const s = (stop.window_start ?? "").trim(), e = (stop.window_end ?? "").trim();
  if (!w.start || !w.end || !s || !e) return null;
  const S = hhmm(w.start), E = hhmm(w.end), a = hhmm(s), b = hhmm(e);
  if (a >= E) return `This stop is after ${its} ends at ${formatTime(E)}.`;
  if (b > E) return `This stop runs past the end of ${its} at ${formatTime(E)}.`;
  if (stop.kind === "delivery") {
    if (b <= S) return `This stop is before ${its} starts at ${formatTime(S)}.`;
    if (a < S) return `This stop starts before ${its} opens at ${formatTime(S)}.`;
  }
  return null;
}

/** Each stop outside the window, by its position (0-based), with its warning. */
export function stopWindowWarnings(stops: ReadonlyArray<Pick<StopInput, "kind" | "appointment_date" | "window_start" | "window_end">>, w: LoadWindow): Array<{ index: number; message: string }> {
  const out: Array<{ index: number; message: string }> = [];
  stops.forEach((s, index) => {
    const message = stopWindowWarning(s, w);
    if (message) out.push({ index, message });
  });
  return out;
}

/** The warnings after a save, in one sentence each ("Stop 2 is after the load's window ends at 2:00 PM."). */
export function savedWindowNote(warnings: ReadonlyArray<{ index: number; message: string }>): string {
  return warnings.map((x) => x.message.replace(/^This stop/, `Stop ${x.index + 1}`)).join(" ");
}

// ---------------------------------------------------------------------------------------------------------------------
// Saved places for stops: the customer's job sites first, then the company's saved locations (yards, terminals,
// quarries, plants, shippers, receivers: Route planner). Picking one fills the stop's name and address.

export interface StopPlace {
  /** "site:<id>" or "location:<id>". */
  key: string;
  group: "site" | "location";
  name: string;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
  /** "Yard", "Shipper", "Job site", … */
  label: string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const placeText = (p: Pick<StopPlace, "name" | "address_line1" | "city" | "state" | "postal_code">) =>
  norm([p.name, p.address_line1, p.city, p.state, p.postal_code].join(" "));

/** Suggestions for what was typed: every word must appear in the place's name or address; customer sites first. */
export function matchPlaces(places: ReadonlyArray<StopPlace>, typed: string, limit = 8): StopPlace[] {
  const words = norm(typed).split(" ").filter(Boolean);
  const hits = words.length ? places.filter((p) => { const t = placeText(p); return words.every((w) => t.includes(w)); }) : [...places];
  return hits.sort((a, b) => (a.group === b.group ? 0 : a.group === "site" ? -1 : 1)).slice(0, limit);
}

/** True when the stop already is one of the saved places (same name and address), so there is nothing to save. */
export function isKnownPlace(places: ReadonlyArray<StopPlace>, s: Pick<StopInput, "name" | "address_line1" | "city" | "state" | "postal_code">): boolean {
  const name = norm(s.name), line1 = norm(s.address_line1), city = norm(s.city);
  return places.some((p) => norm(p.name) === name && norm(p.address_line1) === line1 && norm(p.city) === city);
}

/** A typed stop that can be saved for next time: a name and at least a street or a town, not already saved. */
export function canOfferSave(places: ReadonlyArray<StopPlace>, s: Pick<StopInput, "name" | "address_line1" | "city" | "state" | "postal_code">): boolean {
  return Boolean(s.name.trim() && (s.address_line1.trim() || s.city.trim())) && !isKnownPlace(places, s);
}

/** The kind a new saved place gets from its stop: shipper or receiver for freight, material pickup or other otherwise. */
export function placeKindFor(stopKind: StopKind, industry: unknown): "shipper" | "receiver" | "pickup" | "other" {
  if (haulsFreight(industry)) return stopKind === "pickup" ? "shipper" : "receiver";
  return stopKind === "pickup" ? "pickup" : "other";
}
