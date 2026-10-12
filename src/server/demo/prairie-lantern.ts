import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, todayIn } from "@/lib/dates";

/**
 * Fills the "Prairie Lantern Freight" prospect demo tenant (Rensselaer,
 * Indiana) with fictional, internally consistent data — through the same
 * database functions and row-level security the app uses, as the platform
 * admin who just created it and is its owner. It writes only to the current
 * (new) company.
 *
 * Everything is invented: the company, people, customers, street addresses,
 * phone numbers (555-01xx is reserved for fiction), rates and quantities. Town
 * names are real places in the area, used only as locations. No VIN, licence
 * plate, DOT or MC number is set anywhere. Colby Chapman (the prospect, the
 * tenant's owner) gets an employee record with no contact details; his login is
 * linked separately after he sets his own password.
 *
 * Modules whose migration is not installed (maintenance, fleet documents, time
 * off) are skipped, so the tenant shows their normal "not available yet" state.
 */
type Db = SupabaseClient;

async function must<T>(label: string, p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`Demo set-up failed at "${label}": ${error.message}`);
  return data;
}

async function installed(db: Db, table: string) {
  return !(await db.from(table).select("id").limit(1)).error;
}

export const PRAIRIE_LANTERN = { name: "Prairie Lantern Freight", city: "Rensselaer", state: "IN", timeZone: "America/Chicago" };

const CUSTOMERS = [
  { name: "Jasper Valley Grain Co-op (demo)", city: "Rensselaer", site: "Elevator receiving dock", line1: "1200 Example Elevator Rd" },
  { name: "Iroquois River Farm Supply (demo)", city: "Remington", site: "Main warehouse, door 3", line1: "40 Sample Mill St" },
  { name: "Wabash Bend Packaging (demo)", city: "Lafayette", site: "Plant 2 shipping yard", line1: "880 Fictional Industrial Pkwy" },
  { name: "Kankakee Marsh Lumber (demo)", city: "DeMotte", site: "Lumber yard, north gate", line1: "15 Placeholder Timber Ln" },
  { name: "Tippecanoe Fieldworks (demo)", city: "Monticello", site: "Equipment shop", line1: "3 Example Lakeshore Dr" },
  { name: "Benton County Seed & Feed (demo)", city: "Fowler", site: "Seed warehouse", line1: "77 Demo County Line Rd" },
  { name: "Newton Prairie Builders Supply (demo)", city: "Kentland", site: "Builders yard", line1: "210 Sample Commerce Ave" },
  { name: "Carroll County Implement (demo)", city: "Delphi", site: "Parts depot", line1: "9 Fictional Canal St" },
];

const TRUCKS = [
  { unit: "201", make: "Freightliner", model: "Cascadia", year: 2022 },
  { unit: "202", make: "Kenworth", model: "T680", year: 2021 },
  { unit: "203", make: "Peterbilt", model: "579", year: 2023 },
  { unit: "204", make: "Volvo", model: "VNL 760", year: 2020 },
  { unit: "205", make: "International", model: "LT", year: 2022 },
  { unit: "206", make: "Mack", model: "Anthem", year: 2019 },
  { unit: "207", make: "Freightliner", model: "Cascadia", year: 2018 },
  { unit: "208", make: "Kenworth", model: "T680", year: 2024 },
  { unit: "209", make: "Peterbilt", model: "579", year: 2021 },
  { unit: "210", make: "Volvo", model: "VNL 660", year: 2019 },
];

const TRAILERS = [
  { unit: "T-51", type: "flatbed", notes: "48 ft flatbed (demo)" },
  { unit: "T-52", type: "flatbed", notes: "48 ft flatbed with tarps (demo)" },
  { unit: "T-53", type: "other", notes: "53 ft dry van (demo)" },
];

const DRIVERS = ["Gavin Holt", "Rosa Medina", "Eli Sutter", "Kendra Price", "Mateo Ruiz", "Hannah Voss", "Darnell Hayes", "Lucy Tran", "Wes Carver", "Amira Saleh"];

const STAFF = [
  { full_name: "Bethany Cole", job_title: "Dispatcher", department: "dispatch", hire: -1500 },
  { full_name: "Victor Lang", job_title: "Shop mechanic", department: "shop", hire: -2200 },
  { full_name: "Marisol Duarte", job_title: "Office & billing manager", department: "office", hire: -900 },
];

export async function seedPrairieLantern(db: Db, timeZone = PRAIRIE_LANTERN.timeZone): Promise<void> {
  const today = todayIn(timeZone);
  const tomorrow = addDays(today, 1);

  await must("company settings", db.from("company_settings").update({
    company_name: PRAIRIE_LANTERN.name, address_line1: "100 Example Depot Rd", city: PRAIRIE_LANTERN.city, state: PRAIRIE_LANTERN.state, postal_code: "",
    phone: "(555) 010-0180", email: "dispatch@prairielantern.demo.example", website: "",
    brand_color: "#B45309", brand_sidebar_color: "#1C1917",
  }).not("company_id", "is", null).select("company_id"));

  // Freight is priced per load or per hour (demo rates, fictional).
  const charges = (await must("charge items", db.from("charge_items").insert([
    { code: "LH-LOAD", name: "Linehaul (per load)", kind: "hauling", calc_method: "per_unit", default_unit_code: "load", description: "Demo item (fictional)." },
    { code: "HAUL-HR", name: "Hourly freight hauling", kind: "hauling", calc_method: "per_unit", default_unit_code: "hour", description: "Demo item (fictional)." },
    { code: "DET-HR", name: "Detention", kind: "surcharge", calc_method: "per_unit", default_unit_code: "hour", description: "Demo item (fictional)." },
  ]).select("id, code"))) as Array<{ id: string; code: string }>;
  const charge = Object.fromEntries(charges.map((c) => [c.code, c.id]));

  const customers = (await must("customers", db.from("customers").insert(CUSTOMERS.map((c, i) => ({
    name: c.name, email: `shipping${i + 1}@demo.example`, phone: `555-011${i}`, billing_line1: c.line1, billing_city: c.city, billing_state: "IN", payment_terms: "Net 30", po_required: i % 3 === 0,
  }))).select("id, name"))) as Array<{ id: string; name: string }>;
  await must("sites", db.from("customer_sites").insert(customers.map((c, i) => ({ customer_id: c.id, label: CUSTOMERS[i].site, line1: CUSTOMERS[i].line1, city: CUSTOMERS[i].city, state: "IN" }))));

  // Fleet: tractors and a few trailers. No VINs or plates (fictional fleet).
  const trucks = (await must("trucks", db.from("trucks").insert(TRUCKS.map((t) => ({
    unit_number: t.unit, truck_type: "tractor", make: t.make, model: t.model, model_year: t.year, weight_capacity: 22, weight_unit: "ton", capacity_verified_at: new Date().toISOString(),
  }))).select("id, unit_number"))) as Array<{ id: string; unit_number: string }>;
  const truck = Object.fromEntries(trucks.map((t) => [t.unit_number, t.id]));
  const trailers = (await must("trailers", db.from("trailers").insert(TRAILERS.map((t) => ({
    unit_number: t.unit, trailer_type: t.type, weight_capacity: 22, weight_unit: "ton", compatible_truck_types: ["tractor"], notes: t.notes,
  }))).select("id, unit_number"))) as Array<{ id: string; unit_number: string }>;
  const trailer = Object.fromEntries(trailers.map((t) => [t.unit_number, t.id]));

  const drivers = (await must("drivers", db.from("drivers").insert(DRIVERS.map((name, i) => ({
    name, employee_number: `D-${301 + i}`, phone: `555-012${i}`, hire_date: addDays(today, -300 - i * 110), user_id: null, notes: "",
  }))).select("id, name"))) as Array<{ id: string; name: string }>;
  const verified = new Date().toISOString();
  await must("qualifications", db.from("driver_qualifications").insert(drivers.flatMap((d, i) => [
    { driver_id: d.id, kind: "cdl", cdl_class: "A", expires_on: addDays(today, 400 + i * 45), verified_at: verified },
    // One medical card expires soon, so the reminder shows.
    { driver_id: d.id, kind: "medical_card", expires_on: addDays(today, i === 3 ? 18 : 250 + i * 25), verified_at: verified },
  ])));
  const drv = Object.fromEntries(drivers.map((d) => [d.name, d.id]));

  // Truck 207 is in the shop.
  await must("out of service", db.rpc("set_equipment_service_status", { p_kind: "truck", p_id: truck["207"], p_status: "out_of_service", p_reason: "Brake repair (demo)", p_expected_return: addDays(today, 2) }));

  // Orders: one hauling line per order, one load per trip.
  const lineOf = (code: "LH-LOAD" | "HAUL-HR", qty: string, rate: number, description: string) =>
    ({ kind: "hauling", calc_method: "per_unit", charge_item_id: charge[code], description, unit_code: code === "LH-LOAD" ? "load" : "hour", quantity: qty, unit_rate_cents: rate, taxable: false });
  async function order(c: number, date: string, project: string, lines: unknown[], instructions: string, end = date) {
    const o = (await must("order", db.rpc("save_order_draft", { p_payload: { customer_id: customers[c].id, order_date: date, project_name: project, job_instructions: instructions, site_label: CUSTOMERS[c].site, site_line1: CUSTOMERS[c].line1, site_city: CUSTOMERS[c].city, lines } }))) as { order_id: string };
    await must("confirm", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "confirmed", p_note: "" }));
    await must("schedule", db.rpc("update_order_schedule", { p_order_id: o.order_id, p_expected_edit_seq: null, p_payload: { scheduled_start: date, scheduled_end: end } }));
    await must("scheduled", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "scheduled", p_note: "" }));
    const lines2 = (await must("lines", db.from("order_lines").select("id").eq("order_id", o.order_id).order("line_no"))) as Array<{ id: string }>;
    return { id: o.order_id, lineId: lines2[0].id };
  }
  const load = async (orderId: string, date: string, start: string, end: string) =>
    ((await must("load", db.rpc("save_order_load", { p_payload: { order_id: orderId, load_date: date, start_time: start, end_time: end, planned_quantity: "1", unit_code: "load" } }))) as { load_id: string }).load_id;
  const assign = async (loadId: string, unit: string, trailerUnit: string | null, driver: string) =>
    ((await must("assign", db.rpc("assign_load", { p_load_id: loadId, p_truck_id: truck[unit], p_trailer_id: trailerUnit ? trailer[trailerUnit] : null, p_driver_id: drv[driver], p_note: "" }))) as { assignment_id: string }).assignment_id;
  const deliver = async (loadId: string, lineId: string, date: string, time: string, ref: string) => {
    const t = (await must("ticket", db.rpc("submit_delivery_ticket", { p_payload: { load_id: loadId, order_line_id: lineId, delivered_date: date, delivered_time: time, quantity: "1", unit_code: "load", external_reference: ref } }))) as { ticket_id: string };
    await must("review", db.rpc("review_delivery_ticket", { p_ticket_id: t.ticket_id, p_action: "accept", p_note: "" }));
  };

  // Past week: delivered and verified (4 loads).
  const d3 = addDays(today, -3);
  const d2 = addDays(today, -2);
  const past1 = await order(0, d3, "Bagged feed to Jasper Valley Grain", [lineOf("LH-LOAD", "2", 68000, "Linehaul, Lafayette → Rensselaer")], "Check in at the scale office. Forklift unloading only.");
  for (const [i, [unit, tr, driver, start, end, at]] of ([["201", "T-53", "Gavin Holt", "07:00", "10:00", "09:40"], ["202", "T-51", "Rosa Medina", "09:00", "12:00", "11:40"]] as const).entries()) {
    const l = await load(past1.id, d3, start, end);
    await assign(l, unit, tr, driver);
    await deliver(l, past1.lineId, d3, at, `PLF-${d3.replaceAll("-", "").slice(2)}-${i + 1}`);
  }
  const past2 = await order(3, d2, "Lumber to Kankakee Marsh Lumber", [lineOf("LH-LOAD", "2", 72000, "Linehaul, Monticello → DeMotte")], "Tarp the load. North gate closes at 15:00.");
  for (const [i, [unit, tr, driver, start, end, at]] of ([["203", "T-52", "Eli Sutter", "08:00", "11:00", "10:50"], ["205", "T-51", "Mateo Ruiz", "10:00", "13:00", "12:50"]] as const).entries()) {
    const l = await load(past2.id, d2, start, end);
    await assign(l, unit, tr, driver);
    await deliver(l, past2.lineId, d2, at, `PLF-${d2.replaceAll("-", "").slice(2)}-${i + 1}`);
  }

  // Today: four loads assigned (one with a delay report), one urgent load unassigned.
  const t1 = await order(2, today, "Pallets to Wabash Bend Packaging", [lineOf("LH-LOAD", "2", 64000, "Linehaul, Rensselaer → Lafayette")], "Dock 4. Call shipping 30 minutes out.");
  const la = await load(t1.id, today, "06:30", "09:30");
  const aa = await assign(la, "201", "T-53", "Gavin Holt");
  const lb = await load(t1.id, today, "10:00", "13:00");
  await assign(lb, "204", "T-53", "Kendra Price");
  const t2 = await order(4, today, "Equipment parts to Tippecanoe Fieldworks", [lineOf("HAUL-HR", "6", 11500, "Hourly hauling, two drops")], "Two drops: shop first, then the field office.");
  const lc = await load(t2.id, today, "08:00", "14:00");
  await assign(lc, "208", "T-51", "Darnell Hayes");
  const t3 = await order(6, today, "Building supplies to Newton Prairie Builders", [lineOf("LH-LOAD", "1", 58000, "Linehaul, Rensselaer → Kentland")], "Unload at the builders yard; forklift on site.");
  const ld = await load(t3.id, today, "12:00", "15:00");
  await assign(ld, "209", "T-52", "Lucy Tran");
  await must("delay report", db.rpc("driver_submit_field_report", { p_payload: { assignment_id: aa, kind: "delay", description: "About 30 minutes waiting at the shipper's dock (demo).", submission_key: randomUUID() } }));
  const t4 = await order(1, today, "Seed pallets to Iroquois River Farm Supply", [lineOf("LH-LOAD", "1", 52000, "Linehaul, Fowler → Remington")], "Customer moved the delivery to this afternoon.");
  await load(t4.id, today, "14:00", "17:00");
  await must("urgent", db.rpc("flag_order_urgent", { p_order_id: t4.id, p_reason: "Customer needs the seed before tomorrow's planting (demo)." }));

  // Tomorrow: planned (3 loads), two assigned and one open.
  const n1 = await order(5, tomorrow, "Feed ingredients to Benton County Seed & Feed", [lineOf("LH-LOAD", "2", 61000, "Linehaul, Rensselaer → Fowler")], "Weigh in and out at the co-op scale.");
  await assign(await load(n1.id, tomorrow, "06:00", "09:00"), "202", "T-51", "Rosa Medina");
  await assign(await load(n1.id, tomorrow, "09:30", "12:30"), "203", "T-52", "Eli Sutter");
  const n2 = await order(7, tomorrow, "Implement parts to Carroll County Implement", [lineOf("LH-LOAD", "1", 66000, "Linehaul, Rensselaer → Delphi")], "Deliver to the parts depot; signature required.");
  await load(n2.id, tomorrow, "07:00", "10:00");

  // People: drivers, office and shop staff, and the owner (no contact details invented).
  if (await installed(db, "employees")) {
    const titles = ["Driver — regional", "Driver — regional", "Driver — flatbed", "Driver — dry van", "Driver — flatbed", "Driver — regional", "Driver — local", "Driver — flatbed", "Driver — local", "Driver — relief"];
    const people = (await must("employees", db.from("employees").insert([
      { full_name: "Colby Chapman", job_title: "Owner", department: "management", employment_type: "full_time", status: "active", hire_date: null, driver_id: null, user_id: null, work_email: "", work_phone: "" },
      ...STAFF.map((s) => ({ full_name: s.full_name, job_title: s.job_title, department: s.department, employment_type: "full_time", status: "active", hire_date: addDays(today, s.hire), driver_id: null, user_id: null, work_email: "", work_phone: "" })),
      ...drivers.map((d, i) => ({ full_name: d.name, job_title: titles[i], department: "operations", employment_type: "full_time", status: "active", hire_date: addDays(today, -300 - i * 110), driver_id: d.id, user_id: null, work_email: "", work_phone: `(555) 010-02${10 + i}` })),
    ]).select("id, full_name"))) as Array<{ id: string; full_name: string }>;
    const emp = Object.fromEntries(people.map((p) => [p.full_name, p.id]));
    const primary: Record<string, string> = { "Gavin Holt": "201", "Rosa Medina": "202", "Eli Sutter": "203", "Kendra Price": "204", "Mateo Ruiz": "205", "Hannah Voss": "206", "Darnell Hayes": "208", "Lucy Tran": "209", "Wes Carver": "210" };
    for (const [name, unit] of Object.entries(primary)) await must("primary truck", db.rpc("set_driver_primary_truck", { p_driver_id: drv[name], p_truck_id: truck[unit] }));

    // Time off: approved leave next week, and a pending request.
    if (await installed(db, "time_off_requests")) {
      const approved = (await must("time off", db.rpc("time_off_save", { p: { employee_id: emp["Hannah Voss"], category: "vacation", start_date: addDays(today, 7), end_date: addDays(today, 9), reason: "" } }))) as { id: string };
      await must("approve", db.rpc("time_off_decide", { p_id: approved.id, p_decision: "approved", p_note: "Approved (demo)." }));
      await must("time off", db.rpc("time_off_save", { p: { employee_id: emp["Wes Carver"], category: "personal", start_date: addDays(today, 12), end_date: addDays(today, 12), reason: "" } }));
    }
  }

  // Maintenance: a safety-critical brake job on 207, a tire job on 206, preventive schedules.
  if (await installed(db, "work_orders")) {
    const wo = (p: Record<string, unknown>) => must("work order", db.rpc("maintenance_create_work_order", { p: { submission_key: randomUUID(), ...p } }));
    await wo({ truck_id: truck["207"], title: "Rear brake chamber leaking", category: "brakes", urgency: "immediate", safety_critical: true, description: "Found at the pre-trip inspection (demo)." });
    await wo({ truck_id: truck["206"], title: "Replace worn steer tires", category: "tires", urgency: "high", safety_critical: false, description: "Tread near the limit on both steer tires (demo)." });
    await wo({ truck_id: truck["210"], title: "Dash warning light intermittent", category: "electrical", urgency: "normal", safety_critical: false, description: "" });
    for (const [i, t] of TRUCKS.entries()) {
      await must("schedule", db.rpc("maintenance_save_schedule", { p: { truck_id: truck[t.unit], name: "Oil and filter", interval_days: 90, interval_miles: 15000, warn_days: 14, warn_miles: 1000, last_done_on: addDays(today, -20 - i * 9) } }));
    }
    await must("schedule", db.rpc("maintenance_save_schedule", { p: { truck_id: truck["204"], name: "Annual inspection", interval_days: 365, warn_days: 30, last_done_on: addDays(today, -350) } }));
  }

  // Vehicle documents (titles and references are placeholders, not real registrations).
  if (await installed(db, "vehicle_documents")) {
    await must("documents", db.from("vehicle_documents").insert([
      ...TRUCKS.map((t, i) => ({ truck_id: truck[t.unit], kind: "registration", title: "Registration", reference_number: `DEMO-REG-${t.unit}`, issuing_authority: "Demo record", expires_on: addDays(today, i === 5 ? 21 : 120 + i * 20), submission_key: randomUUID() })),
      { truck_id: truck["204"], kind: "inspection", title: "Annual inspection", reference_number: "DEMO-INSP-204", issuing_authority: "Demo record", expires_on: addDays(today, 15), submission_key: randomUUID() },
      { trailer_id: trailer["T-53"], kind: "registration", title: "Trailer registration", reference_number: "DEMO-REG-T53", issuing_authority: "Demo record", expires_on: addDays(today, -4), submission_key: randomUUID() },
    ]));
  }
}
