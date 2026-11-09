import { addDays } from "@/lib/dates";

// The weekly shop report (2026-11-09): read-only, derived from existing records (work orders, labor time, part cost
// lines, service status history, preventive schedules). Nothing is estimated; what is not recorded is said so.

/** Monday of the week that holds `date` (YYYY-MM-DD), and the Monday after (exclusive end). */
export function weekOf(date: string): { start: string; end: string } {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const start = addDays(date, -((day + 6) % 7));
  return { start, end: addDays(start, 7) };
}

export interface StatusEvent { from_status: string; to_status: string; occurred_at: string }

/**
 * Milliseconds a unit was out of service between startMs and endMs (exclusive), from its recorded status changes and,
 * for time after the last change, its current status. Time after `nowMs` never counts.
 */
export function outOfServiceMs(
  events: ReadonlyArray<StatusEvent>,
  current: { service_status: string; out_of_service_since: string | null },
  startMs: number,
  endMs: number,
  nowMs: number,
): number {
  const stop = Math.min(endMs, nowMs);
  if (stop <= startMs) return 0;
  const ordered = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const overlap = (from: number, to: number) => Math.max(0, Math.min(to, stop) - Math.max(from, startMs));
  let ms = 0;
  let outFrom: number | null = null;
  // Before the first recorded change the unit was in the change's "from" status.
  if (ordered.length && ordered[0].from_status === "out_of_service") outFrom = -Infinity;
  for (const e of ordered) {
    const t = Date.parse(e.occurred_at);
    if (e.to_status === "out_of_service" && outFrom === null) outFrom = t;
    else if (e.to_status === "in_service" && outFrom !== null) {
      ms += overlap(outFrom, t);
      outFrom = null;
    }
  }
  if (outFrom === null && !ordered.length && current.service_status === "out_of_service") {
    outFrom = current.out_of_service_since ? Date.parse(current.out_of_service_since) : -Infinity;
  }
  if (outFrom !== null) ms += overlap(outFrom, Infinity);
  return ms;
}

export interface WeekWorkOrder {
  id: string;
  number: string;
  title: string;
  truck_id: string | null;
  trailer_id: string | null;
  category: string;
  schedule_id: string | null;
  created_at: string;
  completed_at: string | null;
  closed_at: string | null;
}

export interface WeekTimeEntry { work_order_id: string; started_at: string; ended_at: string | null }
export interface WeekCostLine { work_order_id: string; quantity: number; unit_cost_cents: number }
export interface WeekPm { schedule_id: string; truck_id: string; unit_number: string; name: string; state: string; next_due_on: string | null; open_work_order_number: string | null }

export interface ShopWeek {
  opened: WeekWorkOrder[];
  completed: WeekWorkOrder[];
  closed: WeekWorkOrder[];
  /** Labor minutes recorded on jobs (time entries started in the week); null when labor time is not recorded here. */
  laborMinutes: number | null;
  /** Running timers started in the week (not counted in the hours). */
  runningTimers: number;
  /** Part cost lines added in the week, in cents; null when the person can't see costs. */
  partsCents: number | null;
  /** Days out of service per truck in the week (only trucks with any), most first. */
  outOfService: Array<{ truck_id: string; unit_number: string; days: number }>;
  /** Preventive jobs completed in the week. */
  pmDone: WeekWorkOrder[];
  /** Preventive services due by the end of the week and not done (as of today). */
  pmDue: WeekPm[];
}

export function shopWeek(input: {
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  nowMs: number;
  workOrders: ReadonlyArray<WeekWorkOrder>;
  time: ReadonlyArray<WeekTimeEntry> | null;
  partCosts: ReadonlyArray<WeekCostLine> | null;
  trucks: ReadonlyArray<{ id: string; unit_number: string; service_status: string; out_of_service_since: string | null }>;
  events: ReadonlyArray<StatusEvent & { truck_id: string | null }>;
  pm: ReadonlyArray<WeekPm>;
}): ShopWeek {
  const inWeek = (iso: string | null) => Boolean(iso) && Date.parse(iso!) >= input.startMs && Date.parse(iso!) < input.endMs;
  const completed = input.workOrders.filter((w) => inWeek(w.completed_at));
  let laborMinutes: number | null = null;
  let runningTimers = 0;
  if (input.time) {
    laborMinutes = 0;
    for (const t of input.time) {
      if (!inWeek(t.started_at)) continue;
      if (!t.ended_at) { runningTimers += 1; continue; }
      laborMinutes += Math.max(0, Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 60000));
    }
  }
  const byTruck = new Map<string, StatusEvent[]>();
  for (const e of input.events) if (e.truck_id) byTruck.set(e.truck_id, [...(byTruck.get(e.truck_id) ?? []), e]);
  const outOfService = input.trucks
    .map((t) => ({ truck_id: t.id, unit_number: t.unit_number, days: Math.round((outOfServiceMs(byTruck.get(t.id) ?? [], t, input.startMs, input.endMs, input.nowMs) / 86400_000) * 10) / 10 }))
    .filter((t) => t.days > 0)
    .sort((a, b) => b.days - a.days || a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true }));
  const lastDay = addDays(input.end, -1);
  return {
    opened: input.workOrders.filter((w) => inWeek(w.created_at)),
    completed,
    closed: input.workOrders.filter((w) => inWeek(w.closed_at)),
    laborMinutes,
    runningTimers,
    partsCents: input.partCosts ? input.partCosts.reduce((s, c) => s + Math.round(c.quantity * c.unit_cost_cents), 0) : null,
    outOfService,
    pmDone: completed.filter((w) => w.schedule_id || w.category === "preventive"),
    pmDue: input.pm.filter((p) => p.state === "overdue" || (p.next_due_on !== null && p.next_due_on <= lastDay)),
  };
}

/** "12 h 30 min" for minutes of labor. */
export function hoursText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}
