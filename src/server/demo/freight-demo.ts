import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, todayIn } from "@/lib/dates";
import { demoAssign } from "./assign";
import { ensureDemoLocations } from "./locations";
import { seedCommunicationSamples } from "./prairie-lantern";
import { ensureFeatureSamples } from "./samples";

/**
 * "Cobalt Plains Freight" (MK3, owner 2026-11-05: a separate freight demo company beside the aggregate demos): a
 * fictional regional dry-van and flatbed carrier in Valparaiso, Indiana. Same application, pages, functions and
 * row-level security as every company; it differs only by its data and its What you haul = General freight, so its
 * menu, pages and drivers say bills of lading, and every load has shipper-to-receiver stops.
 *
 * Everything is invented: the company, people, shippers, receivers, street addresses, phone numbers (555-01xx),
 * rates, miles and references. Town names are real places, used only as locations. No VIN, plate, DOT or MC number.
 *
 * The seed sets up the company (settings, charges, customers, fleet, people, shop) and then runs the same Refresh that
 * keeps it current (recent weekdays delivered, today in progress, tomorrow planned), so the two never disagree.
 * Refresh is additive only: it fills empty days and re-adds missing sample records, never changes or deletes anything.
 */
type Db = SupabaseClient;

async function must<T>(label: string, p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`Freight demo failed at "${label}": ${error.message}`);
  return data;
}

async function installed(db: Db, table: string) {
  return !(await db.from(table).select("id").limit(1)).error;
}

export const FREIGHT_DEMO = { name: "Cobalt Plains Freight", city: "Valparaiso", state: "IN", timeZone: "America/Chicago" };

type Place = { name: string; line1: string; city: string; state: string; zip: string };
const P = {
  halcyon: { name: "Halcyon Paper Products", line1: "2400 Halcyon Way", city: "Kalamazoo", state: "MI", zip: "49001" },
  juniper: { name: "Juniper Home Goods DC", line1: "55 Juniper Commerce Dr", city: "Joliet", state: "IL", zip: "60436" },
  ridgecrest: { name: "Ridgecrest Steel Service", line1: "900 Ridgecrest Ave", city: "Gary", state: "IN", zip: "46406" },
  bluefield: { name: "Bluefield Appliance Distribution", line1: "7100 Bluefield Rd", city: "Fort Wayne", state: "IN", zip: "46809" },
  sandpiper: { name: "Sandpiper Beverage Co.", line1: "320 Sandpiper Ln", city: "Toledo", state: "OH", zip: "43615" },
  tamarack: { name: "Tamarack Foods", line1: "18 Tamarack Pkwy", city: "Peoria", state: "IL", zip: "61615" },
  marrow: { name: "Marrow Creek Building Products", line1: "4400 Marrow Creek Blvd", city: "Indianapolis", state: "IN", zip: "46241" },
  orchard: { name: "Orchard Lane Hardware", line1: "12 Orchard Ln", city: "Lafayette", state: "IN", zip: "47905" },
  kessler: { name: "Kessler Bay Supply", line1: "600 Bay St", city: "Michigan City", state: "IN", zip: "46360" },
} satisfies Record<string, Place>;

/** Customers who pay for loads (shippers and one broker), each with its own dock as a site. */
export const FREIGHT_CUSTOMERS = [
  { name: "Halcyon Paper Products", site: "Shipping dock 2", place: P.halcyon, terms: "Net 30" },
  { name: "Ridgecrest Steel Service", site: "Coil yard, bay 4", place: P.ridgecrest, terms: "Net 30" },
  { name: "Juniper Home Goods", site: "Distribution center, door 14", place: P.juniper, terms: "Net 45" },
  { name: "Bluefield Appliance Distribution", site: "Receiving, door 7", place: P.bluefield, terms: "Net 30" },
  { name: "Sandpiper Beverage Co.", site: "Warehouse B", place: P.sandpiper, terms: "Net 30" },
  { name: "Marrow Creek Building Products", site: "Yard 3 pickup", place: P.marrow, terms: "Net 30" },
  { name: "Larkspur Logistics (broker)", site: "Broker office", place: { name: "Larkspur Logistics", line1: "8 Lincolnway", city: "Valparaiso", state: "IN", zip: "46383" }, terms: "Quick pay, 7 days" },
];

/** Lanes: who pays, where the truck loads and delivers, and how the load is priced. */
type Lane = { payer: number; project: string; stops: Array<{ kind: "pickup" | "delivery"; place: Place; ref: string; note: string }>; miles: number; perMile?: number; flat?: number; trailer: "van" | "flatbed"; note: string };
export const FREIGHT_LANES: Lane[] = [
  { payer: 0, project: "Paper rolls, Kalamazoo to Joliet", miles: 142, perMile: 285, trailer: "van", note: "Rolls ship on their sides; no stacking.",
    stops: [{ kind: "pickup", place: P.halcyon, ref: "PU", note: "Pre-staged at dock 2. Count rolls before you sign." }, { kind: "delivery", place: P.juniper, ref: "PO", note: "Door 14. Appointment required." }] },
  { payer: 1, project: "Steel coils, Gary to Fort Wayne", miles: 141, flat: 64000, trailer: "flatbed", note: "Chains and coil racks; tarp in rain.",
    stops: [{ kind: "pickup", place: P.ridgecrest, ref: "PU", note: "Coil yard, bay 4. Hard hat and vest." }, { kind: "delivery", place: P.bluefield, ref: "PO", note: "Receiving, door 7." }] },
  { payer: 6, project: "Beverage, Toledo to Peoria (broker load)", miles: 330, flat: 115000, trailer: "van", note: "Broker load: rate confirmation on file.",
    stops: [{ kind: "pickup", place: P.sandpiper, ref: "PU", note: "Warehouse B. Seal the trailer and note the seal number." }, { kind: "delivery", place: P.tamarack, ref: "BOL", note: "Lumper at receiving; get a receipt." }] },
  { payer: 5, project: "Building products, two drops", miles: 228, perMile: 260, trailer: "flatbed", note: "Two drops: Lafayette first, then Michigan City.",
    stops: [{ kind: "pickup", place: P.marrow, ref: "PU", note: "Yard 3. Forklift loading." }, { kind: "delivery", place: P.orchard, ref: "PO", note: "Half the load." }, { kind: "delivery", place: P.kessler, ref: "PO", note: "Rest of the load. Call 30 minutes out." }] },
  { payer: 2, project: "Home goods, Joliet to Lafayette", miles: 145, flat: 78000, trailer: "van", note: "Floor-loaded cartons.",
    stops: [{ kind: "pickup", place: P.juniper, ref: "PU", note: "Door 14. Live load." }, { kind: "delivery", place: P.orchard, ref: "PO", note: "Back dock; ring the bell." }] },
  { payer: 3, project: "Appliances, Fort Wayne to Michigan City", miles: 132, flat: 69000, trailer: "van", note: "Keep upright; load bars required.",
    stops: [{ kind: "pickup", place: P.bluefield, ref: "PU", note: "Door 7. Driver counts pieces." }, { kind: "delivery", place: P.kessler, ref: "PO", note: "Unload by appointment only." }] },
];

export const FREIGHT_TRUCKS = [
  { unit: "C01", make: "Freightliner", model: "Cascadia", year: 2023 },
  { unit: "C02", make: "Volvo", model: "VNL 760", year: 2022 },
  { unit: "C03", make: "Kenworth", model: "T680", year: 2021 },
  { unit: "C04", make: "Peterbilt", model: "579", year: 2022 },
  { unit: "C05", make: "International", model: "LT", year: 2020 },
  { unit: "C06", make: "Freightliner", model: "Cascadia", year: 2019 },
  { unit: "C07", make: "Mack", model: "Anthem", year: 2021 },
  { unit: "C08", make: "Volvo", model: "VNL 660", year: 2018 },
];
export const FREIGHT_TRAILERS = [
  { unit: "V-11", type: "other", notes: "53 ft dry van", kind: "van" },
  { unit: "V-12", type: "other", notes: "53 ft dry van", kind: "van" },
  { unit: "V-13", type: "other", notes: "53 ft dry van, air ride", kind: "van" },
  { unit: "V-14", type: "other", notes: "53 ft dry van", kind: "van" },
  { unit: "F-21", type: "flatbed", notes: "48 ft flatbed, tarps and chains", kind: "flatbed" },
  { unit: "F-22", type: "flatbed", notes: "48 ft step deck", kind: "flatbed" },
] as const;
export const FREIGHT_DRIVERS = ["Nolan Brooks", "Priya Raman", "Tomas Villareal", "Grace Whitfield", "Jamal Ortiz", "Elena Novak", "Curtis Bell", "Sofia Marchetti"];
export const FREIGHT_STAFF = [
  { full_name: "Dana Whitaker", job_title: "Owner", department: "management", hire: -3000 },
  { full_name: "Renee Dalton", job_title: "Dispatcher", department: "dispatch", hire: -1400 },
  { full_name: "Owen Fischer", job_title: "Billing & settlements", department: "office", hire: -800 },
  { full_name: "Hank Morrow", job_title: "Shop mechanic", department: "shop", hire: -2100 },
];
const CREWS: Array<[string, string, string, string]> = [
  ["C01", "V-11", "F-21", "Nolan Brooks"], ["C02", "V-12", "F-22", "Priya Raman"], ["C03", "V-13", "F-21", "Tomas Villareal"], ["C04", "V-14", "F-22", "Grace Whitfield"],
  ["C05", "V-11", "F-21", "Jamal Ortiz"], ["C07", "V-12", "F-22", "Curtis Bell"], ["C08", "V-13", "F-21", "Sofia Marchetti"],
];
const SLOTS: Array<[string, string]> = [["05:30", "11:30"], ["07:00", "13:00"], ["11:00", "17:00"]];

export const FREIGHT_LOCATIONS = {
  yard: { lat: 41.4731, lng: -87.0611 },
  sites: {
    "Shipping dock 2": { lat: 42.2917, lng: -85.5872 },
    "Coil yard, bay 4": { lat: 41.5934, lng: -87.3464 },
    "Distribution center, door 14": { lat: 41.5250, lng: -88.0817 },
    "Receiving, door 7": { lat: 41.0793, lng: -85.1394 },
    "Warehouse B": { lat: 41.6528, lng: -83.5379 },
    "Yard 3 pickup": { lat: 39.7684, lng: -86.1581 },
    "Broker office": { lat: 41.4650, lng: -87.0500 },
  },
};

/** Refuses anything that is not a demo company (the caller's current company decides). */
async function requireDemo(db: Db) {
  const { data } = await db.rpc("my_access");
  const companyId = (data as { company_id?: string } | null)?.company_id;
  const { data: c } = companyId ? await db.from("companies").select("is_demo").eq("id", companyId).maybeSingle() : { data: null };
  if (!(c as { is_demo?: boolean } | null)?.is_demo) throw new Error("The freight demo is only set up in a demo company.");
}

/** Set up a new Cobalt Plains Freight demo (the platform admin who just created it is its owner), then fill its days. */
export async function seedFreightDemo(db: Db, timeZone = FREIGHT_DEMO.timeZone): Promise<RefreshResult> {
  await requireDemo(db);
  const today = todayIn(timeZone);
  await must("company settings", db.from("company_settings").update({
    company_name: FREIGHT_DEMO.name, address_line1: "250 Example Terminal Rd", city: FREIGHT_DEMO.city, state: FREIGHT_DEMO.state, postal_code: "",
    phone: "(555) 010-0190", email: "dispatch@cobaltplains.example", website: "", brand_color: "#1F5FA8", brand_sidebar_color: "#0B1B2E",
  }).not("company_id", "is", null).select("company_id"));
  // General freight: bills of lading in the menu, the pages and the driver app (MK1). Absent before 20261120007600.
  await db.from("company_settings").update({ industry: "freight" }).not("company_id", "is", null);

  // Extra charges a freight carrier bills besides linehaul (fictional rates set on the order when used).
  await must("charge items", db.from("charge_items").insert([
    { code: "DET-HR", name: "Detention", kind: "surcharge", calc_method: "per_unit", default_unit_code: "hour", description: "After 2 hours free time at a shipper or receiver." },
    { code: "LUMPER", name: "Lumper fee", kind: "surcharge", calc_method: "per_unit", default_unit_code: "each", description: "Unloading fee paid at the receiver, billed back with the receipt." },
    { code: "TONU", name: "Truck ordered not used", kind: "surcharge", calc_method: "per_unit", default_unit_code: "each", description: "Load cancelled after the truck was dispatched." },
  ]).select("id"));

  const result = await refreshFreightDemo(db, timeZone, { seeding: true });

  // Truck C06 is in the shop; one medical card expires soon (the reminder shows).
  const trucks = new Map(((await must("trucks", db.from("trucks").select("id, unit_number"))) as Array<{ id: string; unit_number: string }>).map((t) => [t.unit_number, t.id]));
  await must("out of service", db.rpc("set_equipment_service_status", { p_kind: "truck", p_id: trucks.get("C06"), p_status: "out_of_service", p_reason: "Turbo replacement", p_expected_return: addDays(today, 3) }));
  const drivers = new Map(((await must("drivers", db.from("drivers").select("id, name"))) as Array<{ id: string; name: string }>).map((d) => [d.name, d.id]));
  await db.from("driver_qualifications").update({ expires_on: addDays(today, 16) }).eq("driver_id", drivers.get("Elena Novak")).eq("kind", "medical_card");

  if (await installed(db, "work_orders")) {
    const wo = (p: Record<string, unknown>) => must("work order", db.rpc("maintenance_create_work_order", { p: { submission_key: randomUUID(), ...p } }));
    await wo({ truck_id: trucks.get("C06"), title: "Turbo whistle and power loss", category: "engine", urgency: "high", safety_critical: false, description: "Driver reported loss of power on grades." });
    await wo({ truck_id: trucks.get("C03"), title: "Trailer light plug corroded", category: "electrical", urgency: "normal", safety_critical: false, description: "" });
    // The shared samples may already have added a schedule for some trucks; keep theirs.
    const scheduled = new Set(((await db.from("maintenance_schedules").select("truck_id")).data ?? [] as Array<{ truck_id: string | null }>).map((r: { truck_id: string | null }) => r.truck_id));
    for (const [i, t] of FREIGHT_TRUCKS.entries()) {
      if (scheduled.has(trucks.get(t.unit) ?? null)) continue;
      await must("schedule", db.rpc("maintenance_save_schedule", { p: { truck_id: trucks.get(t.unit), name: "Oil and filter", interval_days: 90, interval_miles: 25000, warn_days: 14, warn_miles: 2000, last_done_on: addDays(today, -15 - i * 10) } }));
    }
  }
  if (await installed(db, "vehicle_documents")) {
    await must("documents", db.from("vehicle_documents").insert([
      ...FREIGHT_TRUCKS.map((t, i) => ({ truck_id: trucks.get(t.unit), kind: "registration", title: "Registration (IRP)", reference_number: `CPF-REG-${t.unit}`, issuing_authority: "", expires_on: addDays(today, i === 2 ? 19 : 150 + i * 15), submission_key: randomUUID() })),
      { truck_id: trucks.get("C01"), kind: "inspection", title: "Annual inspection", reference_number: "CPF-INSP-C01", issuing_authority: "", expires_on: addDays(today, 12), submission_key: randomUUID() },
    ]));
  }
  return result;
}

export interface RefreshResult { added: number; loads: number }

/**
 * Keep the freight demo current: re-add missing sample records (by name or unit number), then give each of the last
 * 10 weekdays with no loads 2 delivered loads, today (when empty) 3 loads (the finished ones delivered) and tomorrow
 * (when empty) 2 planned loads, one assigned. Every load has its shipper-to-receiver stops. A second run adds nothing.
 */
export async function refreshFreightDemo(db: Db, timeZone = FREIGHT_DEMO.timeZone, opts: { seeding?: boolean } = {}): Promise<RefreshResult> {
  await requireDemo(db);
  const today = todayIn(timeZone);
  let added = 0;

  const existingCustomers = (await must("customers", db.from("customers").select("id, name"))) as Array<{ id: string; name: string }>;
  const cust = new Map(existingCustomers.map((c) => [c.name, c.id]));
  const missingCustomers = FREIGHT_CUSTOMERS.filter((c) => !cust.has(c.name));
  if (missingCustomers.length) {
    const rows = (await must("customers", db.from("customers").insert(missingCustomers.map((c, i) => ({
      name: c.name, email: `freight@${c.name.toLowerCase().replace(/[^a-z]+/g, "")}.example`, phone: `555-013${i}`,
      billing_line1: c.place.line1, billing_city: c.place.city, billing_state: c.place.state, billing_postal_code: c.place.zip, payment_terms: c.terms, po_required: false,
    }))).select("id, name"))) as Array<{ id: string; name: string }>;
    await must("sites", db.from("customer_sites").insert(rows.map((r) => {
      const c = FREIGHT_CUSTOMERS.find((x) => x.name === r.name)!;
      return { customer_id: r.id, label: c.site, line1: c.place.line1, city: c.place.city, state: c.place.state, postal_code: c.place.zip };
    })));
    for (const r of rows) cust.set(r.name, r.id);
    added += rows.length;
  }

  const truck = new Map(((await must("trucks", db.from("trucks").select("id, unit_number"))) as Array<{ id: string; unit_number: string }>).map((t) => [t.unit_number, t.id]));
  const missingTrucks = FREIGHT_TRUCKS.filter((t) => !truck.has(t.unit));
  if (missingTrucks.length) {
    const rows = (await must("trucks", db.from("trucks").insert(missingTrucks.map((t) => ({
      unit_number: t.unit, truck_type: "tractor", make: t.make, model: t.model, model_year: t.year, weight_capacity: 22, weight_unit: "ton", capacity_verified_at: new Date().toISOString(),
    }))).select("id, unit_number"))) as Array<{ id: string; unit_number: string }>;
    for (const r of rows) truck.set(r.unit_number, r.id);
    added += rows.length;
  }
  const trailer = new Map(((await must("trailers", db.from("trailers").select("id, unit_number"))) as Array<{ id: string; unit_number: string }>).map((t) => [t.unit_number, t.id]));
  const missingTrailers = FREIGHT_TRAILERS.filter((t) => !trailer.has(t.unit));
  if (missingTrailers.length) {
    const rows = (await must("trailers", db.from("trailers").insert(missingTrailers.map((t) => ({
      unit_number: t.unit, trailer_type: t.type, weight_capacity: 22, weight_unit: "ton", compatible_truck_types: ["tractor"], notes: t.notes,
    }))).select("id, unit_number"))) as Array<{ id: string; unit_number: string }>;
    for (const r of rows) trailer.set(r.unit_number, r.id);
    added += rows.length;
  }

  const driver = new Map(((await must("drivers", db.from("drivers").select("id, name"))) as Array<{ id: string; name: string }>).map((d) => [d.name, d.id]));
  const missingDrivers = FREIGHT_DRIVERS.filter((n) => !driver.has(n));
  if (missingDrivers.length) {
    const rows = (await must("drivers", db.from("drivers").insert(missingDrivers.map((name) => {
      const i = FREIGHT_DRIVERS.indexOf(name);
      return { name, employee_number: `CP-${101 + i}`, phone: `555-014${i}`, hire_date: addDays(today, -250 - i * 130), user_id: null, notes: "" };
    })).select("id, name"))) as Array<{ id: string; name: string }>;
    const verified = new Date().toISOString();
    await must("qualifications", db.from("driver_qualifications").insert(rows.flatMap((d, i) => [
      { driver_id: d.id, kind: "cdl", cdl_class: "A", expires_on: addDays(today, 420 + i * 40), verified_at: verified },
      { driver_id: d.id, kind: "medical_card", expires_on: addDays(today, 240 + i * 30), verified_at: verified },
    ])));
    for (const r of rows) driver.set(r.name, r.id);
    added += rows.length;
  }

  const employees = await db.from("employees").select("full_name");
  if (!employees.error) {
    const have = new Set(((employees.data ?? []) as Array<{ full_name: string }>).map((e) => e.full_name));
    const missing = [
      ...FREIGHT_STAFF.filter((s) => !have.has(s.full_name)).map((s) => ({ full_name: s.full_name, job_title: s.job_title, department: s.department, employment_type: "full_time", status: "active", hire_date: addDays(today, s.hire), driver_id: null, user_id: null, work_email: "", work_phone: "" })),
      ...FREIGHT_DRIVERS.filter((n) => !have.has(n) && driver.has(n)).map((n, i) => ({ full_name: n, job_title: i % 3 === 1 ? "Driver: flatbed" : "Driver: regional van", department: "operations", employment_type: "full_time", status: "active", hire_date: addDays(today, -365), driver_id: driver.get(n)!, user_id: null, work_email: "", work_phone: "" })),
    ];
    if (missing.length) {
      await must("employees", db.from("employees").insert(missing));
      added += missing.length;
    }
  }

  // Linehaul charges: per mile and flat per load.
  const chargeId = async (code: string, name: string, unit: string) => {
    const found = ((await must("charge item", db.from("charge_items").select("id").eq("code", code).maybeSingle())) as { id: string } | null)?.id;
    if (found) return found;
    added++;
    return ((await must("charge item", db.from("charge_items").insert({ code, name, kind: "hauling", calc_method: "per_unit", default_unit_code: unit, description: "" }).select("id").single())) as { id: string }).id;
  };
  const perMile = await chargeId("LH-MILE", "Linehaul (per mile)", "mile");
  const flat = await chargeId("LH-FLAT", "Linehaul (flat per load)", "load");

  // --- Loads: fill empty days only --------------------------------------------------------------
  const from = addDays(today, -14);
  const to = addDays(today, 1);
  const busy = new Set(((await must("loads", db.from("order_loads").select("load_date").gte("load_date", from).lte("load_date", to))) as Array<{ load_date: string }>).map((l) => l.load_date));
  const now = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  const days: Array<{ date: string; kind: "past" | "today" | "tomorrow" }> = [];
  for (let back = 14, n = 0; back >= 1 && n < 10; back--) {
    const d = addDays(today, -back);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    n++;
    if (!busy.has(d)) days.push({ date: d, kind: "past" });
  }
  if (!busy.has(today)) days.push({ date: today, kind: "today" });
  if (!busy.has(to)) days.push({ date: to, kind: "tomorrow" });

  const hhmm = (t: string, plus: number) => { const m = Math.min(23 * 60 + 30, Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + plus); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  let loads = 0;
  let urgentFlagged = false;
  for (const day of days) {
    const seed = Number(day.date.replaceAll("-", "")) % 89;
    const count = day.kind === "today" ? 3 : 2;
    for (let k = 0; k < count; k++) {
      const lane = FREIGHT_LANES[(seed + k * 2) % FREIGHT_LANES.length];
      const payer = FREIGHT_CUSTOMERS[lane.payer];
      const customerId = cust.get(payer.name);
      if (!customerId) continue;
      const last = lane.stops[lane.stops.length - 1].place;
      const line = lane.perMile
        ? { kind: "hauling", calc_method: "per_unit", charge_item_id: perMile, description: `Linehaul, ${lane.miles} mi`, unit_code: "mile", quantity: String(lane.miles), unit_rate_cents: lane.perMile, taxable: false }
        : { kind: "hauling", calc_method: "per_unit", charge_item_id: flat, description: `Linehaul, flat (${lane.miles} mi)`, unit_code: "load", quantity: "1", unit_rate_cents: lane.flat, taxable: false };
      const tag = `${day.date.replaceAll("-", "").slice(2)}${k + 1}`;
      const o = (await must("order", db.rpc("save_order_draft", { p_payload: {
        customer_id: customerId, order_date: day.date, project_name: lane.project, job_instructions: lane.note,
        customer_po: `PO ${4100 + ((seed * 7 + k) % 900)}`, site_label: last.name, site_line1: last.line1, site_city: last.city, site_state: last.state, site_postal_code: last.zip, lines: [line],
      } }))) as { order_id: string };
      await must("confirm", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "confirmed", p_note: "" }));
      await must("schedule", db.rpc("update_order_schedule", { p_order_id: o.order_id, p_expected_edit_seq: null, p_payload: { scheduled_start: day.date, scheduled_end: day.date } }));
      await must("scheduled", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "scheduled", p_note: "" }));
      const lineId = ((await must("lines", db.from("order_lines").select("id").eq("order_id", o.order_id).order("line_no"))) as Array<{ id: string }>)[0].id;
      const [start, end] = SLOTS[k % SLOTS.length];
      // Stops in order, with appointment windows across the load's hours (MK2). Skipped before 20261120007800.
      const span = (Number(end.slice(0, 2)) - Number(start.slice(0, 2))) * 60;
      const step = Math.floor(span / Math.max(1, lane.stops.length - 1));
      const stops = lane.stops.map((s, i) => ({
        kind: s.kind, name: s.place.name, address_line1: s.place.line1, city: s.place.city, state: s.place.state, postal_code: s.place.zip,
        appointment_date: day.date, window_start: hhmm(start, i * step - (i ? 60 : 0)), window_end: hhmm(start, i * step + (i ? 0 : 60)),
        reference: s.ref === "PU" ? `PU-${tag}` : s.ref === "BOL" ? `BOL ${tag}` : `PO ${4100 + ((seed * 7 + k) % 900)}`, notes: s.note,
      }));
      const saved = await db.rpc("save_order_stops", { p_order: o.order_id, p_stops: stops });
      if (saved.error && saved.error.code !== "PGRST202") throw new Error(`Freight demo failed at "stops": ${saved.error.message}`);
      const loadId = ((await must("load", db.rpc("save_order_load", { p_payload: { order_id: o.order_id, load_date: day.date, start_time: start, end_time: end, planned_quantity: lane.perMile ? String(lane.miles) : "1", unit_code: lane.perMile ? "mile" : "load" } }))) as { load_id: string }).load_id;
      loads++;
      if (day.kind === "tomorrow" && k === 1) continue; // one planned load stays open for the dispatcher
      if (day.kind === "today" && k === 2 && opts.seeding && !urgentFlagged) {
        // A load the customer moved up, still to be covered: the urgent flag shows on the board.
        await db.rpc("flag_order_urgent", { p_order_id: o.order_id, p_reason: "Receiver moved the appointment up; needs a truck today." });
        urgentFlagged = true;
        continue;
      }
      const [unit, van, bed, name] = CREWS[(seed + k) % CREWS.length];
      if (!truck.has(unit) || !driver.has(name)) continue;
      const tr = lane.trailer === "flatbed" ? bed : van;
      const a = await demoAssign(db, { p_load_id: loadId, p_truck_id: truck.get(unit), p_trailer_id: trailer.get(tr) ?? null, p_driver_id: driver.get(name), p_note: "" });
      if (a.error) continue; // refused by the rules (leave, shop, conflict): stays unassigned, as for a dispatcher
      const finished = day.kind === "past" || (day.kind === "today" && end <= now);
      if (!finished) continue;
      const t = await db.rpc("submit_delivery_ticket", { p_payload: {
        load_id: loadId, order_line_id: lineId, delivered_date: day.date, delivered_time: end,
        quantity: lane.perMile ? String(lane.miles) : "1", unit_code: lane.perMile ? "mile" : "load", external_reference: `BOL ${tag}`,
      } });
      if (!t.error) await db.rpc("review_delivery_ticket", { p_ticket_id: (t.data as { ticket_id: string }).ticket_id, p_action: "accept", p_note: "" });
    }
  }

  added += await ensureDemoLocations(db, FREIGHT_LOCATIONS);
  added += await seedCommunicationSamples(db);
  // Every released feature's samples the demo does not have yet (shared with every demo).
  added += (await ensureFeatureSamples(db, today)).added;
  return { added, loads };
}
