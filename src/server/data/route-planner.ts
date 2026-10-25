import "server-only";
import type { Point } from "@/lib/routing/route";
import type { CompanyLocation, LocationKind, SavedRoute, SiteOption, TruckOption } from "@/lib/routing/locations";
import { createClient } from "@/server/supabase/server";

// Route builder data (B10, migration 20261120002600): saved company locations, customer sites with coordinates, trucks
// with their routing dimensions and saved routes. Read through the caller's session (RLS); failures before the
// migration is applied read as "not installed", never as empty data.

export { LOCATION_KINDS } from "@/lib/routing/locations";
export type { CompanyLocation, LocationKind, SavedRoute, SiteOption, TruckOption } from "@/lib/routing/locations";

const MISSING = new Set(["42P01", "PGRST205", "42703", "PGRST204"]);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const pt = (lat: unknown, lng: unknown): Point | null => (num(lat) !== null && num(lng) !== null ? { lat: Number(lat), lng: Number(lng) } : null);

export async function listLocations(opts: { includeInactive?: boolean } = {}): Promise<{ installed: boolean; locations: CompanyLocation[] }> {
  const supabase = await createClient();
  let q = supabase.from("company_locations").select("id, kind, name, address_line1, city, state, postal_code, latitude, longitude, location_source, geocode_label, notes, active").order("kind").order("name");
  if (!opts.includeInactive) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) {
    if (MISSING.has(error.code ?? "")) return { installed: false, locations: [] };
    throw new Error(`Could not load locations: ${error.message}`);
  }
  return {
    installed: true,
    locations: ((data ?? []) as Array<Record<string, string | number | boolean | null>>).map((r) => ({
      id: String(r.id),
      kind: r.kind as LocationKind,
      name: String(r.name),
      address: [r.address_line1, r.city, r.state, r.postal_code].filter(Boolean).join(", "),
      addressParts: { line1: String(r.address_line1 ?? ""), city: String(r.city ?? ""), state: String(r.state ?? ""), postalCode: String(r.postal_code ?? "") },
      point: pt(r.latitude, r.longitude),
      source: (r.location_source ?? "") as CompanyLocation["source"],
      geocodeLabel: String(r.geocode_label ?? ""),
      notes: String(r.notes ?? ""),
      active: Boolean(r.active),
    })),
  };
}

export async function listSiteOptions(): Promise<SiteOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("customer_sites").select("id, label, line1, city, state, latitude, longitude, customers(name)").eq("active", true).order("label").limit(500);
  if (error) return [];
  return ((data ?? []) as unknown as Array<{ id: string; label: string; line1: string; city: string | null; state: string | null; latitude: unknown; longitude: unknown; customers: { name: string } | null }>).map((s) => ({
    id: s.id,
    label: s.label || s.line1,
    customer: s.customers?.name ?? "",
    address: [s.line1, s.city, s.state].filter(Boolean).join(", "),
    point: pt(s.latitude, s.longitude),
  }));
}

export async function listTruckOptions(): Promise<{ trucks: TruckOption[]; dimensionsInstalled: boolean }> {
  const supabase = await createClient();
  const full = await supabase.from("trucks").select("id, unit_number, height_cm, width_cm, length_cm, gross_weight_kg, axle_count").eq("active", true).order("unit_number");
  if (full.error && MISSING.has(full.error.code ?? "")) {
    const basic = await supabase.from("trucks").select("id, unit_number").eq("active", true).order("unit_number");
    return { trucks: ((basic.data ?? []) as Array<{ id: string; unit_number: string }>).map((t) => ({ id: t.id, unit: t.unit_number, vehicle: {} })), dimensionsInstalled: false };
  }
  return {
    dimensionsInstalled: true,
    trucks: ((full.data ?? []) as Array<Record<string, string | number | null>>).map((t) => ({
      id: String(t.id),
      unit: String(t.unit_number),
      vehicle: { heightCm: num(t.height_cm), widthCm: num(t.width_cm), lengthCm: num(t.length_cm), grossWeightKg: num(t.gross_weight_kg), axleCount: num(t.axle_count) },
    })),
  };
}

/** Whether trucks have routing dimension columns yet (20261120002600). */
export async function truckDimensionsInstalled(): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.from("trucks").select("height_cm").limit(1);
  return !(error && MISSING.has(error.code ?? ""));
}

export async function listSavedRoutes(): Promise<SavedRoute[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("saved_routes")
    .select("id, name, truck_id, notes, updated_at, saved_route_stops(position, company_location_id, customer_site_id, label, latitude, longitude, service_minutes)")
    .eq("active", true)
    .order("name");
  if (error) return [];
  return ((data ?? []) as unknown as Array<{ id: string; name: string; truck_id: string | null; notes: string; updated_at: string; saved_route_stops: Array<{ position: number; company_location_id: string | null; customer_site_id: string | null; label: string; latitude: unknown; longitude: unknown; service_minutes: number }> }>).map((r) => ({
    id: r.id,
    name: r.name,
    truckId: r.truck_id,
    notes: r.notes,
    updatedAt: r.updated_at,
    stops: [...r.saved_route_stops].sort((a, b) => a.position - b.position).map((s) => ({
      kind: s.company_location_id ? "location" as const : s.customer_site_id ? "site" as const : "point" as const,
      id: s.company_location_id ?? s.customer_site_id,
      label: s.label,
      point: pt(s.latitude, s.longitude),
      serviceMinutes: s.service_minutes,
    })),
  }));
}
