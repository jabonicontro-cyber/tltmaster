import "server-only";
import type { HaulerDoc, PayTicket, RateUnit } from "@/lib/hired-trucks";
import { createClient } from "@/server/supabase/server";

// Hired trucks (B83), read with the person's own session: RLS limits everything to their company (dispatch or fleet
// access), and a hired driver sees only the offers made to them.

const MISSING = new Set(["42P01", "PGRST202", "PGRST205", "42703", "42883"]);

export interface Hauler {
  id: string;
  name: string;
  contact_name: string;
  phone: string;
  email: string;
  notes: string;
  active: boolean;
  trucks: Array<{ id: string; unit_number: string; truck_type: string }>;
  drivers: Array<{ id: string; name: string; phone: string; linked: boolean }>;
  docs: Array<HaulerDoc & { id: string; reference: string }>;
}

export interface Offer {
  id: string;
  load_id: string;
  hauler_id: string;
  truck_id: string;
  driver_id: string;
  rate_cents: number;
  rate_unit: RateUnit;
  note: string;
  status: string;
  offered_at: string;
  responded_at: string | null;
  response_note: string;
  by_phone: boolean;
  assignment_id: string | null;
  load: { load_number: number; load_date: string; start_time: string; end_time: string; order_number: string; site: string; planned: string };
}

export interface OpenLoad {
  id: string;
  label: string;
}

/** null when the update is not installed; `enabled` false when the add-on is off for this company. */
export async function loadHiredTrucks(today: string, horizonDays = 14): Promise<{ enabled: boolean; haulers: Hauler[]; offers: Offer[]; openLoads: OpenLoad[]; pay: Map<string, PayTicket[]> } | null> {
  const supabase = await createClient();
  const on = await supabase.rpc("hired_trucks_enabled");
  if (on.error) {
    if (MISSING.has(on.error.code ?? "")) return null;
    throw new Error(`Could not check hired trucks: ${on.error.message}`);
  }
  if (!on.data) return { enabled: false, haulers: [], offers: [], openLoads: [], pay: new Map() };
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + horizonDays * 86_400_000).toISOString().slice(0, 10);
  const [haulers, docs, trucks, drivers, offers, loads] = await Promise.all([
    supabase.from("haulers").select("id, name, contact_name, phone, email, notes, active").order("name"),
    supabase.from("hauler_documents").select("id, hauler_id, truck_id, kind, reference, expires_on, recorded_at").order("recorded_at", { ascending: false }),
    supabase.from("trucks").select("id, unit_number, truck_type, hauler_id").not("hauler_id", "is", null).eq("active", true).order("unit_number"),
    supabase.from("drivers").select("id, name, phone, user_id, hauler_id").not("hauler_id", "is", null).eq("active", true).order("name"),
    supabase.from("hauler_offers").select("id, load_id, hauler_id, truck_id, driver_id, rate_cents, rate_unit, note, status, offered_at, responded_at, response_note, by_phone, assignment_id").order("offered_at", { ascending: false }).limit(200),
    supabase.from("order_loads").select("id, load_number, load_date, start_time, end_time, planned_quantity, unit_code, status, order:orders(order_number, site_label, site_city)").gte("load_date", today).lte("load_date", until).neq("status", "canceled").order("load_date").order("start_time").limit(300),
  ]);
  for (const r of [haulers, docs, trucks, drivers, offers, loads]) if (r.error) throw new Error(`Could not load hired trucks: ${r.error.message}`);

  type LoadRow = { id: string; load_number: number; load_date: string; start_time: string; end_time: string; planned_quantity: number | null; unit_code: string | null; status: string; order: { order_number: string; site_label: string | null; site_city: string | null } | null };
  const loadRows = (loads.data ?? []) as unknown as LoadRow[];
  const offerRows = (offers.data ?? []) as Array<Omit<Offer, "load">>;
  // Loads of offers outside the horizon (older confirmed ones) are fetched too, for labels and pay.
  const missingIds = offerRows.map((o) => o.load_id).filter((id) => !loadRows.some((l) => l.id === id));
  if (missingIds.length) {
    const more = await supabase.from("order_loads").select("id, load_number, load_date, start_time, end_time, planned_quantity, unit_code, status, order:orders(order_number, site_label, site_city)").in("id", missingIds);
    loadRows.push(...((more.data ?? []) as unknown as LoadRow[]));
  }
  const loadById = new Map(loadRows.map((l) => [l.id, l]));
  const describe = (l: LoadRow | undefined) => ({
    load_number: l?.load_number ?? 0,
    load_date: l?.load_date ?? "",
    start_time: l?.start_time ?? "",
    end_time: l?.end_time ?? "",
    order_number: l?.order?.order_number ?? "Order",
    site: [l?.order?.site_label, l?.order?.site_city].filter(Boolean).join(", "),
    planned: l?.planned_quantity ? `${Number(l.planned_quantity)} ${l.unit_code ?? ""}`.trim() : "",
  });

  // Open loads: no active assignment and no open offer.
  const ids = loadRows.map((l) => l.id);
  const assigned = ids.length ? await supabase.from("dispatch_assignments").select("load_id").in("load_id", ids).eq("status", "active") : { data: [] };
  const taken = new Set([...((assigned.data ?? []) as Array<{ load_id: string }>).map((a) => a.load_id), ...offerRows.filter((o) => o.status === "offered" || o.status === "accepted").map((o) => o.load_id)]);
  const openLoads = loadRows
    .filter((l) => l.load_date >= today && !taken.has(l.id))
    .map((l) => {
      const d = describe(l);
      return { id: l.id, label: `${d.load_date} ${d.start_time.slice(0, 5)} · ${d.order_number} load ${d.load_number}${d.site ? ` · ${d.site}` : ""}${d.planned ? ` · ${d.planned}` : ""}` };
    });

  // Pay: accepted tickets of confirmed offers' assignments.
  const assignmentIds = offerRows.filter((o) => o.status === "confirmed" && o.assignment_id).map((o) => o.assignment_id!);
  const pay = new Map<string, PayTicket[]>();
  if (assignmentIds.length) {
    const tickets = await supabase.from("delivery_tickets").select("assignment_id, quantity, unit_code").in("assignment_id", assignmentIds).eq("status", "accepted");
    for (const t of (tickets.data ?? []) as Array<{ assignment_id: string; quantity: number | string; unit_code: string }>) {
      pay.set(t.assignment_id, [...(pay.get(t.assignment_id) ?? []), { quantity: Number(t.quantity), unit_code: t.unit_code }]);
    }
  }

  const docRows = (docs.data ?? []) as Array<HaulerDoc & { id: string; hauler_id: string; reference: string }>;
  const truckRows = (trucks.data ?? []) as Array<{ id: string; unit_number: string; truck_type: string; hauler_id: string }>;
  const driverRows = (drivers.data ?? []) as Array<{ id: string; name: string; phone: string; user_id: string | null; hauler_id: string }>;
  return {
    enabled: true,
    haulers: ((haulers.data ?? []) as Array<Omit<Hauler, "trucks" | "drivers" | "docs">>).map((h) => ({
      ...h,
      trucks: truckRows.filter((t) => t.hauler_id === h.id).map(({ id, unit_number, truck_type }) => ({ id, unit_number, truck_type })),
      drivers: driverRows.filter((d) => d.hauler_id === h.id).map((d) => ({ id: d.id, name: d.name, phone: d.phone, linked: Boolean(d.user_id) })),
      docs: docRows.filter((d) => d.hauler_id === h.id),
    })),
    offers: offerRows.map((o) => ({ ...o, load: describe(loadById.get(o.load_id)) })),
    openLoads,
    pay,
  };
}

export interface MyOffer {
  id: string;
  status: string;
  rate_cents: number;
  rate_unit: RateUnit;
  note: string;
  load_number: number;
  load_date: string;
  start_time: string;
  end_time: string;
  planned_quantity: number | null;
  unit_code: string | null;
  order_number: string;
  site: string;
  truck: string;
}

/** Offers made to the signed-in hired driver (the database returns only theirs), newest first. Empty when none. */
export async function myOffers(): Promise<MyOffer[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_hauler_offers");
  if (error) return [];
  return (data ?? []) as MyOffer[];
}

/**
 * Hired trucks and drivers (hauler_id set): kept out of Plan the day, Smart Dispatch and the board's free lists, since
 * they are assigned only through a confirmed offer. Empty when the hired trucks update is not installed.
 */
export async function hiredIds(): Promise<{ trucks: Set<string>; drivers: Set<string> }> {
  const supabase = await createClient();
  const [t, d] = await Promise.all([
    supabase.from("trucks").select("id").not("hauler_id", "is", null),
    supabase.from("drivers").select("id").not("hauler_id", "is", null),
  ]);
  return {
    trucks: new Set(t.error ? [] : ((t.data ?? []) as Array<{ id: string }>).map((r) => r.id)),
    drivers: new Set(d.error ? [] : ((d.data ?? []) as Array<{ id: string }>).map((r) => r.id)),
  };
}
