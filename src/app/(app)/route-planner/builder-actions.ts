"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { can } from "@/lib/permissions";
import { suggestOrder, straightLineMatrix } from "@/lib/routing/optimize";
import { MAX_ROUTE_STOPS, hasVehicleProfile, round1, straightLineMiles, type GeocodeCandidate, type PlannedRoute, type Point, type VehicleProfile } from "@/lib/routing/route";
import { uuid } from "@/lib/schemas/common";
import { assertPermission, getAccess } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { RoutingError } from "@/server/routing/here";
import { routingStatus } from "@/server/routing/service";
import { createClient } from "@/server/supabase/server";

// Route builder (B10 core): saved locations, address search with confirmation, route calculation and saved routes.
// Places named by id are read from the database with the caller's session (row-level security), never trusted from the
// browser. Only a typed point carries its own coordinates. Nothing here assigns a load: routes are plans to look at.

const latLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

async function mayEditPlaces() {
  const access = await getAccess();
  if (!access || !(can(access, "dispatch.edit") || can(access, "settings.manage"))) throw new Error("You do not have permission to change locations.");
  return assertPermission(can(access, "dispatch.edit") ? "dispatch.edit" : "settings.manage");
}

/** Matches for an address, for a person to pick one (or none). Never saves anything. */
export async function searchAddress(input: { address: string }): Promise<ActionResult<GeocodeCandidate[]>> {
  return guard(async () => {
    const access = await assertPermission("dispatch.view");
    const address = String(input.address ?? "").trim().slice(0, 300);
    if (address.length < 4) return fail("Enter a street address, town and state.");
    const status = routingStatus(access);
    if (status.state !== "ready") return fail(`${status.reason.split(".")[0]}. Enter the coordinates instead (latitude, longitude).`);
    try {
      const found = await status.provider.geocodeCandidates(address);
      return found.length ? ok(found) : fail("No match for that address. Check it, or enter the coordinates instead.");
    } catch (e) {
      return fail(e instanceof RoutingError ? e.message : "The address search failed.");
    }
  });
}

const locationInput = z.object({
  id: uuid.optional(),
  kind: z.enum(["yard", "terminal", "quarry", "plant", "pickup", "other"]),
  name: z.string().trim().min(1, "Enter a name.").max(120),
  line1: z.string().trim().max(160).default(""),
  city: z.string().trim().max(80).default(""),
  state: z.string().trim().max(40).default(""),
  postalCode: z.string().trim().max(20).default(""),
  notes: z.string().trim().max(1000).default(""),
  point: latLng.nullable(),
  source: z.enum(["manual", "geocoded"]).nullable(),
  geocodeLabel: z.string().trim().max(300).default(""),
}).strict();

/** Adds or changes a saved location. Coordinates are the ones a person typed or a geocoder match they confirmed. */
export async function saveLocation(input: z.input<typeof locationInput>): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await mayEditPlaces();
    const p = locationInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the location.");
    const d = p.data;
    if (d.point && !d.source) return fail("Say where the coordinates came from.");
    const row = {
      kind: d.kind, name: d.name, address_line1: d.line1, city: d.city, state: d.state, postal_code: d.postalCode, notes: d.notes,
      latitude: d.point ? round6(d.point.lat) : null, longitude: d.point ? round6(d.point.lng) : null,
      location_source: d.point ? d.source : "", geocode_label: d.point && d.source === "geocoded" ? d.geocodeLabel : "",
      located_at: d.point ? new Date().toISOString() : null,
    };
    const supabase = await createClient();
    const r = d.id
      ? await supabase.from("company_locations").update(row).eq("id", d.id).select("id").maybeSingle()
      : await supabase.from("company_locations").insert(row).select("id").single();
    if (r.error) return fail(dbErrorMessage(r.error));
    if (!r.data) return fail("Location not found.");
    revalidatePath("/route-planner");
    return ok({ id: (r.data as { id: string }).id }, d.id ? "Location updated." : "Location saved.");
  });
}

export async function setLocationActive(input: { id: string; active: boolean }): Promise<ActionResult> {
  return guard(async () => {
    await mayEditPlaces();
    const id = uuid.safeParse(input.id);
    if (!id.success) return fail("Invalid location.");
    const supabase = await createClient();
    const r = await supabase.from("company_locations").update({ active: Boolean(input.active) }).eq("id", id.data).select("id");
    if (r.error) return fail(dbErrorMessage(r.error));
    if (!r.data?.length) return fail("Location not found.");
    revalidatePath("/route-planner");
    return ok(undefined, input.active ? "Location restored." : "Location archived. Saved routes that use it keep it.");
  });
}

/** Makes a saved yard the start and end of the day's truck routes. */
export async function setYardFromLocation(input: { id: string }): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("settings.manage");
    const id = uuid.safeParse(input.id);
    if (!id.success) return fail("Invalid location.");
    const supabase = await createClient();
    const { data } = await supabase.from("company_locations").select("latitude, longitude").eq("id", id.data).maybeSingle();
    const l = data as { latitude: number | null; longitude: number | null } | null;
    if (!l || l.latitude == null || l.longitude == null) return fail("This location has no coordinates yet.");
    const r = await supabase.from("company_settings").update({ yard_latitude: l.latitude, yard_longitude: l.longitude }).not("company_id", "is", null).select("company_id");
    if (r.error) return fail(dbErrorMessage(r.error));
    revalidatePath("/route-planner");
    return ok(undefined, "Daily routes now start and end at this yard.");
  });
}

const stopRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("location"), id: uuid, serviceMinutes: z.number().int().min(0).max(600).default(0) }).strict(),
  z.object({ kind: z.literal("site"), id: uuid, serviceMinutes: z.number().int().min(0).max(600).default(0) }).strict(),
  z.object({ kind: z.literal("point"), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().trim().min(1).max(160), serviceMinutes: z.number().int().min(0).max(600).default(0) }).strict(),
]);
type StopRef = z.infer<typeof stopRef>;

const planInput = z.object({
  stops: z.array(stopRef).min(2, "Add at least two places.").max(MAX_ROUTE_STOPS, `At most ${MAX_ROUTE_STOPS} places.`),
  truckId: uuid.nullable(),
  alternatives: z.boolean().default(false),
  optimize: z.boolean().default(false),
  fixedEnd: z.boolean().default(true),
}).strict();

export interface ResolvedStop {
  label: string;
  point: Point | null;
  serviceMinutes: number;
  ref: StopRef;
}

export interface PlanResult {
  stops: ResolvedStop[];
  /** Road routes from the provider (first is its choice), or null when road routing is not available. */
  routes: PlannedRoute[] | null;
  /** Why there is no road route: not set up, demo, provider failure, no route. */
  roadMissing: string | null;
  straightMiles: number[];
  straightTotal: number;
  serviceMinutes: number;
  truck: { unit: string; vehicle: VehicleProfile; profileUsed: boolean } | null;
  /** Set when the order was changed by the suggestion: the new order as indexes of the stops sent. */
  reordered: number[] | null;
}

async function resolveStops(refs: StopRef[]): Promise<ResolvedStop[] | string> {
  const supabase = await createClient();
  const locIds = refs.filter((r) => r.kind === "location").map((r) => r.id);
  const siteIds = refs.filter((r) => r.kind === "site").map((r) => r.id);
  const [locs, sites] = await Promise.all([
    locIds.length ? supabase.from("company_locations").select("id, name, latitude, longitude").in("id", locIds) : Promise.resolve({ data: [], error: null }),
    siteIds.length ? supabase.from("customer_sites").select("id, label, line1, latitude, longitude").in("id", siteIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (locs.error || sites.error) return "The places could not be read.";
  const loc = new Map(((locs.data ?? []) as Array<{ id: string; name: string; latitude: number | null; longitude: number | null }>).map((l) => [l.id, l]));
  const site = new Map(((sites.data ?? []) as Array<{ id: string; label: string; line1: string; latitude: number | null; longitude: number | null }>).map((s) => [s.id, s]));
  const out: ResolvedStop[] = [];
  for (const r of refs) {
    if (r.kind === "point") {
      out.push({ label: r.label, point: { lat: round6(r.lat), lng: round6(r.lng) }, serviceMinutes: r.serviceMinutes, ref: r });
      continue;
    }
    const row = r.kind === "location" ? loc.get(r.id) : site.get(r.id);
    if (!row) return "A place in this route is not available to you (removed, or another company's).";
    const label = "name" in row ? row.name : row.label || row.line1;
    out.push({ label, point: row.latitude != null && row.longitude != null ? { lat: Number(row.latitude), lng: Number(row.longitude) } : null, serviceMinutes: r.serviceMinutes, ref: r });
  }
  return out;
}

/**
 * Calculates a route through the places in order (optionally after a suggested order). Road distance and driving time
 * come from the truck-routing provider with the truck's recorded dimensions; without it the page gets straight-line
 * distances only and no driving time (never a guessed speed).
 */
export async function planRoute(input: z.input<typeof planInput>): Promise<ActionResult<PlanResult>> {
  return guard(async () => {
    const access = await assertPermission("dispatch.view");
    const p = planInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the route.");
    const resolved = await resolveStops(p.data.stops);
    if (typeof resolved === "string") return fail(resolved);
    const missing = resolved.filter((s) => !s.point).map((s) => s.label);
    if (missing.length) return fail(`These places have no location yet: ${missing.join(", ")}. Locate them first.`);
    let stops = resolved;
    let reordered: number[] | null = null;
    if (p.data.optimize && stops.length > 3) {
      const order = suggestOrder(stops.length, straightLineMatrix(stops.map((s) => s.point!)), p.data.fixedEnd);
      if (order.some((v, i) => v !== i)) {
        reordered = order;
        stops = order.map((i) => resolved[i]);
      }
    }
    const points = stops.map((s) => s.point!);
    const straightMiles = points.slice(1).map((pt, i) => round1(straightLineMiles(points[i], pt)));

    let truck: PlanResult["truck"] = null;
    if (p.data.truckId) {
      const supabase = await createClient();
      const t = await supabase.from("trucks").select("unit_number, height_cm, width_cm, length_cm, gross_weight_kg, axle_count").eq("id", p.data.truckId).maybeSingle();
      const row = (t.data ?? null) as Record<string, number | string | null> | null;
      if (!row) {
        const basic = await supabase.from("trucks").select("unit_number").eq("id", p.data.truckId).maybeSingle();
        if (!basic.data) return fail("Truck not found.");
        truck = { unit: String((basic.data as { unit_number: string }).unit_number), vehicle: {}, profileUsed: false };
      } else {
        const vehicle = { heightCm: row.height_cm as number | null, widthCm: row.width_cm as number | null, lengthCm: row.length_cm as number | null, grossWeightKg: row.gross_weight_kg as number | null, axleCount: row.axle_count as number | null };
        truck = { unit: String(row.unit_number), vehicle, profileUsed: hasVehicleProfile(vehicle) };
      }
    }

    let routes: PlannedRoute[] | null = null;
    let roadMissing: string | null = null;
    const status = routingStatus(access);
    if (status.state !== "ready") roadMissing = status.reason.replace(" Distances below are straight lines.", "");
    else {
      try {
        routes = await status.provider.plan(points, { vehicle: truck?.vehicle ?? null, alternatives: p.data.alternatives ? 2 : 0 });
      } catch (e) {
        roadMissing = e instanceof RoutingError ? e.message : "The routing provider failed.";
      }
    }
    return ok({
      stops,
      routes,
      roadMissing,
      straightMiles,
      straightTotal: round1(straightMiles.reduce((a, b) => a + b, 0)),
      serviceMinutes: stops.reduce((a, s) => a + s.serviceMinutes, 0),
      truck,
      reordered,
    });
  });
}

const saveRouteInput = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, "Name the route.").max(120),
  truckId: uuid.nullable(),
  notes: z.string().trim().max(1000).default(""),
  stops: z.array(stopRef).min(2, "Add at least two places.").max(MAX_ROUTE_STOPS),
}).strict();

/** Saves (or replaces the stops of) a named route. Typed points keep their coordinates; saved places keep a reference. */
export async function saveRoute(input: z.input<typeof saveRouteInput>): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const p = saveRouteInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the route.");
    const resolved = await resolveStops(p.data.stops);
    if (typeof resolved === "string") return fail(resolved);
    const supabase = await createClient();
    const head = p.data.id
      ? await supabase.from("saved_routes").update({ name: p.data.name, truck_id: p.data.truckId, notes: p.data.notes }).eq("id", p.data.id).select("id").maybeSingle()
      : await supabase.from("saved_routes").insert({ name: p.data.name, truck_id: p.data.truckId, notes: p.data.notes }).select("id").single();
    if (head.error) return fail(dbErrorMessage(head.error));
    if (!head.data) return fail("Route not found.");
    const routeId = (head.data as { id: string }).id;
    if (p.data.id) {
      const del = await supabase.from("saved_route_stops").delete().eq("route_id", routeId);
      if (del.error) return fail(dbErrorMessage(del.error));
    }
    const rows = resolved.map((s, i) => ({
      route_id: routeId,
      position: i + 1,
      company_location_id: s.ref.kind === "location" ? s.ref.id : null,
      customer_site_id: s.ref.kind === "site" ? s.ref.id : null,
      label: s.label,
      latitude: s.ref.kind === "point" ? s.point!.lat : null,
      longitude: s.ref.kind === "point" ? s.point!.lng : null,
      service_minutes: s.serviceMinutes,
    }));
    const ins = await supabase.from("saved_route_stops").insert(rows);
    if (ins.error) return fail(dbErrorMessage(ins.error));
    revalidatePath("/route-planner");
    return ok({ id: routeId }, p.data.id ? "Route updated." : "Route saved.");
  });
}

export async function archiveRoute(input: { id: string }): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const id = uuid.safeParse(input.id);
    if (!id.success) return fail("Invalid route.");
    const supabase = await createClient();
    const r = await supabase.from("saved_routes").update({ active: false }).eq("id", id.data).select("id");
    if (r.error) return fail(dbErrorMessage(r.error));
    if (!r.data?.length) return fail("Route not found.");
    revalidatePath("/route-planner");
    return ok(undefined, "Route archived.");
  });
}
