import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, todayIn } from "@/lib/dates";
import { seedCommunicationSamples } from "./prairie-lantern";
import { NORTHFIELD_LOCATIONS, ensureDemoLocations } from "./locations";
import { ensureFeatureSamples } from "./samples";
import { AVATARS, CAPACITY, CHARGE_ITEMS, CUSTOMERS, DRIVER_TITLES, DRIVERS, MATERIALS, STAFF, TRAILERS, TRUCKS } from "./seed";

/**
 * Keeps the presenter demo (Northfield Aggregates) current, the same way Refresh keeps Prairie Lantern Freight
 * current (prairie-lantern-refresh.ts). Additive only, through the normal app functions as the demo's owner: it never
 * changes or deletes anything.
 *
 * - Sample records missing from the current sample set (matched by name, code or unit number) are added: charge items,
 *   customers and sites, trucks, trailers, drivers with qualifications, employees.
 * - Each of the last 10 weekdays with no loads gets 2 delivered and verified loads; today (when empty) gets 3 loads —
 *   the ones already finished are delivered — and tomorrow (when empty) gets 2 planned loads, one assigned.
 * - Communications samples and every released feature's shared samples (samples.ts).
 * A second run on the same day adds nothing. A load whose assignment the rules refuse (time off, truck in the shop)
 * stays unassigned, as it would for a dispatcher.
 */
type Db = SupabaseClient;

async function must<T>(label: string, p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`Demo refresh failed at "${label}": ${error.message}`);
  return data;
}

/** Recurring jobs: customer (index into CUSTOMERS), product (MATERIALS code) and the site instructions. */
const JOBS = [
  { c: 0, code: "SND-F", project: "Cedar Ridge — pad fill", note: "Use the Oak St entrance. Dump at the marked pads only." },
  { c: 1, code: "LS-53", project: "County Rd 9 — base course", note: "Spread on the east shoulder; flagger at the north end." },
  { c: 3, code: "ST-8", project: "4th St water main — bedding stone", note: "Call the site foreman 30 minutes out." },
  { c: 4, code: "LS-53", project: "Harlow Meadows — driveway base", note: "Keep the sidewalk clear." },
  { c: 5, code: "SND-F", project: "Township salt dome pad — fill", note: "Check in at the public works office." },
  { c: 6, code: "ST-8", project: "Summit batch plant — stone stockpile", note: "Dump on the north pile; scale ticket required." },
  { c: 7, code: "RR-3", project: "Oakmont Elementary — drainage riprap", note: "No trucks during school drop-off (7:30–8:15)." },
];
/** Truck, trailer (or none) and driver that usually run together. */
const CREWS: Array<[string, string | null, string]> = [
  ["101", null, "Avery Lindqvist"], ["102", null, "Marco Delgado"], ["104", null, "Theo Brandt"], ["105", null, "Priya Raman"],
  ["108", "E-21", "Grace Whitfield"], ["109", "B-31", "Isaac Moreno"], ["110", null, "Talia Novak"], ["107", null, "Ruben Castillo"],
];
const SLOTS: Array<[string, string]> = [["07:00", "08:30"], ["09:30", "11:00"], ["13:00", "14:30"]];

export interface RefreshResult { added: number; loads: number }

export async function refreshNorthfield(db: Db): Promise<RefreshResult> {
  const settings = (await must("settings", db.from("company_settings").select("timezone").limit(1).maybeSingle())) as { timezone: string } | null;
  const timeZone = settings?.timezone || "America/Chicago";
  const today = todayIn(timeZone);
  let added = 0;

  // --- Sample records missing from the current set -------------------------------------------
  const haveCharges = new Set(((await must("charge items", db.from("charge_items").select("code"))) as Array<{ code: string | null }>).map((c) => c.code));
  const missingCharges = CHARGE_ITEMS.filter((c) => !haveCharges.has(c.code));
  if (missingCharges.length) {
    await must("charge items", db.from("charge_items").insert(missingCharges));
    added += missingCharges.length;
  }

  const material = new Map(((await must("materials", db.from("materials").select("id, code"))) as Array<{ id: string; code: string }>).map((m) => [m.code, m.id]));

  const existingCustomers = (await must("customers", db.from("customers").select("id, name"))) as Array<{ id: string; name: string }>;
  const custByName = new Map(existingCustomers.map((c) => [c.name, c.id]));
  const missingCustomers = CUSTOMERS.filter((c) => !custByName.has(c.name));
  if (missingCustomers.length) {
    const rows = (await must("customers", db.from("customers").insert(missingCustomers.map((c) => ({
      name: c.name, email: "", phone: "", billing_line1: c.line1, billing_city: c.city, billing_state: "", payment_terms: "Net 30", po_required: false,
    }))).select("id, name"))) as Array<{ id: string; name: string }>;
    await must("sites", db.from("customer_sites").insert(rows.map((r) => {
      const c = CUSTOMERS.find((x) => x.name === r.name)!;
      return { customer_id: r.id, label: c.site, line1: c.line1, city: c.city, state: "" };
    })));
    for (const r of rows) custByName.set(r.name, r.id);
    added += rows.length;
  }

  const truck = new Map(((await must("trucks", db.from("trucks").select("id, unit_number"))) as Array<{ id: string; unit_number: string }>).map((t) => [t.unit_number, t.id]));
  const missingTrucks = TRUCKS.filter((t) => !truck.has(t.unit));
  if (missingTrucks.length) {
    const rows = (await must("trucks", db.from("trucks").insert(missingTrucks.map((t) => ({
      unit_number: t.unit, truck_type: t.type, make: t.make, model: t.model, weight_capacity: CAPACITY[t.type], weight_unit: "ton", capacity_verified_at: new Date().toISOString(),
    }))).select("id, unit_number"))) as Array<{ id: string; unit_number: string }>;
    for (const r of rows) truck.set(r.unit_number, r.id);
    added += rows.length;
  }

  const trailer = new Map(((await must("trailers", db.from("trailers").select("id, unit_number"))) as Array<{ id: string; unit_number: string }>).map((t) => [t.unit_number, t.id]));
  const missingTrailers = TRAILERS.filter((t) => !trailer.has(t.unit));
  if (missingTrailers.length) {
    const rows = (await must("trailers", db.from("trailers").insert(missingTrailers.map((t) => ({
      unit_number: t.unit, trailer_type: t.type, weight_capacity: t.capacity, weight_unit: "ton", compatible_truck_types: t.compatible, notes: t.notes,
    }))).select("id, unit_number"))) as Array<{ id: string; unit_number: string }>;
    for (const r of rows) trailer.set(r.unit_number, r.id);
    added += rows.length;
  }

  const driver = new Map(((await must("drivers", db.from("drivers").select("id, name"))) as Array<{ id: string; name: string }>).map((d) => [d.name, d.id]));
  const missingDrivers = DRIVERS.filter((n) => !driver.has(n));
  if (missingDrivers.length) {
    const rows = (await must("drivers", db.from("drivers").insert(missingDrivers.map((name) => ({
      name, employee_number: "", phone: "", hire_date: addDays(today, -365), user_id: null, notes: "",
    }))).select("id, name"))) as Array<{ id: string; name: string }>;
    const verified = new Date().toISOString();
    await must("qualifications", db.from("driver_qualifications").insert(rows.flatMap((d) => [
      { driver_id: d.id, kind: "cdl", cdl_class: "A", expires_on: addDays(today, 500), verified_at: verified },
      { driver_id: d.id, kind: "medical_card", expires_on: addDays(today, 300), verified_at: verified },
    ])));
    for (const r of rows) driver.set(r.name, r.id);
    added += rows.length;
  }

  const employees = await db.from("employees").select("full_name");
  if (!employees.error) {
    const have = new Set(((employees.data ?? []) as Array<{ full_name: string }>).map((e) => e.full_name));
    const withAvatars = !(await db.from("employees").select("avatar_key").limit(1)).error;
    const missing = [
      ...STAFF.filter((s) => !have.has(s.full_name)).map((s) => ({ full_name: s.full_name, job_title: s.job_title, department: s.department, employment_type: s.type ?? "full_time", status: "active", hire_date: addDays(today, s.hire), driver_id: null, user_id: null, work_email: "", work_phone: "" })),
      ...DRIVERS.filter((n) => !have.has(n) && driver.has(n)).map((n) => ({ full_name: n, job_title: DRIVER_TITLES[n] ?? "Driver", department: "operations", employment_type: "full_time", status: "active", hire_date: addDays(today, -365), driver_id: driver.get(n)!, user_id: null, work_email: "", work_phone: "" })),
    ].map((r) => (withAvatars ? { ...r, avatar_key: AVATARS[r.full_name] ?? "" } : r));
    if (missing.length) {
      await must("employees", db.from("employees").insert(missing));
      added += missing.length;
    }
  }

  // --- Loads: fill empty days only --------------------------------------------------------------
  const from = addDays(today, -14);
  const to = addDays(today, 1);
  const busy = new Set(((await must("loads", db.from("order_loads").select("load_date").gte("load_date", from).lte("load_date", to))) as Array<{ load_date: string }>).map((l) => l.load_date));
  const now = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  const truckType = new Map(TRUCKS.map((t) => [t.unit, t.type]));

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

  let loads = 0;
  for (const day of days) {
    const seed = Number(day.date.replaceAll("-", "")) % 97;
    const count = day.kind === "today" ? 3 : 2;
    for (let k = 0; k < count; k++) {
      const job = JOBS[(seed + k * 3) % JOBS.length];
      const c = CUSTOMERS[job.c];
      const customerId = custByName.get(c.name);
      const m = MATERIALS.find((x) => x.code === job.code)!;
      const materialId = material.get(job.code);
      if (!customerId || !materialId) continue;
      const [unit, tr, name] = CREWS[(seed + k) % CREWS.length];
      const cap = CAPACITY[truckType.get(unit) ?? "tri_axle_dump"];
      const o = (await must("order", db.rpc("save_order_draft", { p_payload: {
        customer_id: customerId, order_date: day.date, project_name: job.project, job_instructions: job.note, site_label: c.site, site_line1: c.line1, site_city: c.city,
        lines: [{ kind: "material", calc_method: "per_unit", material_id: materialId, description: m.name, unit_code: m.unit, quantity: String(cap), unit_rate_cents: m.rate, taxable: true }],
      } }))) as { order_id: string };
      await must("confirm", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "confirmed", p_note: "" }));
      await must("schedule", db.rpc("update_order_schedule", { p_order_id: o.order_id, p_expected_edit_seq: null, p_payload: { scheduled_start: day.date, scheduled_end: day.date } }));
      await must("scheduled", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "scheduled", p_note: "" }));
      const lineId = ((await must("lines", db.from("order_lines").select("id").eq("order_id", o.order_id).order("line_no"))) as Array<{ id: string }>)[0].id;
      const [start, end] = SLOTS[k % SLOTS.length];
      const loadId = ((await must("load", db.rpc("save_order_load", { p_payload: { order_id: o.order_id, load_date: day.date, start_time: start, end_time: end, planned_quantity: String(cap), unit_code: m.unit } }))) as { load_id: string }).load_id;
      loads++;
      if (day.kind === "tomorrow" && k === 1) continue; // one planned load stays open for the dispatcher
      if (!truck.has(unit) || !driver.has(name)) continue;
      const a = await db.rpc("assign_load", { p_load_id: loadId, p_truck_id: truck.get(unit), p_trailer_id: tr ? trailer.get(tr) ?? null : null, p_driver_id: driver.get(name), p_note: "" });
      if (a.error) continue; // refused by the rules (leave, shop, conflict): stays unassigned
      const finished = day.kind === "past" || (day.kind === "today" && end <= now);
      if (!finished) continue;
      const qty = (cap - 0.3 + (k % 3) * 0.1).toFixed(2);
      const t = await db.rpc("submit_delivery_ticket", { p_payload: { load_id: loadId, order_line_id: lineId, delivered_date: day.date, delivered_time: end, quantity: qty, unit_code: m.unit, external_reference: `NF-${day.date.replaceAll("-", "").slice(2)}-R${k + 1}` } });
      if (!t.error) await db.rpc("review_delivery_ticket", { p_ticket_id: (t.data as { ticket_id: string }).ticket_id, p_action: "accept", p_note: "" });
    }
  }
  added += await seedCommunicationSamples(db);
  added += await ensureDemoLocations(db, NORTHFIELD_LOCATIONS);
  added += (await ensureFeatureSamples(db, today)).added;
  return { added, loads };
}
