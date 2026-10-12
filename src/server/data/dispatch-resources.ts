import "server-only";
import { driverChecks, type EligibilityQualification } from "@/lib/fleet/eligibility";
import { vehicleAvailability, type Availability, type OpenWorkOrder } from "@/lib/fleet/availability";
import { createClient } from "@/server/supabase/server";
import { businessToday } from "./settings";

// Who and what can work on a given day, from the records that decide it:
// bookings (active assignments), qualifications, service status and the shop
// schedule. Four separate questions are kept separate — administrative status,
// schedule, qualification, and hours of service (unknown: no ELD data).

export interface ResourceBooking { load_id: string; order_id: string; order_number: string; load_number: number; starts_at: string; ends_at: string; truck_id: string; driver_id: string; trailer_id: string | null }

export interface TruckResource {
  id: string;
  unit_number: string;
  truck_type: string;
  availability: Availability;
  shopToday: OpenWorkOrder | null;
  bookings: ResourceBooking[];
  driver: { id: string; name: string } | null;
}

export interface DriverResource {
  id: string;
  name: string;
  qualification: { eligible: boolean; blockers: string[]; warnings: string[] };
  bookings: ResourceBooking[];
  primaryTruck: { id: string; unit: string } | null;
  /** Approved or pending time off touching this date (no category or reason). */
  timeOff: Array<{ status: "approved" | "pending"; full_day: boolean; start_time: string | null; end_time: string | null; start_date: string; end_date: string; starts_at: string; ends_at: string }>;
  /** Active bookings that overlap approved time off — need a dispatcher's review. */
  leaveConflicts: ResourceBooking[];
}

export async function getDispatchResources(date: string) {
  const supabase = await createClient();
  const { today, timezone } = await businessToday();
  const [trucks, drivers, driverRows, quals, loads, shop] = await Promise.all([
    supabase.from("trucks").select("id, unit_number, truck_type, active, service_status, out_of_service_reason, expected_return_date").eq("active", true).order("unit_number"),
    supabase.from("driver_list").select("id, display_name, active").eq("active", true).order("display_name"),
    supabase.from("drivers").select("id, primary_truck_id").eq("active", true),
    supabase.from("driver_qualifications").select("driver_id, kind, cdl_class, expires_on, verified_at"),
    supabase.from("order_loads").select("id, order_id, load_number, starts_at, ends_at, orders(order_number)").eq("load_date", date).eq("status", "planned"),
    supabase.rpc("dispatch_shop_schedule", { p_from: date, p_to: date }),
  ]);
  const leave = await supabase.rpc("dispatch_time_off", { p_from: date, p_to: date });
  const leaveMissing = Boolean(leave.error && (leave.error.code === "PGRST202" || leave.error.code === "42883"));
  if (leave.error && !leaveMissing) throw new Error(`Could not read driver time off: ${leave.error.message}`);
  const leaveRows = (leaveMissing ? [] : (leave.data ?? [])) as Array<DriverResource["timeOff"][number] & { driver_id: string }>;
  for (const r of [trucks, drivers, quals, loads]) if (r.error) throw new Error(`Could not load dispatch resources: ${r.error.message}`);
  const shopMissing = Boolean(shop.error && (shop.error.code === "PGRST202" || shop.error.code === "42883"));
  if (shop.error && !shopMissing) throw new Error(`Could not read the shop schedule: ${shop.error.message}`);

  const loadRows = (loads.data ?? []) as unknown as Array<{ id: string; order_id: string; load_number: number; starts_at: string; ends_at: string; orders: { order_number: string } | null }>;
  const ids = loadRows.map((l) => l.id);
  const assignments = ids.length
    ? await supabase.from("dispatch_assignments").select("load_id, truck_id, trailer_id, driver_id").eq("status", "active").in("load_id", ids)
    : { data: [], error: null };
  if (assignments.error) throw new Error(`Could not load assignments: ${assignments.error.message}`);
  const byLoad = new Map(loadRows.map((l) => [l.id, l]));
  const bookings: ResourceBooking[] = ((assignments.data ?? []) as Array<{ load_id: string; truck_id: string; trailer_id: string | null; driver_id: string }>).map((a) => {
    const l = byLoad.get(a.load_id)!;
    return { ...a, order_id: l.order_id, order_number: l.orders?.order_number ?? "", load_number: l.load_number, starts_at: l.starts_at, ends_at: l.ends_at };
  }).sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  const shopRows = (shopMissing ? [] : (shop.data ?? [])) as Array<OpenWorkOrder & { truck_id: string; work_order_id: string }>;
  const open = new Map<string, OpenWorkOrder[]>();
  for (const w of shopRows) open.set(w.truck_id, [...(open.get(w.truck_id) ?? []), { ...w, id: w.work_order_id, clearance_status: null }]);

  const truckUnit = new Map(((trucks.data ?? []) as Array<{ id: string; unit_number: string }>).map((t) => [t.id, t.unit_number]));
  const names = new Map(((drivers.data ?? []) as Array<{ id: string; display_name: string }>).map((d) => [d.id, d.display_name]));
  const primary = new Map<string, string>();
  for (const d of (driverRows.data ?? []) as Array<{ id: string; primary_truck_id: string | null }>) if (d.primary_truck_id) primary.set(d.id, d.primary_truck_id);
  const holder = new Map([...primary.entries()].map(([driverId, truckId]) => [truckId, driverId]));
  const qualsBy = new Map<string, EligibilityQualification[]>();
  for (const q of (quals.data ?? []) as Array<EligibilityQualification & { driver_id: string }>) qualsBy.set(q.driver_id, [...(qualsBy.get(q.driver_id) ?? []), q]);

  const truckResources: TruckResource[] = ((trucks.data ?? []) as Array<{ id: string; unit_number: string; truck_type: string; active: boolean; service_status: "in_service" | "out_of_service"; out_of_service_reason: string; expected_return_date: string | null }>).map((t) => {
    const wos = open.get(t.id) ?? [];
    const holderId = holder.get(t.id);
    return {
      id: t.id,
      unit_number: t.unit_number,
      truck_type: t.truck_type,
      availability: vehicleAvailability(t, wos, date),
      shopToday: wos.find((w) => w.scheduled_for === date && w.status !== "awaiting_inspection") ?? null,
      bookings: bookings.filter((b) => b.truck_id === t.id),
      driver: holderId ? { id: holderId, name: names.get(holderId) ?? "Driver" } : null,
    };
  });
  const driverResources: DriverResource[] = ((drivers.data ?? []) as Array<{ id: string; display_name: string; active: boolean }>).map((d) => {
    const q = driverChecks({ active: d.active, qualifications: qualsBy.get(d.id) ?? [] }, false, date);
    const truckId = primary.get(d.id);
    const timeOff = leaveRows.filter((t) => t.driver_id === d.id);
    const mine = bookings.filter((b) => b.driver_id === d.id);
    const overlaps = (a: { starts_at: string; ends_at: string }, b: { starts_at: string; ends_at: string }) =>
      new Date(a.starts_at).getTime() < new Date(b.ends_at).getTime() && new Date(b.starts_at).getTime() < new Date(a.ends_at).getTime();
    return {
      id: d.id,
      name: d.display_name,
      qualification: { eligible: q.blockers.length === 0, blockers: q.blockers, warnings: q.warnings },
      bookings: bookings.filter((b) => b.driver_id === d.id),
      primaryTruck: truckId ? { id: truckId, unit: truckUnit.get(truckId) ?? "" } : null,
      timeOff,
      leaveConflicts: mine.filter((b) => timeOff.some((t) => t.status === "approved" && overlaps(t, b))),
    };
  });
  const unassignedLoads = loadRows.filter((l) => !bookings.some((b) => b.load_id === l.id)).length;
  return { date, today, timezone, trucks: truckResources, drivers: driverResources, unassignedLoads, maintenanceChecked: !shopMissing, timeOffChecked: !leaveMissing };
}
