import "server-only";
import { buildRoutes, legStart, straightLineMiles, YARD, type Point, type RouteNotice } from "@/lib/routing/route";
import { getRouteDay, matchSavedSites } from "@/server/data/routes";
import { createClient } from "@/server/supabase/server";
import type { RoutingStatus } from "@/server/routing/service";

// The route panel on Dispatch (owner 2026-10-26: Dispatch and the Route Planner on one page; clicking an order shows
// its suggested route). Read with the person's own session (RLS). Distances are the provider's road estimates when
// HERE is configured, otherwise straight lines labelled as such. Nothing here assigns or changes a load.

export interface RouteLine {
  /** Stop labels in driving order, the first being the start. */
  stops: Array<{ label: string; point: Point | null; start?: string; end?: string; thisOrder?: boolean }>;
  /** Road line for the map (empty without the provider). */
  line: Point[];
  miles: number | null;
  minutes: number | null;
  /** "road" (HERE truck routing) or "straight" (estimate). */
  basis: "road" | "straight" | "none";
  notices: string[];
  missing: string | null;
}

export interface OrderRoute {
  orderNumber: string;
  customer: string;
  site: string;
  address: string;
  sitePoint: Point | null;
  yard: Point | null;
  /**
   * Each of the day's loads of this order, in time order, with its suggested drive to the site: from the yard for the
   * truck's first load of the day, otherwise from where its previous delivery left it. Open loads start at the yard
   * until a truck is assigned.
   */
  loads: Array<{ loadId: string; loadNumber: number; start: string; end: string; truck: string | null; driver: string | null; from: "base" | "previous" | "open"; route: RouteLine }>;
  /** The day of each truck already carrying a load of this order, with this order's stops marked. */
  trucks: Array<{ unit: string; driver: string; route: RouteLine }>;
  openLoads: number;
  assignedLoads: number;
  routing: { ready: boolean; reason: string | null };
}

const noticeText = (n: RouteNotice) => n.text;

async function lineFor(points: Array<Point | null>, status: RoutingStatus): Promise<Pick<RouteLine, "line" | "miles" | "minutes" | "basis" | "notices" | "missing">> {
  const located = points.filter((p): p is Point => Boolean(p));
  if (located.length < 2 || located.length !== points.length) {
    return { line: [], miles: null, minutes: null, basis: "none", notices: [], missing: "A location is missing, so this route has no distance yet." };
  }
  if (status.state === "ready") {
    try {
      const [plan] = await status.provider.plan(located, {});
      if (plan) return { line: plan.line, miles: Math.round(plan.miles * 10) / 10, minutes: Math.round(plan.minutes), basis: "road", notices: plan.notices.map(noticeText), missing: null };
    } catch {
      // Fall back to straight lines below; the reason is shown.
    }
  }
  let miles = 0;
  for (let i = 1; i < located.length; i++) miles += straightLineMiles(located[i - 1], located[i]);
  return { line: [], miles: Math.round(miles * 10) / 10, minutes: null, basis: "straight", notices: [], missing: status.state === "ready" ? "Road routing did not answer; straight-line distance shown." : null };
}

export async function getOrderRoute(orderId: string, date: string, status: RoutingStatus): Promise<OrderRoute | null> {
  const supabase = await createClient();
  const { data: o } = await supabase.from("orders").select("id, order_number, customer_id, site_id, site_label, site_line1, site_city, site_state").eq("id", orderId).maybeSingle();
  if (!o) return null;
  const order = o as { id: string; order_number: string; customer_id: string; site_id: string | null; site_label: string; site_line1: string; site_city: string; site_state: string };
  await matchSavedSites(supabase, [order]);
  const [customer, site, loads, day] = await Promise.all([
    supabase.from("customers").select("name").eq("id", order.customer_id).maybeSingle(),
    order.site_id ? supabase.from("customer_sites").select("latitude, longitude").eq("id", order.site_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("order_loads").select("id, load_number, start_time, end_time").eq("order_id", orderId).eq("load_date", date).eq("status", "planned").order("start_time").order("load_number"),
    getRouteDay(date),
  ]);
  const s = site.data as { latitude: number | string | null; longitude: number | string | null } | null;
  const sitePoint = s && s.latitude != null && s.longitude != null ? { lat: Number(s.latitude), lng: Number(s.longitude) } : null;
  const address = [order.site_line1, order.site_city, order.site_state].filter(Boolean).join(", ");
  const siteLabel = order.site_label || address || "Job site";
  const dayLoads = (loads.data ?? []) as Array<{ id: string; load_number: number; start_time: string; end_time: string }>;
  const mine = day.assignments.filter((a) => a.stop.orderId === orderId);
  const truckIds = [...new Set(mine.map((a) => a.truckId))].slice(0, 3);
  const siteStop = { label: siteLabel, point: sitePoint, thisOrder: true };

  const loadLegs: OrderRoute["loads"] = await Promise.all(
    dayLoads.map(async (l) => {
      const start = l.start_time.slice(0, 5);
      const end = l.end_time.slice(0, 5);
      const a = mine.find((x) => x.stop.loadId === l.id);
      const from = a ? legStart(day.assignments, a.truckId, { loadId: l.id, start, loadNumber: l.load_number }, day.yard) : { kind: "open" as const, label: YARD, point: day.yard };
      const stops = [{ label: from.label, point: from.point }, { ...siteStop, start, end }];
      const line = !from.point && from.label === YARD
        ? { line: [], miles: null, minutes: null, basis: "none" as const, notices: [], missing: "The yard location is not set, so routes have no starting point." }
        : await lineFor(stops.map((x) => x.point), status);
      return { loadId: l.id, loadNumber: l.load_number, start, end, truck: a?.unit ?? null, driver: a?.driver ?? null, from: from.kind, route: { stops, ...line } };
    }),
  );

  const routes = buildRoutes(day.assignments.filter((a) => truckIds.includes(a.truckId)), day.yard);
  const trucks = await Promise.all(
    routes.map(async (r) => {
      const stops = [
        ...(day.yard ? [{ label: YARD, point: day.yard as Point | null }] : []),
        ...r.stops.map((st) => ({ label: `${st.orderNumber} · ${st.site}`, point: st.point, start: st.start, end: st.end, thisOrder: st.orderId === orderId })),
        ...(day.yard ? [{ label: YARD, point: day.yard as Point | null }] : []),
      ];
      return { unit: r.unit, driver: r.driver, route: { stops, ...(await lineFor(stops.map((x) => x.point), status)) } };
    }),
  );

  return {
    orderNumber: order.order_number,
    customer: ((customer.data as { name: string } | null)?.name) ?? "",
    site: siteLabel,
    address,
    sitePoint,
    yard: day.yard,
    loads: loadLegs,
    trucks,
    openLoads: dayLoads.filter((l) => !mine.some((a) => a.stop.loadId === l.id)).length,
    assignedLoads: mine.length,
    routing: { ready: status.state === "ready", reason: status.state === "ready" ? null : status.reason },
  };
}
