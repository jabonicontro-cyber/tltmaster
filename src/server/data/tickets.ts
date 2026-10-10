import "server-only";
import type { TicketStatus } from "@/lib/tickets/rules";
import { uuid } from "@/lib/schemas/common";
import { createClient } from "@/server/supabase/server";
import type { AssignmentRow, OrderLoadRow } from "./dispatch";
import { getUserNames } from "./quotes";
import { ilikePattern } from "./search";
import { businessToday } from "./settings";
import type { OrderLineRow, OrderListRow, UnitRow } from "./types";

export interface TicketSnapshot {
  order_number: string;
  load_number: number;
  load_date: string;
  customer_name: string;
  line_description: string;
  line_unit_code: string | null;
  truck_unit: string;
  trailer_unit: string | null;
  driver_name: string;
  planned_quantity: number | null;
  planned_unit_code: string | null;
}

export interface TicketRow {
  id: string;
  ticket_number: string;
  revision: number;
  supersedes_id: string | null;
  status: TicketStatus;
  order_id: string;
  load_id: string;
  assignment_id: string;
  order_line_id: string;
  material_id: string | null;
  truck_id: string;
  trailer_id: string | null;
  driver_id: string;
  delivered_at: string;
  quantity: number | string;
  unit_code: string;
  external_reference: string;
  notes: string;
  review_reasons: string[];
  snapshot: TicketSnapshot;
  correction_reason: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string;
  created_by: string | null;
  created_at: string;
}

export interface TicketEventRow {
  id: string;
  ticket_id: string;
  ticket_number: string;
  action: "submitted" | "flagged" | "accepted" | "voided" | "corrected";
  from_status: TicketStatus | null;
  to_status: TicketStatus;
  note: string;
  details: { changes?: Record<string, { from: unknown; to: unknown }>; review_reasons?: string[]; revision?: number };
  actor_id: string | null;
  occurred_at: string;
}

export const TICKET_VIEWS = {
  awaiting: "Loads awaiting a ticket",
  review: "Needs review",
  submitted: "Submitted",
  accepted: "Accepted",
  voided: "Voided",
  all: "All tickets",
} as const;
export type TicketView = keyof typeof TICKET_VIEWS;

const IN_WORK = ["scheduled", "dispatched", "in_progress", "partially_completed", "completed"];

/** Assigned loads up to today without a live ticket — the paperwork still to enter. */
export async function listLoadsAwaitingTickets() {
  const supabase = await createClient();
  const { today } = await businessToday();
  const loads = await supabase.from("order_loads").select("*").eq("status", "planned").lte("load_date", today).order("load_date", { ascending: false }).order("start_time").limit(300);
  if (loads.error) throw new Error(`Could not load loads: ${loads.error.message}`);
  const loadRows = (loads.data ?? []) as OrderLoadRow[];
  if (!loadRows.length) return { rows: [], today };
  const ids = loadRows.map((l) => l.id);
  const [assignments, tickets, orders] = await Promise.all([
    supabase.from("dispatch_assignments").select("*").eq("status", "active").in("load_id", ids),
    supabase.from("delivery_tickets").select("load_id").in("load_id", ids).not("status", "in", "(voided,superseded)"),
    supabase.from("order_list").select("*").in("id", [...new Set(loadRows.map((l) => l.order_id))]),
  ]);
  const ticketed = new Set(((tickets.data ?? []) as Array<{ load_id: string }>).map((t) => t.load_id));
  const byLoad = new Map(((assignments.data ?? []) as AssignmentRow[]).map((a) => [a.load_id, a]));
  const orderById = new Map(((orders.data ?? []) as OrderListRow[]).map((o) => [o.id, o]));
  const names = await resourceNames();
  const rows = loadRows
    .filter((l) => byLoad.has(l.id) && !ticketed.has(l.id) && IN_WORK.includes(orderById.get(l.order_id)?.status ?? ""))
    .map((l) => {
      const a = byLoad.get(l.id)!;
      return {
        load: l,
        order: orderById.get(l.order_id)!,
        assignment: a,
        truck: names.trucks.get(a.truck_id) ?? "—",
        trailer: a.trailer_id ? names.trailers.get(a.trailer_id) ?? "—" : null,
        driver: names.drivers.get(a.driver_id) ?? "—",
      };
    });
  return { rows, today };
}

async function resourceNames() {
  const supabase = await createClient();
  const [trucks, trailers, drivers] = await Promise.all([
    supabase.from("trucks").select("id, unit_number"),
    supabase.from("trailers").select("id, unit_number"),
    supabase.from("driver_list").select("id, display_name"),
  ]);
  return {
    trucks: new Map(((trucks.data ?? []) as Array<{ id: string; unit_number: string }>).map((t) => [t.id, t.unit_number])),
    trailers: new Map(((trailers.data ?? []) as Array<{ id: string; unit_number: string }>).map((t) => [t.id, t.unit_number])),
    drivers: new Map(((drivers.data ?? []) as Array<{ id: string; display_name: string }>).map((d) => [d.id, d.display_name])),
  };
}

/** Current revisions (superseded ones are history). */
export async function listTickets(view: TicketView, q?: string) {
  const supabase = await createClient();
  let query = supabase.from("delivery_tickets").select("*").neq("status", "superseded").order("delivered_at", { ascending: false }).limit(300);
  if (view === "review") query = query.eq("status", "needs_review");
  else if (view === "submitted") query = query.eq("status", "submitted");
  else if (view === "accepted") query = query.eq("status", "accepted");
  else if (view === "voided") query = query.eq("status", "voided");
  const pattern = ilikePattern(q);
  if (pattern) {
    query = query.or(`ticket_number.ilike.${pattern},external_reference.ilike.${pattern},snapshot->>order_number.ilike.${pattern},snapshot->>customer_name.ilike.${pattern},snapshot->>truck_unit.ilike.${pattern},snapshot->>driver_name.ilike.${pattern}`);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Could not load tickets: ${error.message}`);
  return (data ?? []) as TicketRow[];
}

/** Counts for the tabs and the dashboard. */
export async function ticketCounts() {
  const supabase = await createClient();
  const count = async (status: TicketStatus) => {
    const { count: n } = await supabase.from("delivery_tickets").select("id", { count: "exact", head: true }).eq("status", status);
    return n ?? 0;
  };
  const [review, submitted] = await Promise.all([count("needs_review"), count("submitted")]);
  return { review, submitted };
}

/** A revision with its ticket's full history (all revisions and events). */
export async function getTicket(id: string) {
  if (!uuid.safeParse(id).success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("delivery_tickets").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load ticket: ${error.message}`);
  if (!data) return null;
  const t = data as TicketRow;
  const [revisions, events, units, names, people] = await Promise.all([
    supabase.from("delivery_tickets").select("*").eq("ticket_number", t.ticket_number).order("revision", { ascending: false }),
    supabase.from("delivery_ticket_events").select("*").eq("ticket_number", t.ticket_number).order("occurred_at", { ascending: false }),
    supabase.from("units_of_measure").select("*").order("sort_order"),
    resourceNames(),
    getUserNames(),
  ]);
  return {
    ticket: t,
    revisions: (revisions.data ?? []) as TicketRow[],
    events: (events.data ?? []) as TicketEventRow[],
    units: (units.data ?? []) as UnitRow[],
    names,
    people,
  };
}

/** Everything the ticket form needs for a load. */
export async function getLoadForTicket(loadId: string) {
  if (!uuid.safeParse(loadId).success) return null;
  const supabase = await createClient();
  const { data: load } = await supabase.from("order_loads").select("*").eq("id", loadId).maybeSingle();
  if (!load) return null;
  const l = load as OrderLoadRow;
  const [order, assignment, lines, units, trucks, trailers, drivers, tickets, { today }] = await Promise.all([
    supabase.from("order_list").select("*").eq("id", l.order_id).single(),
    supabase.from("dispatch_assignments").select("*").eq("load_id", l.id).eq("status", "active").maybeSingle(),
    supabase.from("order_lines").select("*").eq("order_id", l.order_id).eq("calc_method", "per_unit").neq("kind", "discount").order("line_no"),
    supabase.from("units_of_measure").select("*").order("sort_order"),
    supabase.from("trucks").select("id, unit_number, active").order("unit_number"),
    supabase.from("trailers").select("id, unit_number, active").order("unit_number"),
    supabase.from("driver_list").select("id, display_name, active").order("display_name"),
    supabase.from("delivery_tickets").select("id, ticket_number, status").eq("load_id", l.id).not("status", "in", "(voided,superseded)"),
    businessToday(),
  ]);
  return {
    load: l,
    order: order.data as OrderListRow,
    assignment: (assignment.data ?? null) as AssignmentRow | null,
    lines: (lines.data ?? []) as OrderLineRow[],
    units: (units.data ?? []) as UnitRow[],
    trucks: (trucks.data ?? []) as Array<{ id: string; unit_number: string; active: boolean }>,
    trailers: (trailers.data ?? []) as Array<{ id: string; unit_number: string; active: boolean }>,
    drivers: (drivers.data ?? []) as Array<{ id: string; display_name: string; active: boolean }>,
    existing: (tickets.data ?? []) as Array<{ id: string; ticket_number: string; status: TicketStatus }>,
    today,
  };
}

export type LoadForTicket = NonNullable<Awaited<ReturnType<typeof getLoadForTicket>>>;

/** Live tickets of the given loads (dispatch board, order page). */
export async function liveTicketsForLoads(loadIds: string[]) {
  if (!loadIds.length) return [] as Array<Pick<TicketRow, "id" | "load_id" | "ticket_number" | "status" | "quantity" | "unit_code">>;
  const supabase = await createClient();
  const { data } = await supabase
    .from("delivery_tickets")
    .select("id, load_id, ticket_number, status, quantity, unit_code")
    .in("load_id", loadIds)
    .not("status", "in", "(voided,superseded)")
    .order("ticket_number");
  return (data ?? []) as Array<Pick<TicketRow, "id" | "load_id" | "ticket_number" | "status" | "quantity" | "unit_code">>;
}

