import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, todayIn } from "@/lib/dates";
import { ensureFeatureSamples } from "./samples";
import { CUSTOMERS, DRIVERS, PRAIRIE_LANTERN, seedCommunicationSamples, STAFF, TRAILERS, TRUCKS } from "./prairie-lantern";

/**
 * Keeps the Prairie Lantern Freight prospect demo current. Additive only, through
 * the normal app functions as the platform admin who owns the demo: it never
 * changes or deletes anything, so whatever the prospect created or edited stays.
 *
 * - Sample records missing from the current sample set (matched by name or unit
 *   number) are added: customers and sites, trucks, trailers, drivers with
 *   qualifications, employees.
 * - Each of the last 10 weekdays with no loads gets 2 delivered and verified loads;
 *   today (when empty) gets 3 loads — the ones already finished are delivered —
 *   and tomorrow (when empty) gets 2 planned loads, one assigned.
 * A second run on the same day adds nothing. A load whose assignment the rules
 * refuse (time off, truck in the shop) simply stays unassigned.
 */
type Db = SupabaseClient;

async function must<T>(label: string, p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`Demo refresh failed at "${label}": ${error.message}`);
  return data;
}

const LANES = [
  { c: 0, project: "Bagged feed to Bluestem Grain", lane: "Linehaul, Lafayette → Rensselaer", rate: 68000, note: "Check in at the scale office. Forklift unloading only." },
  { c: 1, project: "Seed pallets to Sugarbush Farm Supply", lane: "Linehaul, Fowler → Remington", rate: 52000, note: "Dock 3; call ahead." },
  { c: 2, project: "Pallets to Ridgeline Packaging", lane: "Linehaul, Rensselaer → Lafayette", rate: 64000, note: "Dock 4. Call shipping 30 minutes out." },
  { c: 3, project: "Lumber to Marshland Lumber", lane: "Linehaul, Monticello → DeMotte", rate: 72000, note: "Tarp the load. North gate closes at 15:00." },
  { c: 5, project: "Feed ingredients to Wildrye Seed & Feed", lane: "Linehaul, Rensselaer → Fowler", rate: 61000, note: "Weigh in and out at the co-op scale." },
  { c: 6, project: "Building supplies to Prairie Gate Builders", lane: "Linehaul, Rensselaer → Kentland", rate: 58000, note: "Unload at the builders yard; forklift on site." },
  { c: 7, project: "Implement parts to Ironweed Implement", lane: "Linehaul, Rensselaer → Delphi", rate: 66000, note: "Deliver to the parts depot; signature required." },
];
const CREWS: Array<[string, string, string]> = [
  ["201", "T-53", "Gavin Holt"], ["202", "T-51", "Rosa Medina"], ["203", "T-52", "Eli Sutter"], ["204", "T-53", "Kendra Price"],
  ["205", "T-51", "Mateo Ruiz"], ["208", "T-52", "Darnell Hayes"], ["209", "T-51", "Lucy Tran"], ["210", "T-53", "Wes Carver"],
];
const SLOTS: Array<[string, string]> = [["06:30", "09:30"], ["10:00", "13:00"], ["13:30", "16:30"]];

export interface RefreshResult { added: number; loads: number }

export async function refreshPrairieLantern(db: Db, timeZone = PRAIRIE_LANTERN.timeZone): Promise<RefreshResult> {
  const today = todayIn(timeZone);
  let added = 0;

  // --- Sample records missing from the current set -------------------------------------------
  const existingCustomers = (await must("customers", db.from("customers").select("id, name"))) as Array<{ id: string; name: string }>;
  const custByName = new Map(existingCustomers.map((c) => [c.name, c.id]));
  const missingCustomers = CUSTOMERS.filter((c) => !custByName.has(c.name));
  if (missingCustomers.length) {
    const rows = (await must("customers", db.from("customers").insert(missingCustomers.map((c) => ({
      name: c.name, email: `shipping@${c.name.toLowerCase().replace(/[^a-z]+/g, "")}.example`, phone: "", billing_line1: c.line1, billing_city: c.city, billing_state: "IN", payment_terms: "Net 30", po_required: false,
    }))).select("id, name"))) as Array<{ id: string; name: string }>;
    await must("sites", db.from("customer_sites").insert(rows.map((r) => {
      const c = CUSTOMERS.find((x) => x.name === r.name)!;
      return { customer_id: r.id, label: c.site, line1: c.line1, city: c.city, state: "IN" };
    })));
    for (const r of rows) custByName.set(r.name, r.id);
    added += rows.length;
  }

  const existingTrucks = (await must("trucks", db.from("trucks").select("id, unit_number"))) as Array<{ id: string; unit_number: string }>;
  const truck = new Map(existingTrucks.map((t) => [t.unit_number, t.id]));
  const missingTrucks = TRUCKS.filter((t) => !truck.has(t.unit));
  if (missingTrucks.length) {
    const rows = (await must("trucks", db.from("trucks").insert(missingTrucks.map((t) => ({
      unit_number: t.unit, truck_type: "tractor", make: t.make, model: t.model, model_year: t.year, weight_capacity: 22, weight_unit: "ton", capacity_verified_at: new Date().toISOString(),
    }))).select("id, unit_number"))) as Array<{ id: string; unit_number: string }>;
    for (const r of rows) truck.set(r.unit_number, r.id);
    added += rows.length;
  }

  const existingTrailers = (await must("trailers", db.from("trailers").select("id, unit_number"))) as Array<{ id: string; unit_number: string }>;
  const trailer = new Map(existingTrailers.map((t) => [t.unit_number, t.id]));
  const missingTrailers = TRAILERS.filter((t) => !trailer.has(t.unit));
  if (missingTrailers.length) {
    const rows = (await must("trailers", db.from("trailers").insert(missingTrailers.map((t) => ({
      unit_number: t.unit, trailer_type: t.type, weight_capacity: 22, weight_unit: "ton", compatible_truck_types: ["tractor"], notes: t.notes,
    }))).select("id, unit_number"))) as Array<{ id: string; unit_number: string }>;
    for (const r of rows) trailer.set(r.unit_number, r.id);
    added += rows.length;
  }

  const existingDrivers = (await must("drivers", db.from("drivers").select("id, name"))) as Array<{ id: string; name: string }>;
  const driver = new Map(existingDrivers.map((d) => [d.name, d.id]));
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

  const employees = await db.from("employees").select("full_name, driver_id");
  if (!employees.error) {
    const have = new Set(((employees.data ?? []) as Array<{ full_name: string }>).map((e) => e.full_name));
    const missing = [
      ...STAFF.filter((s) => !have.has(s.full_name)).map((s) => ({ full_name: s.full_name, job_title: s.job_title, department: s.department, employment_type: "full_time", status: "active", hire_date: addDays(today, s.hire), driver_id: null, user_id: null, work_email: "", work_phone: "" })),
      ...DRIVERS.filter((n) => !have.has(n) && driver.has(n)).map((n) => ({ full_name: n, job_title: "Driver", department: "operations", employment_type: "full_time", status: "active", hire_date: addDays(today, -365), driver_id: driver.get(n)!, user_id: null, work_email: "", work_phone: "" })),
    ];
    if (missing.length) {
      await must("employees", db.from("employees").insert(missing));
      added += missing.length;
    }
  }

  // --- Loads: fill empty days only --------------------------------------------------------------
  let charge = ((await must("charge items", db.from("charge_items").select("id").eq("code", "LH-LOAD").maybeSingle())) as { id: string } | null)?.id;
  if (!charge) {
    charge = ((await must("charge item", db.from("charge_items").insert({ code: "LH-LOAD", name: "Linehaul (per load)", kind: "hauling", calc_method: "per_unit", default_unit_code: "load", description: "" }).select("id").single())) as { id: string }).id;
  }
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

  let loads = 0;
  for (const day of days) {
    const seed = Number(day.date.replaceAll("-", "")) % 97;
    const count = day.kind === "today" ? 3 : 2;
    for (let k = 0; k < count; k++) {
      const lane = LANES[(seed + k * 3) % LANES.length];
      const customerId = custByName.get(CUSTOMERS[lane.c].name);
      if (!customerId) continue;
      const c = CUSTOMERS[lane.c];
      const o = (await must("order", db.rpc("save_order_draft", { p_payload: {
        customer_id: customerId, order_date: day.date, project_name: lane.project, job_instructions: lane.note, site_label: c.site, site_line1: c.line1, site_city: c.city,
        lines: [{ kind: "hauling", calc_method: "per_unit", charge_item_id: charge, description: lane.lane, unit_code: "load", quantity: "1", unit_rate_cents: lane.rate, taxable: false }],
      } }))) as { order_id: string };
      await must("confirm", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "confirmed", p_note: "" }));
      await must("schedule", db.rpc("update_order_schedule", { p_order_id: o.order_id, p_expected_edit_seq: null, p_payload: { scheduled_start: day.date, scheduled_end: day.date } }));
      await must("scheduled", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "scheduled", p_note: "" }));
      const lineId = ((await must("lines", db.from("order_lines").select("id").eq("order_id", o.order_id).order("line_no"))) as Array<{ id: string }>)[0].id;
      const [start, end] = SLOTS[k % SLOTS.length];
      const loadId = ((await must("load", db.rpc("save_order_load", { p_payload: { order_id: o.order_id, load_date: day.date, start_time: start, end_time: end, planned_quantity: "1", unit_code: "load" } }))) as { load_id: string }).load_id;
      loads++;
      if (day.kind === "tomorrow" && k === 1) continue; // one planned load stays open for the dispatcher
      const [unit, tr, name] = CREWS[(seed + k) % CREWS.length];
      if (!truck.has(unit) || !driver.has(name)) continue;
      const a = await db.rpc("assign_load", { p_load_id: loadId, p_truck_id: truck.get(unit), p_trailer_id: trailer.get(tr) ?? null, p_driver_id: driver.get(name), p_note: "" });
      if (a.error) continue; // refused by the rules (leave, shop, conflict): stays unassigned, as it would for a dispatcher
      const finished = day.kind === "past" || (day.kind === "today" && end <= now);
      if (!finished) continue;
      const t = await db.rpc("submit_delivery_ticket", { p_payload: { load_id: loadId, order_line_id: lineId, delivered_date: day.date, delivered_time: end, quantity: "1", unit_code: "load", external_reference: `PLF-${day.date.replaceAll("-", "").slice(2)}-${k + 1}` } });
      if (!t.error) await db.rpc("review_delivery_ticket", { p_ticket_id: (t.data as { ticket_id: string }).ticket_id, p_action: "accept", p_note: "" });
    }
  }
  added += await seedCommunicationSamples(db);
  // Existing demos receive every released feature's samples (only those the demo has none of yet).
  added += (await ensureFeatureSamples(db, today)).added;
  return { added, loads };
}
