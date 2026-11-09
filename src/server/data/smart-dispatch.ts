import "server-only";
import { median, waitMinutes } from "@/lib/dispatch/wait-times";
import { listStopTimes } from "@/server/data/wait-times";
import type { Point } from "@/lib/routing/route";
import { pickTrailer, type OptimizationInput } from "@/lib/optimization/plan";
import { getTrailerInput } from "./trailer-input";
import { addDays } from "@/lib/dates";
import { recommend, toBoardPlan, type SmartShift, type SmartTimeOff, type SmartDocumentIssue, type SmartShopVisit, type SmartBooking, type SmartDriver, type SmartInput, type SmartLoad, type SmartTruck } from "@/lib/dispatch/smart";
import { dispatchBaseContext } from "@/server/data/bases";
import type { EligibilityQualification } from "@/lib/fleet/eligibility";
import { createClient } from "@/server/supabase/server";
import { businessToday } from "./settings";
import { hiredIds } from "./hired-trucks";
import { creditHolds } from "@/server/credit";

export const DISPATCHABLE = ["scheduled", "dispatched", "in_progress", "partially_completed"];

interface LoadRow {
  id: string;
  order_id: string;
  load_number: number;
  load_date: string;
  starts_at: string;
  ends_at: string;
  planned_quantity: number | string | null;
  unit_code: string | null;
  orders: { order_number: string; status: string; requested_date: string | null; site_line1: string; site_label: string; customer_id?: string; customers: { name: string; is_priority?: boolean } | null;
    /** The located customer site (B113 empty miles). */
    customer_sites?: { latitude: number | string | null; longitude: number | string | null } | null } | null;
}

/** The job site's located point, or null. */
const pointOf = (o: LoadRow["orders"]): Point | null => {
  const lat = o?.customer_sites?.latitude, lng = o?.customer_sites?.longitude;
  return lat == null || lng == null ? null : { lat: Number(lat), lng: Number(lng) };
};

const LOAD_SELECT = "id, order_id, load_number, load_date, starts_at, ends_at, planned_quantity, unit_code, orders(order_number, status, requested_date, site_line1, site_label, customer_id, customers(name), customer_sites(latitude, longitude))";

const site = (o: LoadRow["orders"]) => (o ? (o.site_line1 || o.site_label || "").trim().toLowerCase() : "");

/**
 * Everything Smart Dispatch reads, from the caller's own company (RLS), for
 * loads dated `from` through `to`. Throws when the data cannot be read (for
 * example without fleet access) — recommendations are never made from partial data.
 */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/** "06:00:00" → "6:00 AM". */
const clock = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export async function getSmartDispatchInput(from: string, to: string): Promise<SmartInput> {
  const supabase = await createClient();
  const { today, timezone } = await businessToday();
  const [loadsFirst, trucks, drivers, quals, reports, urgencies, onLeave, primaries, schedule] = await Promise.all([
    supabase
      .from("order_loads")
      .select(LOAD_SELECT.replace("customers(name)", "customers(name, is_priority)"))
      .eq("status", "planned")
      .gte("load_date", addDays(from, -1))
      .lte("load_date", addDays(to, 1)),
    supabase.from("trucks").select("id, unit_number, truck_type, active, service_status, expected_return_date, weight_capacity, weight_unit, volume_capacity, capacity_verified_at").eq("active", true),
    supabase.from("driver_list").select("id, display_name, active").eq("active", true),
    supabase.from("driver_qualifications").select("driver_id, kind, cdl_class, expires_on, verified_at"),
    supabase.from("field_reports").select("truck_id, kind, equipment, status").eq("equipment", "truck").in("status", ["open", "acknowledged"]),
    supabase.from("order_urgencies").select("order_id, needed_by").is("closed_at", null),
    // Employee status "On leave" (HR record): a warning only. Visible with employees.view; empty without it.
    supabase.from("employees").select("driver_id").eq("status", "on_leave").not("driver_id", "is", null),
    // Each driver's primary truck, for Keep crews together (a preference; nothing blocks on it).
    supabase.from("drivers").select("id, primary_truck_id").eq("active", true).not("primary_truck_id", "is", null),
    // Drivers' scheduled shifts (20261120003300): from the day before (overnight shifts) to the day after the range.
    supabase.rpc("schedule_range", { p_from: addDays(from, -1), p_days: Math.min(42, daysBetween(from, to) + 3) }),
  ]);
  // Before the priority-customer update (20261120005400) the column is missing: load without it (no priorities).
  const loads = loadsFirst.error && /is_priority/.test(loadsFirst.error.message)
    ? await supabase.from("order_loads").select(LOAD_SELECT).eq("status", "planned").gte("load_date", addDays(from, -1)).lte("load_date", addDays(to, 1))
    : loadsFirst;
  const primaryOf = new Map(((primaries.data ?? []) as Array<{ id: string; primary_truck_id: string }>).map((d) => [d.id, d.primary_truck_id]));
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

  // Expired vehicle documents and the company's rule per kind (20261112000200). Missing = not installed yet: the
  // database then has no document rule either, so nothing is blocked on documents.
  const docs = await supabase.rpc("dispatch_document_issues", { p_on: addDays(to, 2) });
  const docsMissing = docs.error && (docs.error.code === "PGRST202" || docs.error.code === "42883");
  if (docs.error && !docsMissing) throw new Error(`Smart Dispatch could not read vehicle documents: ${docs.error.message}`);

  const leave = await supabase.rpc("dispatch_time_off", { p_from: addDays(from, -1), p_to: addDays(to, 1) });
  const leaveMissing = leave.error && (leave.error.code === "PGRST202" || leave.error.code === "42883");
  if (leave.error && !leaveMissing) throw new Error(`Smart Dispatch could not read driver time off: ${leave.error.message}`);

  // Orders typed with an address instead of a saved site still get a location when the address matches one of the
  // customer's saved, located sites (same street line, case-insensitive). B113 empty miles.
  const unlinked = [...new Set(loadRows.filter((l) => l.orders && !l.orders.customer_sites && l.orders.customer_id && l.orders.site_line1).map((l) => l.orders!.customer_id!))];
  if (unlinked.length) {
    const sites = await supabase.from("customer_sites").select("customer_id, line1, latitude, longitude").in("customer_id", unlinked).not("latitude", "is", null);
    const byAddress = new Map(((sites.data ?? []) as Array<{ customer_id: string; line1: string; latitude: number; longitude: number }>).map((x) => [`${x.customer_id}|${x.line1.trim().toLowerCase()}`, x]));
    for (const l of loadRows) {
      const o = l.orders;
      if (!o || o.customer_sites || !o.customer_id) continue;
      const m = byAddress.get(`${o.customer_id}|${o.site_line1.trim().toLowerCase()}`);
      if (m) o.customer_sites = { latitude: m.latitude, longitude: m.longitude };
    }
  }
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
      point: pointOf(l.orders),
      customer_id: l.orders!.customer_id ?? null,
      priority_customer: Boolean(l.orders!.customers?.is_priority),
    }));

  // Loads that must not get a one-click proposal (UX3): the customer is on credit hold, or the load is offered to a hired
  // truck. Read with the person's session; when either is not installed the load is proposed as before.
  const heldIds = smartLoads.map((l) => l.id);
  const [holds, offers] = await Promise.all([
    creditHolds([...new Set(smartLoads.map((l) => l.customer_id).filter((x): x is string => Boolean(x)))]).catch(() => new Map<string, { name: string }>()),
    heldIds.length
      ? supabase.from("hauler_offers").select("load_id").in("load_id", heldIds).in("status", ["offered", "confirmed"]).then((r) => (r.error ? [] : (r.data ?? []) as Array<{ load_id: string }>))
      : Promise.resolve([] as Array<{ load_id: string }>),
  ]);
  const offered = new Set(offers.map((o) => o.load_id));
  for (const l of smartLoads) {
    if (offered.has(l.id)) l.hold = "This load is offered to a hired truck. Withdraw the offer before giving it to your own crew.";
    else if (l.customer_id && holds.has(l.customer_id)) l.hold = `${holds.get(l.customer_id)!.name} is on credit hold. Billing decides on the hold.`;
  }

  const bookings: SmartBooking[] = (assignments.data ?? []).map((a) => {
    const l = byLoad.get(a.load_id as string);
    return { load_id: a.load_id as string, order_id: a.order_id as string, truck_id: a.truck_id as string, driver_id: a.driver_id as string, starts_at: a.starts_at as string, ends_at: a.ends_at as string, load_date: l?.load_date ?? "", site: site(l?.orders ?? null), point: pointOf(l?.orders ?? null) };
  });

  // Dispatch bases (two or more): each load carries its order's base, each truck and driver its own.
  const bases = await dispatchBaseContext([...new Set(smartLoads.map((l) => l.order_id))]);
  if (bases) {
    for (const l of smartLoads) l.base_id = bases.order.get(l.order_id) ?? null;
  }

  const hired = await hiredIds();
  // Empty miles (B113): the yard where trucks start, and the cost per mile for people who see billing (RLS hides the
  // rates from everyone else, so they see miles only). Missing either: miles without a cost, or no miles.
  const [yardRow, rateRow] = await Promise.all([
    supabase.from("company_settings").select("yard_latitude, yard_longitude").maybeSingle(),
    supabase.from("company_cost_rates").select("empty_mile_cents").maybeSingle(),
  ]);
  const y = yardRow.data as { yard_latitude: number | string | null; yard_longitude: number | string | null } | null;
  const yard = y && y.yard_latitude != null && y.yard_longitude != null ? { lat: Number(y.yard_latitude), lng: Number(y.yard_longitude) } : null;
  const mileCents = rateRow.error ? null : ((rateRow.data as { empty_mile_cents: number | null } | null)?.empty_mile_cents ?? null);
  // Typical wait at each job site (B122): median of the last 60 days' recorded waits, 3+ visits. Matched on the site's
  // name or street line. Missing data: nothing shown.
  const stops = await listStopTimes(addDays(today, -60), addDays(today, -1), timezone).catch(() => null);
  if (stops) {
    const bySite = new Map<string, number[]>();
    for (const t of stops) {
      const w = waitMinutes(t);
      if (t.stop !== "site" || w === null || !t.placeLabel) continue;
      const k = t.placeLabel.split(",")[0].trim().toLowerCase();
      bySite.set(k, [...(bySite.get(k) ?? []), w]);
    }
    for (const l of smartLoads) {
      const row = byLoad.get(l.id)?.orders;
      const k = (row?.site_label || row?.site_line1 || "").trim().toLowerCase();
      const waits = k ? bySite.get(k) : undefined;
      if (waits && waits.length >= 3) l.site_wait = median(waits);
    }
  }
  // Learning from recorded decisions (B117): rejections not reconsidered, and loads drivers ran, per customer, over
  // the last 120 days. Any read error leaves learning out (proposals are made as before).
  const since = new Date(Date.now() - 120 * 86400_000).toISOString();
  const [rej, ran] = await Promise.all([
    supabase.from("dispatch_recommendation_rejections").select("truck_id, driver_id, order_loads(orders(customer_id))").is("cleared_at", null).gte("created_at", since).limit(5000),
    supabase.from("dispatch_assignments").select("driver_id, orders(customer_id)").eq("status", "active").gte("starts_at", since).lt("starts_at", new Date().toISOString()).limit(5000),
  ]);
  let learned: SmartInput["learned"];
  if (!rej.error && !ran.error) {
    const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
    learned = { driverRejected: {}, truckRejected: {}, driverWorked: {} };
    for (const r of (rej.data ?? []) as unknown as Array<{ truck_id: string; driver_id: string; order_loads: { orders: { customer_id: string } | null } | null }>) {
      const c = r.order_loads?.orders?.customer_id;
      if (!c) continue;
      bump(learned.driverRejected, `${r.driver_id}|${c}`);
      bump(learned.truckRejected, `${r.truck_id}|${c}`);
    }
    for (const a of (ran.data ?? []) as unknown as Array<{ driver_id: string; orders: { customer_id: string } | null }>) {
      if (a.orders?.customer_id) bump(learned.driverWorked, `${a.driver_id}|${a.orders.customer_id}`);
    }
  }
  return {
    today,
    yard,
    mileCents,
    learned,
    bases: bases ? { crossBase: bases.crossBase, names: bases.names } : undefined,
    loads: smartLoads,
    bookings,
    // Hired trucks and drivers (B83) are offered, never planned: Plan the day and Smart Dispatch leave them out.
    trucks: ((trucks.data ?? []) as Array<SmartTruck & { weight_capacity: number | string | null; volume_capacity: number | string | null }>).filter((t) => !hired.trucks.has(t.id)).map((t) => ({
      ...t,
      weight_capacity: t.weight_capacity === null ? null : Number(t.weight_capacity),
      volume_capacity: t.volume_capacity === null ? null : Number(t.volume_capacity),
      base_id: bases?.truck.get(t.id) ?? null,
    })),
    drivers: ((drivers.data ?? []) as Array<{ id: string; display_name: string; active: boolean }>).filter((d) => !hired.drivers.has(d.id)).map<SmartDriver>((d) => ({ id: d.id, name: d.display_name, active: d.active, qualifications: qualsBy.get(d.id) ?? [], primary_truck_id: primaryOf.get(d.id) ?? null, base_id: bases?.driver.get(d.id) ?? null })),
    truckReports: ((reports.data ?? []) as Array<{ truck_id: string | null; kind: string }>).filter((r) => r.truck_id).map((r) => ({ truck_id: r.truck_id as string, kind: r.kind })),
    rejections: (rejections.data ?? []) as SmartInput["rejections"],
    shopVisits: shopMissing ? [] : ((shop.data ?? []) as SmartShopVisit[]),
    documentIssues: docsMissing ? undefined : ((docs.data ?? []) as SmartDocumentIssue[]),
    maintenanceChecked: !shopMissing,
    timeOff: leaveMissing ? [] : ((leave.data ?? []) as SmartTimeOff[]),
    timeOffChecked: !leaveMissing,
    driversOnLeave: onLeave.error ? [] : ((onLeave.data ?? []) as Array<{ driver_id: string }>).map((e) => e.driver_id),
    // Before the scheduling update (or without access) no shifts: drivers are not checked, as the database does then.
    shifts: schedule.error ? [] : ((schedule.data ?? []) as Array<{ driver_id: string | null; work_date: string; status: SmartShift["status"]; start_at: string | null; end_at: string | null; start_time: string | null; end_time: string | null }>)
      .filter((r) => r.driver_id)
      .map((r) => ({ driver_id: r.driver_id!, date: r.work_date, status: r.status, start_at: r.start_at, end_at: r.end_at, label: r.start_time && r.end_time ? `${clock(r.start_time)}–${clock(r.end_time)}` : "" })),
  };
}

/** Proposals for every unassigned load from `from`, `days` days ahead (1–7). */
export async function getSmartDispatchPlan(from: string, days: number) {
  const to = addDays(from, Math.min(Math.max(days, 1), 7) - 1);
  const [smart, trailers] = await Promise.all([getSmartDispatchInput(from, to), getTrailerInput(from, to)]);
  // Tractors get a trailer by Plan the day's trailer rules (compatible, in service, not booked, combined capacity,
  // the driver's combination licence).
  const full: OptimizationInput = { ...smart, ...trailers, revenueCents: {} };
  const input: SmartInput = { ...smart, pickTrailer: (truck, load, driver, busy) => pickTrailer(full, load, truck, driver, busy) };
  // The browser gets exclusions grouped by reason, not one row per truck and driver per load (10.7 MB → see P8).
  return { from, to, plans: recommend(input).map((p) => toBoardPlan(p)) };
}
