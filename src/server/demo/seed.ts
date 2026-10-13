import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, todayIn } from "@/lib/dates";
import { NORTHFIELD_LOGO_PNG_BASE64 } from "./northfield-logo";
import { ensureFeatureSamples } from "./samples";

/**
 * Fills a freshly started demo company with fictional data, through the same
 * database functions and row-level security the app uses — as the platform
 * admin, who is the demo company's owner. Never runs against any other
 * company: the caller has just been switched into the new demo company, and
 * every row is created by functions that write only to the current company.
 *
 * Everything here is invented: names, places, phone numbers, quantities.
 */
type Db = SupabaseClient;

async function must<T>(label: string, p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`Demo set-up failed at "${label}": ${error.message}`);
  return data;
}

const MATERIALS = [
  { code: "LS-53", name: "#53 limestone base", unit: "ton", rate: 1450 },
  { code: "ST-8", name: "#8 washed stone", unit: "ton", rate: 1825 },
  { code: "SND-F", name: "Fill sand", unit: "ton", rate: 975 },
  { code: "TS-SC", name: "Screened topsoil", unit: "cu_yd", rate: 3200 },
  { code: "RR-3", name: "3\" riprap", unit: "ton", rate: 2600 },
  { code: "HAUL-HR", name: "Hourly hauling", unit: "hour", rate: 11500 },
];

const CUSTOMERS = [
  { name: "Cedar Ridge Builders (demo)", city: "Maple Falls", site: "Cedar Ridge phase 3, lot 14–22", line1: "100 Demo Ridge Rd" },
  { name: "Kestrel Paving Co. (demo)", city: "Ashford", site: "County Rd 9 widening", line1: "9 Example Pkwy" },
  { name: "Brightwater Landscapes (demo)", city: "Linden Grove", site: "Brightwater office park", line1: "45 Sample Ave" },
  { name: "Ironbridge Utilities (demo)", city: "Maple Falls", site: "Water main replacement, 4th St", line1: "400 Fictional Blvd" },
  { name: "Harlow Homes (demo)", city: "Ashford", site: "Harlow Meadows model homes", line1: "12 Placeholder Ln" },
  { name: "Lakeview Township Public Works (demo)", city: "Lakeview", site: "Township salt dome pad", line1: "7 Civic Example Dr" },
  { name: "Summit Ready-Mix (demo)", city: "Linden Grove", site: "Summit batch plant stockpile", line1: "88 Sample Quarry Rd" },
  { name: "Oakmont School District (demo)", city: "Maple Falls", site: "Oakmont Elementary parking lot", line1: "310 Fictional School Way" },
];

/** The person the platform team member is shown as inside the demo (never their real account name). */
export const DEMO_PERSONA = { name: "Daniel Mitchell", title: "Operations Manager (also drives relief)" };

/** Office, dispatch and shop staff without Taviron logins — directory entries only. */
const STAFF = [
  { full_name: "Rachel Ortiz", job_title: "Dispatcher", department: "dispatch", hire: -1400, pay: { pay_type: "hourly", rate_cents: 3150 } },
  { full_name: "Sam Kowalski", job_title: "Lead mechanic", department: "shop", hire: -2100, pay: { pay_type: "hourly", rate_cents: 3600 } },
  { full_name: "Jordan Feld", job_title: "Mechanic", department: "shop", hire: -500, pay: { pay_type: "hourly", rate_cents: 2900 } },
  { full_name: "Lena Park", job_title: "Office & billing manager", department: "office", hire: -1800, pay: { pay_type: "salary", rate_cents: 6400000 } },
  { full_name: "Owen Brooks", job_title: "Seasonal yard hand", department: "operations", hire: -120, pay: { pay_type: "hourly", rate_cents: 2100 }, type: "seasonal" },
];

const TRUCKS = [
  { unit: "101", type: "tri_axle_dump", make: "Western Star", model: "47X" },
  { unit: "102", type: "tri_axle_dump", make: "Kenworth", model: "T880" },
  { unit: "103", type: "tandem_axle_dump", make: "Mack", model: "Granite" },
  { unit: "104", type: "tandem_axle_dump", make: "Peterbilt", model: "567" },
  { unit: "105", type: "quad_axle_dump", make: "Kenworth", model: "T880" },
  { unit: "106", type: "tri_axle_dump", make: "International", model: "HX" },
  { unit: "107", type: "single_axle_dump", make: "Freightliner", model: "M2 106" },
];

const DRIVERS = ["Avery Lindqvist", "Marco Delgado", "Priya Raman", "Theo Brandt", "Nia Okafor"];

export async function seedDemoCompany(db: Db, userId: string, timeZone: string): Promise<void> {
  const today = todayIn(timeZone);
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const lastWeek = addDays(today, -6);

  // Company identity and branding (fictional; 555-01xx numbers are reserved for fiction).
  await must("company settings", db.from("company_settings").update({
    company_name: "Northfield Aggregates", address_line1: "2200 Quarry Line Rd", city: "Maple Falls", state: "", postal_code: "",
    phone: "(555) 010-0140", email: "dispatch@northfield.demo.example", website: "",
    brand_logo: `data:image/png;base64,${NORTHFIELD_LOGO_PNG_BASE64}`, brand_color: "#2E6B4E", brand_sidebar_color: "#14231C",
  }).not("company_id", "is", null).select("company_id"));

  // Catalog and rates.
  const materials = await must("materials", db.from("materials").insert(MATERIALS.filter((m) => m.unit !== "hour").map((m) => ({ code: m.code, name: m.name, default_unit_code: m.unit, description: "Demo item (fictional)." }))).select("id, code"));
  const mat = Object.fromEntries((materials as Array<{ id: string; code: string }>).map((m) => [m.code, m.id]));
  const list = await must("price list", db.from("price_lists").select("id").eq("is_standard", true).single());
  await must("rates", db.from("price_list_entries").insert(
    MATERIALS.filter((m) => mat[m.code]).map((m) => ({ price_list_id: (list as { id: string }).id, material_id: mat[m.code], unit_code: m.unit, rate_cents: m.rate, effective_from: addDays(today, -60), notes: "Demo rate (fictional)" })),
  ));

  // Customers with a job site each.
  const customers = await must("customers", db.from("customers").insert(CUSTOMERS.map((c, i) => ({
    name: c.name, email: `office${i + 1}@demo.example`, phone: `555-010${i}`, billing_line1: c.line1, billing_city: c.city, billing_state: "", payment_terms: "Net 30", po_required: i === 1,
  }))).select("id, name"));
  const cust = customers as Array<{ id: string; name: string }>;
  await must("sites", db.from("customer_sites").insert(cust.map((c, i) => ({ customer_id: c.id, label: CUSTOMERS[i].site, line1: CUSTOMERS[i].line1, city: CUSTOMERS[i].city, state: "" }))));

  // Fleet and drivers. The platform admin is linked to one driver record so the
  // driver preview shows a real portal.
  const trucks = await must("trucks", db.from("trucks").insert(TRUCKS.map((t) => ({ unit_number: t.unit, truck_type: t.type, make: t.make, model: t.model, weight_capacity: t.type === "single_axle_dump" ? 8 : t.type === "tandem_axle_dump" ? 15 : 22, weight_unit: "ton", capacity_verified_at: new Date().toISOString() }))).select("id, unit_number"));
  const truck = Object.fromEntries((trucks as Array<{ id: string; unit_number: string }>).map((t) => [t.unit_number, t.id]));
  const drivers = await must("drivers", db.from("drivers").insert([
    // Every row has the same keys: a bulk insert fills missing keys with null.
    ...DRIVERS.map((name, i) => ({ name, employee_number: `D-${201 + i}`, phone: `555-020${i}`, hire_date: addDays(today, -400 - i * 90), user_id: null, notes: "" })),
    { name: DEMO_PERSONA.name, employee_number: "D-299", phone: "(555) 010-0299", hire_date: addDays(today, -2600), user_id: userId, notes: "Demo persona of the person presenting the demo; drives relief shifts." },
  ]).select("id, name"));
  const drv = drivers as Array<{ id: string; name: string }>;
  const verified = new Date().toISOString();
  await must("qualifications", db.from("driver_qualifications").insert(drv.flatMap((d, i) => [
    { driver_id: d.id, kind: "cdl", cdl_class: "A", expires_on: addDays(today, 500 + i * 30), verified_at: verified },
    // One medical card expires soon, so the reminder shows.
    { driver_id: d.id, kind: "medical_card", expires_on: addDays(today, i === 2 ? 12 : 300 + i * 20), verified_at: verified },
  ])));
  const me = drv.find((d) => d.name === DEMO_PERSONA.name)!.id;
  const [avery, marco, priya, theo, nia] = drv.map((d) => d.id);
  await must("out of service", db.rpc("set_equipment_service_status", { p_kind: "truck", p_id: truck["106"], p_status: "out_of_service", p_reason: "Brake inspection (demo)", p_expected_return: tomorrow }));

  // Orders.
  const line = (code: string, quantity: string) => {
    const m = MATERIALS.find((x) => x.code === code)!;
    return { kind: "material", calc_method: "per_unit", material_id: mat[code], description: m.name, unit_code: m.unit, quantity, unit_rate_cents: m.rate, taxable: true };
  };
  async function order(customer: number, date: string, project: string, lines: unknown[], instructions: string, schedule: [string, string] | null) {
    const o = (await must("order", db.rpc("save_order_draft", { p_payload: { customer_id: cust[customer].id, order_date: date, project_name: project, job_instructions: instructions, site_label: CUSTOMERS[customer].site, site_line1: CUSTOMERS[customer].line1, site_city: CUSTOMERS[customer].city, lines } }))) as { order_id: string; order_number: string };
    if (schedule) {
      await must("confirm", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "confirmed", p_note: "" }));
      await must("schedule", db.rpc("update_order_schedule", { p_order_id: o.order_id, p_expected_edit_seq: null, p_payload: { scheduled_start: schedule[0], scheduled_end: schedule[1] } }));
      await must("scheduled", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "scheduled", p_note: "" }));
    }
    const lines2 = (await must("lines", db.from("order_lines").select("id").eq("order_id", o.order_id).order("line_no"))) as Array<{ id: string }>;
    return { ...o, lineId: lines2[0]?.id };
  }
  async function load(orderId: string, date: string, start: string, end: string, qty: string, unit = "ton") {
    return ((await must("load", db.rpc("save_order_load", { p_payload: { order_id: orderId, load_date: date, start_time: start, end_time: end, planned_quantity: qty, unit_code: unit } }))) as { load_id: string }).load_id;
  }
  const assign = async (loadId: string, truckId: string, driverId: string) =>
    ((await must("assign", db.rpc("assign_load", { p_load_id: loadId, p_truck_id: truckId, p_trailer_id: null, p_driver_id: driverId, p_note: "" }))) as { assignment_id: string }).assignment_id;
  const ticket = async (loadId: string, lineId: string, date: string, time: string, qty: string, ref: string) =>
    ((await must("ticket", db.rpc("submit_delivery_ticket", { p_payload: { load_id: loadId, order_line_id: lineId, delivered_date: date, delivered_time: time, quantity: qty, unit_code: "ton", external_reference: ref } }))) as { ticket_id: string }).ticket_id;
  const review = (id: string, action: "accept" | "flag", note = "") => must("review", db.rpc("review_delivery_ticket", { p_ticket_id: id, p_action: action, p_note: note }));

  // 0. The past two weeks of deliveries (each driver on their usual truck), so My Day, Reports and
  // billing have history. Mostly accepted tickets; a few flagged or still waiting for review.
  const crews: Array<[string, string]> = [["101", avery], ["102", marco], ["103", me], ["104", theo], ["105", priya], ["107", nia]];
  for (let back = 14, n = 0; back >= 7; back--) {
    const day = addDays(today, -back);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekdays only
    const c = 5 + (n % 3);
    const product = ["LS-53", "ST-8", "SND-F", "RR-3"][n % 4];
    const o = await order(c, day, `${CUSTOMERS[c].site} — ${MATERIALS.find((m) => m.code === product)!.name}`, [line(product, "60")], "Check in at the scale house on arrival.", [day, day]);
    for (let k = 0; k < 3; k++) {
      const [unit, driver] = crews[(n + k) % crews.length];
      const cap = unit === "107" ? 8 : unit === "103" || unit === "104" ? 15 : 20;
      const l = await load(o.order_id, day, `${String(7 + k * 2).padStart(2, "0")}:00`, `${String(8 + k * 2).padStart(2, "0")}:15`, String(cap));
      await assign(l, truck[unit], driver);
      const qty = (cap - 0.4 + ((n + k) % 3) * 0.2).toFixed(2);
      const t = await ticket(l, o.lineId, day, `${String(8 + k * 2).padStart(2, "0")}:05`, qty, `NF-${day.replaceAll("-", "").slice(2)}-${k + 1}`);
      if ((n + k) % 7 === 3) await review(t, "flag", "Scale weight and ticket copy differ — check the scale ticket (demo).");
      else if (back > 8 || k < 2) await review(t, "accept");
    }
    n++;
  }

  // 1. Last week: delivered and verified, but each ticket is a little under the planned 22 t, so billing shows
  //    quantity exceptions to acknowledge. (Ready to bill and Handed off come from samples.ts billing().)
  const o1 = await order(1, lastWeek, "County Rd 9 widening — base course", [line("LS-53", "88")], "Spread on the east shoulder; flagger at the north end.", [lastWeek, lastWeek]);
  for (const [i, t] of [["101", avery], ["102", marco], ["105", priya], ["101", theo]].entries()) {
    const l = await load(o1.order_id, lastWeek, `0${7 + i}:00`, `0${7 + i}:45`, "22");
    await assign(l, truck[t[0]], t[1]);
    await review(await ticket(l, o1.lineId, lastWeek, `0${7 + i}:35`, (21.6 + i * 0.2).toFixed(2), `KP-4410${i}`), "accept");
  }

  // 2. Yesterday: tickets waiting for review, one flagged.
  const o2 = await order(0, yesterday, "Cedar Ridge phase 3 — pad prep", [line("SND-F", "66")], "Use the Oak St entrance. Dump at the marked pads only.", [yesterday, today]);
  const y = [];
  for (const [i, t] of [["101", avery], ["105", marco], ["102", priya]].entries()) {
    const l = await load(o2.order_id, yesterday, `${10 + i}:00`, `${10 + i}:50`, "22");
    await assign(l, truck[t[0]], t[1]);
    y.push(await ticket(l, o2.lineId, yesterday, `${10 + i}:40`, i === 2 ? "14.10" : (22.1 - i * 0.3).toFixed(2), `CR-77${i}1`));
  }
  await review(y[0], "accept");
  await review(y[2], "flag", "Quantity well under the planned load — confirm with the scale ticket.");

  // 3. Today: in progress, one load for the driver preview.
  const o3 = await order(3, today, "4th St water main — bedding stone", [line("ST-8", "44")], "Call the site foreman 30 minutes out. No trucks on 4th St before 7:00.", [today, today]);
  // Tandems carry 15 t (assigning more than a truck's recorded capacity is refused).
  const l3a = await load(o3.order_id, today, "07:30", "08:30", "15");
  const a3 = await assign(l3a, truck["103"], me);
  const l3b = await load(o3.order_id, today, "09:00", "10:00", "15");
  await assign(l3b, truck["104"], theo);
  await must("delay report", db.rpc("driver_submit_field_report", { p_payload: { assignment_id: a3, kind: "delay", description: "Waiting about 25 minutes at the quarry scale (demo).", submission_key: randomUUID() } }));

  // 4. Today: urgent, a load still unassigned.
  const o4 = await order(2, today, "Brightwater office park — topsoil", [line("TS-SC", "36")], "Deliver behind building B. Landscaping crew on site from 8:00.", [today, today]);
  await load(o4.order_id, today, "13:00", "14:00", "12", "cu_yd");
  await must("urgent", db.rpc("flag_order_urgent", { p_order_id: o4.order_id, p_reason: "Customer moved the planting crew to this afternoon (demo)." }));

  // 5. Tomorrow: planned, not yet assigned.
  const o5 = await order(4, tomorrow, "Harlow Meadows — driveway base", [line("LS-53", "66")], "Model homes 1–3. Keep the sidewalk clear.", [tomorrow, tomorrow]);
  for (const [s, e] of [["07:00", "08:00"], ["08:30", "09:30"], ["10:00", "11:00"]]) await load(o5.order_id, tomorrow, s, e, "22");

  // 6. A draft order and a draft quote.
  await order(1, tomorrow, "County Rd 9 — shoulder stone (draft)", [line("RR-3", "40")], "", null);
  await must("quote", db.rpc("save_quote_draft", { p_payload: {
    customer_id: cust[4].id, quote_date: today, valid_until: addDays(today, 30), tax_rate_bp: 0, site_label: CUSTOMERS[4].site, site_line1: CUSTOMERS[4].line1, site_city: CUSTOMERS[4].city,
    lines: [line("LS-53", "220"), line("TS-SC", "80")],
  } }));

  await seedPeople(db, { userId, today, drivers: drv, truck, primary: { [avery]: "101", [marco]: "102", [me]: "103", [theo]: "104", [priya]: "105", [nia]: "107" } });
  // Every released feature has sample data in every demo mode (maintenance, documents, time off, workspaces, …).
  await ensureFeatureSamples(db, today);
}

/**
 * Employees, primary trucks and (confidential) pay for the demo. Needs the
 * employees migration (20261031000100); on a database without it the rest of
 * the demo still works and this step is skipped.
 */
/** Which illustrated avatar (public/avatars) each demo person uses — matched to their job. */
const AVATARS: Record<string, string> = {
  "Daniel Mitchell": "avatar-08", "Avery Lindqvist": "avatar-01", "Marco Delgado": "avatar-12", "Priya Raman": "avatar-03",
  "Theo Brandt": "avatar-19", "Nia Okafor": "avatar-15", "Rachel Ortiz": "avatar-07", "Sam Kowalski": "avatar-04",
  "Jordan Feld": "avatar-13", "Lena Park": "avatar-09", "Owen Brooks": "avatar-10",
};

async function seedPeople(db: Db, p: { userId: string; today: string; drivers: Array<{ id: string; name: string }>; truck: Record<string, string>; primary: Record<string, string> }) {
  const probe = await db.from("employees").select("id").limit(1);
  if (probe.error) return; // not migrated yet
  const titles: Record<string, string> = { "Avery Lindqvist": "Driver — tri-axle", "Marco Delgado": "Driver — tri-axle", "Priya Raman": "Driver — quad-axle", "Theo Brandt": "Driver — tandem", "Nia Okafor": "Driver — single-axle" };
  const rows = p.drivers.map((d, i) => d.name === DEMO_PERSONA.name
    ? { full_name: d.name, job_title: DEMO_PERSONA.title, department: "management", employment_type: "full_time", status: "active", hire_date: addDays(p.today, -2600), driver_id: d.id, user_id: p.userId, work_email: "daniel.mitchell@northfield.demo.example", work_phone: "(555) 010-0299" }
    : { full_name: d.name, job_title: titles[d.name] ?? "Driver", department: "operations", employment_type: "full_time", status: i === 4 ? "on_leave" : "active", hire_date: addDays(p.today, -400 - i * 90), driver_id: d.id, user_id: null, work_email: "", work_phone: `(555) 010-020${i}` });
  const staff = STAFF.map((s) => ({ full_name: s.full_name, job_title: s.job_title, department: s.department, employment_type: s.type ?? "full_time", status: "active", hire_date: addDays(p.today, s.hire), driver_id: null, user_id: null, work_email: "", work_phone: "" }));
  // Avatars need migration 20261031000300; without it the people are added without one.
  const withAvatars = !(await db.from("employees").select("avatar_key").limit(1)).error;
  const all = [...rows, ...staff].map((r) => (withAvatars ? { ...r, avatar_key: AVATARS[r.full_name] ?? "" } : r));
  const people = (await must("employees", db.from("employees").insert(all).select("id, full_name"))) as Array<{ id: string; full_name: string }>;
  for (const [driverId, unit] of Object.entries(p.primary)) {
    await must("primary truck", db.rpc("set_driver_primary_truck", { p_driver_id: driverId, p_truck_id: p.truck[unit] }));
  }
  const byName = new Map(people.map((x) => [x.full_name, x.id]));
  await must("pay", db.from("employee_compensation").insert([
    ...STAFF.map((s) => ({ employee_id: byName.get(s.full_name)!, pay_type: s.pay.pay_type, rate_cents: s.pay.rate_cents, effective_date: addDays(p.today, -90) })),
    ...["Avery Lindqvist", "Marco Delgado", "Priya Raman", "Theo Brandt"].map((n, i) => ({ employee_id: byName.get(n)!, pay_type: "per_load", rate_cents: 7800 + i * 250, effective_date: addDays(p.today, -90) })),
  ]));
}
