import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "@/lib/dates";
import { demoAssign } from "./assign";

/**
 * Personal touches for Colby Chapman's own demo, Prairie Lantern Freight (owner request 2026-10-14). Colby is not a
 * trucking customer: he is a friend following Taviron's progress, from Rensselaer, Indiana, studying in Southfield,
 * Michigan, who lived in Sarasota last year and plays basketball. The demo company stays fictional; these samples only
 * nod to his places and interests:
 *
 * - a regular long-haul lane from Rensselaer to Southfield, MI (where he studies);
 * - a seasonal run to Sarasota, FL (where he lived);
 * - a gym-floor customer hauling hardwood court panels and bleachers (basketball);
 * - Cam Webster, a friend of his, as one of the drivers — the one real name in the demo, added at the owner's request
 *   (docs/DEMO_TENANTS.md §2). Customers and businesses are invented; towns are used only as locations.
 *
 * Shared by the seed and Refresh demo data; idempotent (each record is added only when missing, each order only when its
 * customer has none) and additive: it never changes or deletes anything. Only ever called inside the Prairie Lantern
 * demo (the callers switch into it first; samples.ts refuses non-demo companies for the shared samples).
 */
type Db = SupabaseClient;

async function must<T>(label: string, p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`Demo samples (${label}): ${error.message}`);
  return data;
}

export const COLBY_CUSTOMERS = [
  { name: "Southfield Crossing Distribution", city: "Southfield", state: "MI", site: "Receiving, dock 6", line1: "2100 Example Commerce Dr" },
  { name: "Gulfbreeze Nursery & Landscape Supply", city: "Sarasota", state: "FL", site: "Nursery yard, gate B", line1: "88 Palmetto Example Rd" },
  { name: "Fieldhouse Hardwood Courts", city: "Lafayette", state: "IN", site: "Court shop, bay 2", line1: "14 Baseline Example Way" },
];

export const CAM_WEBSTER = { name: "Cam Webster", title: "Driver — long haul", avatar: "avatar-02" };

/** Rates are fictional demo values, like every other lane in this demo. */
const LANES = [
  { customer: 0, project: "Freight to Southfield Crossing", lane: "Linehaul, Rensselaer → Southfield, MI", rate: 185000, note: "Long haul, about 4½ hours. Check in at the guard shack; dock 6 receives until 15:00.", when: 1, start: "05:00", end: "11:00", crew: ["210", "T-53"] as const },
  { customer: 2, project: "Hardwood court panels and bleachers", lane: "Linehaul, Lafayette → Rensselaer", rate: 64000, note: "Gym floor panels: keep dry, tarp the load. Bleacher sections ride on the second deck.", when: -1, start: "07:00", end: "10:00", crew: ["206", "T-52"] as const },
  { customer: 1, project: "Seasonal run to Gulfbreeze Nursery", lane: "Linehaul, Rensselaer → Sarasota, FL (two days)", rate: 520000, note: "Two-day run; overnight on the way. Nursery yard opens at 07:00, gate B.", when: 5, start: "05:00", end: "18:00", crew: null },
];

export async function ensureColbySamples(db: Db, today: string): Promise<number> {
  let added = 0;

  // Customers (invented businesses in real towns).
  const existing = (await must("customers", db.from("customers").select("id, name"))) as Array<{ id: string; name: string }>;
  const cust = new Map(existing.map((c) => [c.name, c.id]));
  const missing = COLBY_CUSTOMERS.filter((c) => !cust.has(c.name));
  if (missing.length) {
    const rows = (await must("customers", db.from("customers").insert(missing.map((c) => ({
      name: c.name, email: `shipping@${c.name.toLowerCase().replace(/[^a-z]+/g, "")}.example`, phone: "", billing_line1: c.line1, billing_city: c.city, billing_state: c.state, payment_terms: "Net 30", po_required: false,
    }))).select("id, name"))) as Array<{ id: string; name: string }>;
    await must("sites", db.from("customer_sites").insert(rows.map((r) => {
      const c = COLBY_CUSTOMERS.find((x) => x.name === r.name)!;
      return { customer_id: r.id, label: c.site, line1: c.line1, city: c.city, state: c.state };
    })));
    for (const r of rows) cust.set(r.name, r.id);
    added += rows.length;
  }

  // Cam Webster: a driver with qualifications and an employee record.
  let cam = ((await must("driver", db.from("drivers").select("id").eq("name", CAM_WEBSTER.name).maybeSingle())) as { id: string } | null)?.id;
  if (!cam) {
    cam = ((await must("driver", db.from("drivers").insert({ name: CAM_WEBSTER.name, employee_number: "D-311", phone: "", hire_date: addDays(today, -240), user_id: null, notes: "" }).select("id").single())) as { id: string }).id;
    const verified = new Date().toISOString();
    await must("qualifications", db.from("driver_qualifications").insert([
      { driver_id: cam, kind: "cdl", cdl_class: "A", expires_on: addDays(today, 700), verified_at: verified },
      { driver_id: cam, kind: "medical_card", expires_on: addDays(today, 410), verified_at: verified },
    ]));
    added++;
  }
  const emp = await db.from("employees").select("id").eq("full_name", CAM_WEBSTER.name).maybeSingle();
  if (!emp.error && !emp.data) {
    const row: Record<string, unknown> = { full_name: CAM_WEBSTER.name, job_title: CAM_WEBSTER.title, department: "operations", employment_type: "full_time", status: "active", hire_date: addDays(today, -240), driver_id: cam, user_id: null, work_email: "", work_phone: "" };
    const withAvatar = !(await db.from("employees").select("avatar_key").limit(1)).error;
    await must("employee", db.from("employees").insert(withAvatar ? { ...row, avatar_key: CAM_WEBSTER.avatar } : row));
    added++;
  }

  // One order per lane, only when that customer has none yet.
  const charge = ((await must("charge item", db.from("charge_items").select("id").eq("code", "LH-LOAD").maybeSingle())) as { id: string } | null)?.id;
  if (!charge) return added;
  const truck = new Map(((await must("trucks", db.from("trucks").select("id, unit_number"))) as Array<{ id: string; unit_number: string }>).map((t) => [t.unit_number, t.id]));
  const trailer = new Map(((await must("trailers", db.from("trailers").select("id, unit_number"))) as Array<{ id: string; unit_number: string }>).map((t) => [t.unit_number, t.id]));
  for (const lane of LANES) {
    const c = COLBY_CUSTOMERS[lane.customer];
    const customerId = cust.get(c.name);
    if (!customerId) continue;
    const { count } = await db.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", customerId);
    if ((count ?? 0) > 0) continue;
    const date = addDays(today, lane.when);
    const end = lane.when === 5 ? addDays(date, 1) : date; // the Sarasota run takes two days
    const o = (await must("order", db.rpc("save_order_draft", { p_payload: {
      customer_id: customerId, order_date: lane.when < 0 ? date : today, project_name: lane.project, job_instructions: lane.note, site_label: c.site, site_line1: c.line1, site_city: c.city,
      lines: [{ kind: "hauling", calc_method: "per_unit", charge_item_id: charge, description: lane.lane, unit_code: "load", quantity: "1", unit_rate_cents: lane.rate, taxable: false }],
    } }))) as { order_id: string };
    await must("confirm", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "confirmed", p_note: "" }));
    await must("schedule", db.rpc("update_order_schedule", { p_order_id: o.order_id, p_expected_edit_seq: null, p_payload: { scheduled_start: date, scheduled_end: end } }));
    await must("scheduled", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "scheduled", p_note: "" }));
    const loadId = ((await must("load", db.rpc("save_order_load", { p_payload: { order_id: o.order_id, load_date: date, start_time: lane.start, end_time: lane.end, planned_quantity: "1", unit_code: "load" } }))) as { load_id: string }).load_id;
    added++;
    // The Sarasota run stays open for the dispatcher to plan; the others are Cam's.
    if (!lane.crew || !truck.has(lane.crew[0])) continue;
    const a = await demoAssign(db, { p_load_id: loadId, p_truck_id: truck.get(lane.crew[0]), p_trailer_id: trailer.get(lane.crew[1]) ?? null, p_driver_id: cam, p_note: "" });
    if (a.error || lane.when >= 0) continue; // refused by the rules, or not delivered yet
    const lineId = ((await must("lines", db.from("order_lines").select("id").eq("order_id", o.order_id).order("line_no"))) as Array<{ id: string }>)[0].id;
    const t = await db.rpc("submit_delivery_ticket", { p_payload: { load_id: loadId, order_line_id: lineId, delivered_date: date, delivered_time: "09:40", quantity: "1", unit_code: "load", external_reference: `PLF-${date.replaceAll("-", "").slice(2)}-CW` } });
    if (!t.error) await db.rpc("review_delivery_ticket", { p_ticket_id: (t.data as { ticket_id: string }).ticket_id, p_action: "accept", p_note: "" });
  }
  return added;
}
