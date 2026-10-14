import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Point } from "@/lib/routing/route";

// Sample locations for the Route Planner in demo companies (owner 2026-10-14). Prairie Lantern's towns are real places
// used only as locations: points are near each town's centre, not real businesses. Northfield's towns are fictional,
// so are their points. Idempotent and additive: the yard is set only when empty and a site only when it has no
// location, so a prospect's own changes are kept. Refuses non-demo companies.

type Db = SupabaseClient;

export const PRAIRIE_LANTERN_LOCATIONS = {
  yard: { lat: 40.9312, lng: -87.1471 },
  sites: {
    "Elevator receiving dock": { lat: 40.9402, lng: -87.1562 },
    "Main warehouse, door 3": { lat: 40.7606, lng: -87.1506 },
    "Plant 2 shipping yard": { lat: 40.4241, lng: -86.8402 },
    "Lumber yard, north gate": { lat: 41.1950, lng: -87.1989 },
    "Equipment shop": { lat: 40.7453, lng: -86.7647 },
    "Seed warehouse": { lat: 40.6167, lng: -87.3206 },
    "Builders yard": { lat: 40.7703, lng: -87.4453 },
    "Parts depot": { lat: 40.5875, lng: -86.6750 },
    "Receiving, dock 6": { lat: 42.4734, lng: -83.2219 },
    "Nursery yard, gate B": { lat: 27.3364, lng: -82.5307 },
    "Court shop, bay 2": { lat: 40.4167, lng: -86.8753 },
  } as Record<string, Point>,
};

export const NORTHFIELD_LOCATIONS = {
  yard: { lat: 40.1200, lng: -88.9500 },
  sites: {
    "Cedar Ridge phase 3, lot 14–22": { lat: 40.1384, lng: -88.9302 },
    "County Rd 9 widening": { lat: 40.2012, lng: -89.0487 },
    "Brightwater office park": { lat: 40.0519, lng: -88.8013 },
    "Water main replacement, 4th St": { lat: 40.1123, lng: -88.9611 },
    "Harlow Meadows model homes": { lat: 40.2186, lng: -89.0712 },
    "Township salt dome pad": { lat: 40.2531, lng: -88.8524 },
    "Summit batch plant stockpile": { lat: 40.0402, lng: -88.8236 },
    "Oakmont Elementary parking lot": { lat: 40.1291, lng: -88.9433 },
  } as Record<string, Point>,
};

/** Fills the demo's empty yard and site locations; returns how many were added. 0 before migration 20261112000500 (yard) is fine. */
export async function ensureDemoLocations(db: Db, locations: { yard: Point; sites: Record<string, Point> }): Promise<number> {
  const { data: access } = await db.rpc("my_access");
  const companyId = (access as { company_id?: string } | null)?.company_id;
  const { data: company } = companyId ? await db.from("companies").select("is_demo").eq("id", companyId).maybeSingle() : { data: null };
  if (!(company as { is_demo?: boolean } | null)?.is_demo) throw new Error("Demo locations are only added to demo companies.");
  let added = 0;

  const settings = await db.from("company_settings").select("yard_latitude").maybeSingle();
  if (!settings.error && (settings.data as { yard_latitude: unknown } | null)?.yard_latitude == null) {
    const r = await db.from("company_settings").update({ yard_latitude: locations.yard.lat, yard_longitude: locations.yard.lng }).not("company_id", "is", null).select("company_id");
    if (!r.error) added++;
  }

  const sites = await db.from("customer_sites").select("id, label").is("latitude", null);
  if (sites.error) return added;
  for (const s of (sites.data ?? []) as Array<{ id: string; label: string }>) {
    const p = locations.sites[s.label];
    if (!p) continue;
    const withSource = await db.from("customer_sites").update({ latitude: p.lat, longitude: p.lng, location_source: "manual", located_at: new Date().toISOString() }).eq("id", s.id).select("id");
    if (withSource.error) await db.from("customer_sites").update({ latitude: p.lat, longitude: p.lng }).eq("id", s.id);
    added++;
  }
  return added;
}
