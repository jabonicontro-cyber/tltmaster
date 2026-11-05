import { DOCUMENT_KINDS, type DocumentKind } from "./availability";
import { QUALIFICATION_SHORT } from "./labels";
import type { QualificationKind } from "@/server/data/types";

// Compliance calendar (owner 2026-11-05, master plan CC1): one list of every due date the company already records:
// driver credentials, truck and trailer documents, date-based preventive service, and the IFTA quarter when the company
// keeps trip sheets. Read only: the alerts and dispatch rules on those records stay as they are; this just puts the
// dates in one place. Nothing is invented: a record without a date isn't listed.

export type DueKind = "driver" | "vehicle" | "service" | "ifta";
export type DueState = "overdue" | "soon" | "later";
export interface DueItem { key: string; kind: DueKind; what: string; subject: string; due: string; href: string }

export const DUE_KIND_LABELS: Record<DueKind, string> = { driver: "Driver", vehicle: "Truck or trailer", service: "Service", ifta: "Fuel tax" };

const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
export const daysUntil = (due: string, today: string) => Math.round((day(due) - day(today)) / 86_400_000);

export function dueState(due: string, today: string, soonDays = 30): DueState {
  const d = daysUntil(due, today);
  return d < 0 ? "overdue" : d <= soonDays ? "soon" : "later";
}

/** The next IFTA quarterly return due date on or after today (returns are due the last day of the month after the quarter). */
export function nextIftaDeadline(today: string): { due: string; quarter: string } {
  const y = Number(today.slice(0, 4));
  const candidates = [
    { due: `${y}-01-31`, quarter: `Q4 ${y - 1}` },
    { due: `${y}-04-30`, quarter: `Q1 ${y}` },
    { due: `${y}-07-31`, quarter: `Q2 ${y}` },
    { due: `${y}-10-31`, quarter: `Q3 ${y}` },
    { due: `${y + 1}-01-31`, quarter: `Q4 ${y}` },
  ];
  return candidates.find((c) => c.due >= today.slice(0, 10))!;
}

export interface CalendarInput {
  today: string;
  drivers: Array<{ id: string; name: string }>;
  quals: Array<{ id?: string; driver_id: string; kind: QualificationKind; expires_on: string | null; description?: string }>;
  docs: Array<{ id: string; truck_id: string | null; trailer_id: string | null; kind: DocumentKind; title: string; expires_on: string | null; archived_at: string | null }>;
  trucks: Array<{ id: string; unit_number: string; active?: boolean }>;
  trailers: Array<{ id: string; unit_number: string; active?: boolean }>;
  service: Array<{ schedule_id: string; truck_id: string; unit_number: string; name: string; next_due_on: string | null }> | null;
  ifta: boolean;
}

/** Everything overdue, and everything due within the horizon, soonest first. */
export function buildCalendar(input: CalendarInput, horizonDays = 90): DueItem[] {
  const { today } = input;
  const keep = (due: string | null): due is string => Boolean(due) && daysUntil(due!, today) <= horizonDays;
  const drivers = new Map(input.drivers.map((d) => [d.id, d.name]));
  const trucks = new Map(input.trucks.filter((t) => t.active !== false).map((t) => [t.id, t.unit_number]));
  const trailers = new Map(input.trailers.filter((t) => t.active !== false).map((t) => [t.id, t.unit_number]));
  const items: DueItem[] = [];
  for (const q of input.quals) {
    const name = drivers.get(q.driver_id);
    if (!name || !keep(q.expires_on)) continue;
    items.push({ key: `q-${q.id ?? `${q.driver_id}-${q.kind}`}`, kind: "driver", what: `${(q.kind === "other" && q.description?.trim()) || QUALIFICATION_SHORT[q.kind]} expires`, subject: name, due: q.expires_on, href: `/fleet/drivers/${q.driver_id}` });
  }
  for (const d of input.docs) {
    if (d.archived_at || !keep(d.expires_on)) continue;
    const truck = d.truck_id ? trucks.get(d.truck_id) : undefined;
    const trailer = d.trailer_id ? trailers.get(d.trailer_id) : undefined;
    if (!truck && !trailer) continue;
    const what = `${d.title.trim() || DOCUMENT_KINDS[d.kind]} expires`;
    items.push({
      key: `d-${d.id}`, kind: "vehicle", what, due: d.expires_on,
      subject: truck ? `Truck ${truck}` : `Trailer ${trailer}`,
      href: truck ? `/fleet/trucks/${d.truck_id}` : `/fleet/trailers/${d.trailer_id}`,
    });
  }
  for (const s of input.service ?? []) {
    if (!trucks.has(s.truck_id) || !keep(s.next_due_on)) continue;
    items.push({ key: `s-${s.schedule_id}`, kind: "service", what: `${s.name} due`, subject: `Truck ${s.unit_number}`, due: s.next_due_on, href: "/maintenance" });
  }
  if (input.ifta) {
    const next = nextIftaDeadline(today);
    if (keep(next.due)) items.push({ key: `ifta-${next.quarter}`, kind: "ifta", what: `IFTA return for ${next.quarter} due`, subject: "Company", due: next.due, href: "/fleet/fuel" });
  }
  return items.sort((a, b) => a.due.localeCompare(b.due) || a.subject.localeCompare(b.subject));
}
