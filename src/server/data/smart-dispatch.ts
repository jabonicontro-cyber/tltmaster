import "server-only";
import { addDays } from "@/lib/dates";
import { recommend, type SmartTimeOff, type SmartShopVisit, type SmartBooking, type SmartDriver, type SmartInput, type SmartLoad, type SmartTruck } from "@/lib/dispatch/smart";
import type { EligibilityQualification } from "@/lib/fleet/eligibility";
import { createClient } from "@/server/supabase/server";
import { businessToday } from "./settings";

const DISPATCHABLE = ["scheduled", "dispatched", "in_progress", "partially_completed"];

interface LoadRow {
  id: string;
  order_id: string;
  load_number: number;
  load_date: string;
  starts_at: string;
  ends_at: string;
  planned_quantity: number | string | null;
  unit_code: string | null;
  orders: { order_number: string; status: string; requested_date: string | null; site_line1: string; site_label: string; customers: { name: string } | null } | null;
}

const site = (o: LoadRow["orders"]) => (o ? (o.site_line1 || o.site_label || "").trim().toLowerCase() : "");

/**
 * Everything Smart Dispatch reads, from the caller's own company (RLS), for
 * loads dated `from` through `to`. Throws when the data cannot be read (for
 * example without fleet access) — recommendations are never made from partial data.
 */
export async function getSmartDispatchInput(from: string, to: string): Promise<SmartInput> {
  const supabase = await createClient();
  const { today } = await businessToday();
  const [loads, trucks, drivers, quals, reports, urgencies] = await Promise.all([
    supabase
      .from("order_loads")
      .select("id, order_id, load_number, load_date, starts_at, ends_at, planned_quantity, unit_code, orders(order_number, status, requested_date, site_line1, site_label, customers(name))")
      .eq("status", "planned")
      .gte("load_date", addDays(from, -1))
      .lte("load_date", addDays(to, 1)),
    supabase.from("trucks").select("id, unit_number, truck_type, active, service_status, expected_return_date, weight_capacity, weight_unit, volume_capacity, capacity_verified_at").eq("active", true),
    supabase.from("driver_list").select("id, display_name, active").eq("active", true),
    supabase.from("driver_qualifications").select("driver_id, kind, cdl_class, expires_on, verified_at"),
    supabase.from("field_reports").select("truck_id, kind, equipment, status").eq("equipment", "truck").in("status", ["open", "acknowledged"]),
    supabase.from("order_urgencies").select("order_id, needed_by").is("closed_at", null),
  ]);
  for (const r of [loads, trucks, drivers, quals, reports, urgencies]) {
    if (r.error) throw new Error(`Smart Dispatch could not read the data it needs: ${r.error.message}`);
  }
  const loadRows = (loads.data ?? []) as unknown as LoadRow[];
  const loadIds = loadRows.map((l) => l.id);
  const [assignments, rejections] = loadIds.length
    ? await Promise.all([
        supabase.from("dispatch_assignments").select("load_id, order_id, truck_id, driver_id, starts_at, ends_at").eq("status", "active").in("load_id", loadIds),
        supabase.from("dispatch_recommendation_rejections").select("load_id, truck_id, driver_id").is("cleared_at", null).in("load_id", loadIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (assignments.error || rejections.error) throw new Error("Smart Dispatch could not read current assignments.");

  // Shop visits and restrictions from Maintenance (dispatch.view is enough). When the
  // function does not exist yet (database update not installed), say so instead of failing;
  // the database still refuses unsafe assignments where the update is installed.
  const shop = await supabase.rpc("dispatch_shop_schedule", { p_from: addDays(from, -1), p_to: addDays(to, 1) });
  const shopMissing = shop.error && (shop.error.code === "PGRST202" || shop.error.code === "42883");
  if (shop.error && !shopMissing) throw new Error(`Smart Dispatch could not read the shop schedule: ${shop.error.message}`);

  const leave = await supabase.rpc("dispatch_time_off", { p_from: addDays(from, -1), p_to: addDays(to, 1) });
  const leaveMissing = leave.error && (leave.error.code === "PGRST202" || leave.error.code === "42883");
  if (leave.error && !leaveMissing) throw new Error(`Smart Dispatch could not read driver time off: ${leave.error.message}`);

  const byLoad = new Map(loadRows.map((l) => [l.id, l]));
  const assigned = new Set((assignments.data ?? []).map((a) => a.load_id as string));
  const urgent = new Map((urgencies.data ?? []).map((u) => [u.order_id as string, u.needed_by as string | null]));
  const qualsBy = new Map<string, EligibilityQualification[]>();
  for (const q of (quals.data ?? []) as Array<EligibilityQualification & { driver_id: string }>) {
    qualsBy.set(q.driver_id, [...(qualsBy.get(q.driver_id) ?? []), { kind: q.kind, cdl_class: q.cdl_class, expires_on: q.expires_on, verified_at: q.verified_at }]);
  }

  const smartLoads: SmartLoad[] = loadRows
    .filter((l) => l.load_date >= from && l.load_date <= to && !assigned.has(l.id) && l.orders && DISPATCHABLE.includes(l.orders.status))
    .map((l) => ({
      id: l.id,
      order_id: l.order_id,
      order_number: l.orders!.order_number,
      customer_name: l.orders!.customers?.name ?? null,
      site: site(l.orders),
      load_number: l.load_number,
      load_date: l.load_date,
      starts_at: l.starts_at,
      ends_at: l.ends_at,
      planned_quantity: l.planned_quantity === null ? null : Number(l.planned_quantity),
      unit_code: l.unit_code,
      requested_date: l.orders!.requested_date,
      urgent: urgent.has(l.order_id),
      needed_by: urgent.get(l.order_id) ?? null,
    }));

  const bookings: SmartBooking[] = (assignments.data ?? []).map((a) => {
    const l = byLoad.get(a.load_id as string);
    return { load_id: a.load_id as string, order_id: a.order_id as string, truck_id: a.truck_id as string, driver_id: a.driver_id as string, starts_at: a.starts_at as string, ends_at: a.ends_at as string, load_date: l?.load_date ?? "", site: site(l?.orders ?? null) };
  });

  return {
    today,
    loads: smartLoads,
    bookings,
    trucks: ((trucks.data ?? []) as Array<SmartTruck & { weight_capacity: number | string | null; volume_capacity: number | string | null }>).map((t) => ({
      ...t,
      weight_capacity: t.weight_capacity === null ? null : Number(t.weight_capacity),
      volume_capacity: t.volume_capacity === null ? null : Number(t.volume_capacity),
    })),
    drivers: ((drivers.data ?? []) as Array<{ id: string; display_name: string; active: boolean }>).map<SmartDriver>((d) => ({ id: d.id, name: d.display_name, active: d.active, qualifications: qualsBy.get(d.id) ?? [] })),
    truckReports: ((reports.data ?? []) as Array<{ truck_id: string | null; kind: string }>).filter((r) => r.truck_id).map((r) => ({ truck_id: r.truck_id as string, kind: r.kind })),
    rejections: (rejections.data ?? []) as SmartInput["rejections"],
    shopVisits: shopMissing ? [] : ((shop.data ?? []) as SmartShopVisit[]),
    maintenanceChecked: !shopMissing,
    timeOff: leaveMissing ? [] : ((leave.data ?? []) as SmartTimeOff[]),
    timeOffChecked: !leaveMissing,
  };
}

/** Proposals for every unassigned load from `from`, `days` days ahead (1–7). */
export async function getSmartDispatchPlan(from: string, days: number) {
  const to = addDays(from, Math.min(Math.max(days, 1), 7) - 1);
  return { from, to, plans: recommend(await getSmartDispatchInput(from, to)) };
}
