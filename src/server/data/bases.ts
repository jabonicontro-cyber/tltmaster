import "server-only";
import { createClient } from "@/server/supabase/server";

// Dispatch bases (migrations 20261120000100 and 000200). Every reader handles a database without them: the page then
// says it needs a database update instead of failing.

export type DispatchBase = {
  id: string;
  code: string;
  name: string;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
  timezone: string;
  contact_name: string;
  contact_phone: string;
  active: boolean;
  is_default: boolean;
};

export type BaseSummary = { id: string; trucks: number; trucks_available: number; drivers: number; orders: number; loads: number; ordered_cents: number };

const NOT_INSTALLED = new Set(["42P01", "PGRST205", "PGRST202", "42703", "PGRST204"]);
export const notInstalled = (e: { code?: string } | null | undefined) => !!e && NOT_INSTALLED.has(e.code ?? "");

/** The company's bases (default first), or null when the database has no bases yet. */
export async function listBases(): Promise<DispatchBase[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("dispatch_bases").select("id, code, name, address_line1, city, state, postal_code, timezone, contact_name, contact_phone, active, is_default").order("is_default", { ascending: false }).order("code");
  if (error) {
    if (notInstalled(error)) return null;
    throw error;
  }
  return (data ?? []) as DispatchBase[];
}

/** Active bases only, for pickers and filters. Empty when bases are not installed. */
export async function activeBases(): Promise<DispatchBase[]> {
  return ((await listBases()) ?? []).filter((b) => b.active);
}

/** {limit: null = no limit} from the plan, and how many bases are active. */
export async function baseAllowance(): Promise<{ limit: number | null; active: number } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dispatch_base_allowance");
  if (error) return null;
  return (data as { limit: number | null; active: number } | null) ?? null;
}

/** Per-base counts for a date range; each record belongs to exactly one base, so the rows add up to the company total. */
export async function baseSummary(from: string, to: string): Promise<BaseSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dispatch_base_summary", { p_from: from, p_to: to });
  if (error) return [];
  return (data ?? []) as BaseSummary[];
}

/** Which bases each restricted person is limited to (users.manage reads everyone; others only themselves). */
export async function baseMembers(): Promise<Map<string, string[]> | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("base_members").select("user_id, base_id");
  if (error) return notInstalled(error) ? null : new Map();
  const out = new Map<string, string[]>();
  for (const r of (data ?? []) as Array<{ user_id: string; base_id: string }>) out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.base_id]);
  return out;
}

/** US time zones offered for a base (the stored value is always shown, even if it is not in this list). */
export const BASE_TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];

/** Active bases as picker options. */
export async function baseOptions(): Promise<Array<{ id: string; name: string; code: string }>> {
  return (await activeBases()).map((b) => ({ id: b.id, name: b.name, code: b.code }));
}

/** The base of one truck, trailer, driver or order (null before the bases migration or when unset). */
export async function recordBase(table: "trucks" | "trailers" | "drivers" | "orders", id: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from(table).select("base_id").eq("id", id).maybeSingle();
  if (error) return null;
  return (data as { base_id: string | null } | null)?.base_id ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A ?base= filter value, only if it is a well-formed id (RLS still decides what the person can see). */
export const parseBaseFilter = (v: string | undefined) => (v && UUID.test(v) ? v : null);


/**
 * What Smart Dispatch needs to respect bases: base names, the cross-base setting, and the base of each truck, driver
 * and order. Null when the company has fewer than two active bases or the bases update is not installed — then
 * dispatch works exactly as before.
 */
export async function dispatchBaseContext(orderIds: string[]): Promise<{ crossBase: boolean; names: Record<string, string>; truck: Map<string, string>; driver: Map<string, string>; order: Map<string, string> } | null> {
  const bases = await activeBases();
  if (bases.length < 2) return null;
  const supabase = await createClient();
  const [settings, trucks, drivers, orders] = await Promise.all([
    supabase.from("company_settings").select("cross_base_dispatch").maybeSingle(),
    supabase.from("trucks").select("id, base_id").eq("active", true),
    supabase.from("drivers").select("id, base_id").eq("active", true),
    orderIds.length ? supabase.from("orders").select("id, base_id").in("id", orderIds.slice(0, 300)) : Promise.resolve({ data: [], error: null }),
  ]);
  if (trucks.error || drivers.error || orders.error) return null;
  const map = (rows: unknown) => new Map(((rows ?? []) as Array<{ id: string; base_id: string | null }>).filter((r) => r.base_id).map((r) => [r.id, r.base_id as string]));
  return {
    crossBase: Boolean((settings.data as { cross_base_dispatch?: boolean } | null)?.cross_base_dispatch),
    names: Object.fromEntries((await listBases() ?? []).map((b) => [b.id, b.name])),
    truck: map(trucks.data),
    driver: map(drivers.data),
    order: map(orders.data),
  };
}
