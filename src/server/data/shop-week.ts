import "server-only";
import { zonedTimeToUtc } from "@/lib/dates";
import { shopWeek, type ShopWeek, type WeekCostLine, type WeekTimeEntry, type WeekWorkOrder } from "@/lib/maintenance/shop-week";
import { allRows } from "@/server/data/all-rows";
import { createClient } from "@/server/supabase/server";
import { listPmStatus } from "@/server/data/maintenance";

// The weekly shop report (2026-11-09), read with the person's session (RLS): work orders and the clearance history
// with maintenance.view, labor time with maintenance.view, part cost lines only with maintenance.costs. Read-only.

const MISSING = new Set(["42P01", "PGRST205", "42703"]);

export async function loadShopWeek(start: string, end: string, timezone: string, withCosts: boolean): Promise<ShopWeek & { units: Map<string, string> }> {
  const supabase = await createClient();
  const from = zonedTimeToUtc(start, "00:00", timezone) ?? `${start}T00:00:00Z`;
  const to = zonedTimeToUtc(end, "00:00", timezone) ?? `${end}T00:00:00Z`;
  const inWeek = (col: string) => `and(${col}.gte.${from},${col}.lt.${to})`;
  const [wos, time, costs, trucks, trailers, events, pm] = await Promise.all([
    allRows(() => supabase.from("work_orders").select("id, number, title, truck_id, trailer_id, category, schedule_id, created_at, completed_at, closed_at")
      .or([inWeek("created_at"), inWeek("completed_at"), inWeek("closed_at")].join(",")).order("created_at").order("id")),
    allRows(() => supabase.from("work_order_time_entries").select("work_order_id, started_at, ended_at").is("voided_at", null).gte("started_at", from).lt("started_at", to).order("id")),
    withCosts
      ? allRows(() => supabase.from("work_order_costs").select("work_order_id, quantity, unit_cost_cents").eq("kind", "part").gte("created_at", from).lt("created_at", to).order("id"))
      : Promise.resolve(null),
    supabase.from("trucks").select("id, unit_number, service_status, out_of_service_since").eq("active", true).order("unit_number"),
    supabase.from("trailers").select("id, unit_number"),
    allRows(() => supabase.from("equipment_status_events").select("truck_id, from_status, to_status, occurred_at").not("truck_id", "is", null).lt("occurred_at", to).order("occurred_at").order("id")),
    listPmStatus().catch(() => []),
  ]);
  if (wos.error) throw new Error(`Could not load work orders: ${wos.error.message}`);
  if (trucks.error) throw new Error(`Could not load trucks: ${trucks.error.message}`);
  if (events.error) throw new Error(`Could not load service history: ${events.error.message}`);
  if (time.error && !MISSING.has(time.error.code ?? "")) throw new Error(`Could not load labor time: ${time.error.message}`);
  const units = new Map<string, string>();
  for (const t of (trucks.data ?? []) as Array<{ id: string; unit_number: string }>) units.set(t.id, `Truck ${t.unit_number}`);
  for (const t of (trailers.data ?? []) as Array<{ id: string; unit_number: string }>) units.set(t.id, `Trailer ${t.unit_number}`);
  const report = shopWeek({
    start, end, startMs: Date.parse(from), endMs: Date.parse(to), nowMs: Date.now(),
    workOrders: (wos.data ?? []) as WeekWorkOrder[],
    time: time.error ? null : (time.data ?? []) as WeekTimeEntry[],
    partCosts: costs && !costs.error ? ((costs.data ?? []) as Array<Record<string, unknown>>).map((c) => ({ work_order_id: String(c.work_order_id), quantity: Number(c.quantity), unit_cost_cents: Number(c.unit_cost_cents) }) as WeekCostLine) : null,
    trucks: (trucks.data ?? []) as Array<{ id: string; unit_number: string; service_status: string; out_of_service_since: string | null }>,
    events: (events.data ?? []) as Array<{ truck_id: string | null; from_status: string; to_status: string; occurred_at: string }>,
    pm: pm.map((p) => ({ schedule_id: p.schedule_id, truck_id: p.truck_id, unit_number: p.unit_number, name: p.name, state: p.state, next_due_on: p.next_due_on, open_work_order_number: p.open_work_order_number })),
  });
  return { ...report, units };
}
