import "server-only";
import { addDays } from "@/lib/dates";
import { parseRules, REPAIR_WINDOW_DAYS, truckHealth, type Health, type HealthRules, type TruckFacts } from "@/lib/fleet/health";
import { OPEN_STATUSES } from "@/lib/maintenance";
import { listPmStatus } from "@/server/data/maintenance";
import { businessToday, getSettings } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";

// Truck health (B93), read with the person's own session (fleet or maintenance access; RLS decides what is visible).

export interface TruckHealthRow extends Health {
  truck_id: string;
  unit_number: string;
  facts: TruckFacts;
}

export async function loadTruckHealth(): Promise<{ rules: HealthRules; rows: TruckHealthRow[] }> {
  const supabase = await createClient();
  const [{ today }, settings] = await Promise.all([businessToday(), getSettings()]);
  const since = `${addDays(today, -REPAIR_WINDOW_DAYS)}T00:00:00Z`;
  const [trucks, open, recent, pm] = await Promise.all([
    supabase.from("trucks").select("id, unit_number, service_status").eq("active", true).is("hauler_id", null).order("unit_number"),
    supabase.from("work_orders").select("truck_id, safety_critical, restricted_truck, clearance_status").in("status", OPEN_STATUSES),
    supabase.from("work_orders").select("truck_id, category, source").gte("created_at", since).neq("status", "canceled").not("category", "in", "(preventive,inspection)").neq("source", "preventive"),
    listPmStatus().catch(() => []),
  ]);
  // Before hired trucks (20261120003700) there is no hauler_id: read every truck then.
  const truckRows = trucks.error && trucks.error.code === "42703"
    ? (await supabase.from("trucks").select("id, unit_number, service_status").eq("active", true).order("unit_number")).data ?? []
    : trucks.data ?? [];
  if (trucks.error && trucks.error.code !== "42703") throw new Error(`Could not load trucks: ${trucks.error.message}`);
  for (const r of [open, recent]) if (r.error) throw new Error(`Could not load work orders: ${r.error.message}`);

  const facts = new Map<string, TruckFacts>();
  for (const t of truckRows as Array<{ id: string; service_status: string }>) facts.set(t.id, { outOfService: t.service_status === "out_of_service", openSafety: 0, openOther: 0, repairs90: 0, serviceOverdue: 0 });
  for (const w of (open.data ?? []) as Array<{ truck_id: string | null; safety_critical: boolean; restricted_truck: boolean; clearance_status: string | null }>) {
    const f = w.truck_id ? facts.get(w.truck_id) : undefined;
    if (!f) continue;
    if (w.safety_critical || w.restricted_truck) f.openSafety++;
    else f.openOther++;
  }
  for (const w of (recent.data ?? []) as Array<{ truck_id: string | null }>) {
    const f = w.truck_id ? facts.get(w.truck_id) : undefined;
    if (f) f.repairs90++;
  }
  for (const p of pm) {
    const f = facts.get(p.truck_id);
    if (f && p.state === "overdue") f.serviceOverdue++;
  }

  const rules = parseRules((settings as unknown as { truck_health_rules?: unknown }).truck_health_rules);
  const rows = (truckRows as Array<{ id: string; unit_number: string }>).map((t) => {
    const f = facts.get(t.id)!;
    return { truck_id: t.id, unit_number: t.unit_number, facts: f, ...truckHealth(f, rules) };
  });
  return { rules, rows };
}
