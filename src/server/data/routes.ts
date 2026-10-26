import "server-only";
import type { Point, RouteAssignment } from "@/lib/routing/route";
import { createClient } from "@/server/supabase/server";
import { getSettings } from "./settings";

// Route planner data (docs/ROUTING.md): the day's active assignments with their truck, trailer, driver and delivery
// site, and the company yard. Read through RLS like every page; nothing is written here.

export interface RouteDay {
  assignments: RouteAssignment[];
  yard: Point | null;
  /** null = the routing update (20261112000500) is not installed: locations still work, without the yard. */
  installed: boolean;
  /** Sites of the day that have no location yet. */
  unlocated: Array<{ siteId: string; label: string; address: string; customer: string }>;
}

const hhmm = (t: string) => t.slice(0, 5);

export async function getRouteDay(date: string): Promise<RouteDay> {
  const supabase = await createClient();
  const loads = await supabase.from("order_loads").select("id, order_id, load_number, start_time, end_time").eq("load_date", date).eq("status", "planned");
  if (loads.error) throw new Error(`Could not load the day's loads: ${loads.error.message}`);
  const loadRows = (loads.data ?? []) as Array<{ id: string; order_id: string; load_number: number; start_time: string; end_time: string }>;
  const settings = await getSettings();
  const s = settings as unknown as { yard_latitude?: number | string | null; yard_longitude?: number | string | null };
  const installed = "yard_latitude" in s;
  const yard = s.yard_latitude != null && s.yard_longitude != null ? { lat: Number(s.yard_latitude), lng: Number(s.yard_longitude) } : null;
  if (!loadRows.length) return { assignments: [], yard, installed, unlocated: [] };

  const [assignments, orders] = await Promise.all([
    supabase.from("dispatch_assignments").select("load_id, truck_id, trailer_id, driver_id").in("load_id", loadRows.map((l) => l.id)).eq("status", "active"),
    supabase.from("orders").select("id, order_number, customer_id, site_id, site_label, site_line1, site_city, site_state").in("id", [...new Set(loadRows.map((l) => l.order_id))]),
  ]);
  if (assignments.error) throw new Error(`Could not load assignments: ${assignments.error.message}`);
  if (orders.error) throw new Error(`Could not load orders: ${orders.error.message}`);
  const asg = (assignments.data ?? []) as Array<{ load_id: string; truck_id: string; trailer_id: string | null; driver_id: string }>;
  const ord = new Map(((orders.data ?? []) as Array<{ id: string; order_number: string; customer_id: string; site_id: string | null; site_label: string; site_line1: string; site_city: string; site_state: string }>).map((o) => [o.id, o]));

  await matchSavedSites(supabase, [...ord.values()]);
  const siteIds = [...new Set([...ord.values()].map((o) => o.site_id).filter((x): x is string => Boolean(x)))];
  const customerIds = [...new Set([...ord.values()].map((o) => o.customer_id))];
  const [sites, customers, trucks, trailers, drivers] = await Promise.all([
    siteIds.length ? supabase.from("customer_sites").select(installed ? "id, latitude, longitude, location_source" : "id, latitude, longitude").in("id", siteIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("customers").select("id, name").in("id", customerIds),
    supabase.from("trucks").select("id, unit_number").in("id", [...new Set(asg.map((a) => a.truck_id))]),
    supabase.from("trailers").select("id, unit_number").in("id", [...new Set(asg.map((a) => a.trailer_id).filter((x): x is string => Boolean(x)))]),
    supabase.from("driver_list").select("id, display_name").in("id", [...new Set(asg.map((a) => a.driver_id))]),
  ]);
  for (const r of [sites, customers, trucks, trailers, drivers]) if (r.error) throw new Error(`Could not load route details: ${r.error.message}`);
  const site = new Map(((sites.data ?? []) as unknown as Array<{ id: string; latitude: number | string | null; longitude: number | string | null; location_source?: string }>).map((x) => [x.id, x]));
  const customer = new Map(((customers.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  const truck = new Map(((trucks.data ?? []) as Array<{ id: string; unit_number: string }>).map((t) => [t.id, t.unit_number]));
  const trailer = new Map(((trailers.data ?? []) as Array<{ id: string; unit_number: string }>).map((t) => [t.id, t.unit_number]));
  const driver = new Map(((drivers.data ?? []) as Array<{ id: string; display_name: string }>).map((d) => [d.id, d.display_name]));
  const loadById = new Map(loadRows.map((l) => [l.id, l]));

  const unlocated = new Map<string, RouteDay["unlocated"][number]>();
  const out: RouteAssignment[] = [];
  for (const a of asg) {
    const l = loadById.get(a.load_id);
    const o = l ? ord.get(l.order_id) : undefined;
    if (!l || !o) continue;
    const s2 = o.site_id ? site.get(o.site_id) : undefined;
    const point = s2 && s2.latitude != null && s2.longitude != null ? { lat: Number(s2.latitude), lng: Number(s2.longitude) } : null;
    const address = [o.site_line1, o.site_city, o.site_state].filter(Boolean).join(", ");
    if (!point && o.site_id) unlocated.set(o.site_id, { siteId: o.site_id, label: o.site_label || address, address, customer: customer.get(o.customer_id) ?? "" });
    out.push({
      truckId: a.truck_id,
      unit: truck.get(a.truck_id) ?? "Truck",
      driver: driver.get(a.driver_id) ?? "Driver",
      trailer: a.trailer_id ? trailer.get(a.trailer_id) ?? null : null,
      stop: {
        loadId: l.id, orderId: o.id, orderNumber: o.order_number, loadNumber: l.load_number, customer: customer.get(o.customer_id) ?? "",
        site: o.site_label || address || "Site", address, siteId: o.site_id, start: hhmm(l.start_time), end: hhmm(l.end_time), point,
        locationSource: point ? s2?.location_source || "manual" : "",
      },
    });
  }
  return { assignments: out, yard, installed, unlocated: [...unlocated.values()] };
}

/**
 * Orders whose site was typed rather than picked have no site_id. When the customer has a saved site with exactly
 * that label, use it (its location), so routes are not missing a stop the company already located. Fills site_id in
 * place; orders without a matching saved site are left as they are.
 */
export async function matchSavedSites(supabase: Awaited<ReturnType<typeof createClient>>, orders: Array<{ customer_id: string; site_id: string | null; site_label: string }>) {
  const loose = orders.filter((o) => !o.site_id && o.site_label);
  if (!loose.length) return;
  const { data, error } = await supabase
    .from("customer_sites")
    .select("id, customer_id, label")
    .in("customer_id", [...new Set(loose.map((o) => o.customer_id))])
    .in("label", [...new Set(loose.map((o) => o.site_label))]);
  if (error) return;
  const byKey = new Map<string, string[]>();
  for (const r of (data ?? []) as Array<{ id: string; customer_id: string; label: string }>) {
    const k = `${r.customer_id}|${r.label}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r.id]);
  }
  for (const o of loose) {
    const ids = byKey.get(`${o.customer_id}|${o.site_label}`);
    if (ids?.length === 1) o.site_id = ids[0];
  }
}
