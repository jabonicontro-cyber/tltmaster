import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "@/lib/dates";

// Feature sample data shared by every demo (presenter seed, prospect seed and Refresh demo data), so each
// released feature is demonstrable in every demo mode and existing demos receive it without being recreated
// (CLAUDE.md, docs/DEMO_TENANTS.md §3 and §5).
//
// Rules:
// - Only in a demo company: refuses unless the caller's active company has is_demo (never a customer tenant).
// - Idempotent: each feature's samples are added only when that feature has no records in the company yet, so a
//   second run adds nothing and the prospect's own work is never changed or deleted.
// - Real feature paths only: the same database functions the app uses (permissions and rules apply). A refusal
//   by the rules (leave, shop, conflict) is left as it is, as it would be for a person.
// - Fictional only: no real names, plates, VINs, DOT/MC numbers or contact details. Rates come from the demo's own
//   order lines, never invented here.
// - A feature whose database update is not installed is skipped (its page shows "not available yet").

type Db = SupabaseClient;

export interface SampleResult {
  added: number;
  features: string[];
}

const MISSING = new Set(["42P01", "PGRST202", "PGRST205", "42883", "PGRST200"]);
const missing = (e: { code?: string } | null) => Boolean(e && e.code && MISSING.has(e.code));

async function must<T>(label: string, p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`Demo samples (${label}): ${error.message}`);
  return data;
}

/** Number of rows the caller can see in a table, or null when the table is not installed. */
async function count(db: Db, table: string): Promise<number | null> {
  const { count: n, error } = await db.from(table).select("company_id", { count: "exact", head: false }).limit(1);
  if (missing(error)) return null;
  if (error) throw new Error(`Demo samples (${table}): ${error.message}`);
  return n ?? 0;
}

/** The caller and their current company, which must be a demo (resolved by the database from the token). */
async function demoCompany(db: Db): Promise<{ userId: string; companyId: string }> {
  const { data, error } = await db.rpc("my_access");
  const a = data as { user_id?: string; company_id?: string | null } | null;
  if (error || !a?.user_id || !a.company_id) throw new Error("Demo samples: no signed-in person with a current company.");
  const { data: c } = await db.from("companies").select("is_demo").eq("id", a.company_id).maybeSingle();
  if (!(c as { is_demo?: boolean } | null)?.is_demo) throw new Error("Demo samples are only added to demo companies.");
  return { userId: a.user_id, companyId: a.company_id };
}

/** Add every feature's samples that the demo does not have yet. Safe to run on every Refresh. */
export async function ensureFeatureSamples(db: Db, today: string): Promise<SampleResult> {
  const { userId } = await demoCompany(db);
  const result: SampleResult = { added: 0, features: [] };
  const note = (feature: string, n: number) => { if (n > 0) { result.added += n; result.features.push(feature); } };
  const trucks = ((await db.from("trucks").select("id, unit_number").eq("active", true).order("unit_number")).data ?? []) as Array<{ id: string; unit_number: string }>;
  note("maintenance", await maintenance(db, today, trucks));
  note("vehicle documents", await documents(db, today, trucks));
  note("driver day for the demo owner", await ownerDriverDay(db, today));
  note("time off", await timeOff(db, today));
  note("quotes", await quotes(db, today));
  note("issued quote", await issuedQuote(db, today));
  note("operational workspace", await workspace(db, today, userId));
  note("assigned attention item", await assignedItem(db, userId));
  note("planning day", await planningDay(db, today));
  note("billing: ready and handed off", await billing(db, today));
  return result;
}

/**
 * Billing (docs/IMPLEMENTATION_PLAN.md §5k): the Ready to bill and Handed off views need an order delivered exactly as
 * ordered. When the demo has neither, two small past orders are created through the real paths — order, schedule,
 * loads, assignment, tickets entered and accepted — copying a per-unit line (rate included) from the demo's own
 * orders, for a customer that needs no PO. The second is handed off to billing (an internal batch: nothing is sent,
 * exported or invoiced). A second run adds nothing while any order is ready or handed off.
 */
async function billing(db: Db, today: string): Promise<number> {
  const status = await db.from("billing_order_status").select("readiness").in("readiness", ["ready", "handed_off"]).limit(1);
  if (missing(status.error)) return 0;
  if (status.error) throw new Error(`Demo samples (billing): ${status.error.message}`);
  if ((status.data ?? []).length) return 0;
  type Line = { kind: string; calc_method: string; material_id: string | null; description: string; unit_code: string | null; unit_rate_cents: number; taxable: boolean };
  type Tmpl = { customer_id: string; site_label: string | null; site_line1: string | null; site_city: string | null; customers: { po_required: boolean } | null; order_lines: Line[] };
  const candidates = ((await must("billing template", db.from("orders")
    .select("customer_id, site_label, site_line1, site_city, customers(po_required), order_lines(kind, calc_method, material_id, description, unit_code, unit_rate_cents, taxable)")
    .not("site_line1", "is", null).order("order_number").limit(40))) as unknown as Tmpl[]);
  const tmpl = candidates.find((o) => o.customers && !o.customers.po_required && o.order_lines.some((l) => l.calc_method === "per_unit" && l.unit_code && Number(l.unit_rate_cents) > 0));
  if (!tmpl) return 0;
  const src = tmpl.order_lines.find((l) => l.calc_method === "per_unit" && l.unit_code && Number(l.unit_rate_cents) > 0)!;
  const qty = 12;
  const trucks = ((await db.from("trucks").select("id").eq("active", true).eq("service_status", "in_service").order("unit_number")).data ?? []) as Array<{ id: string }>;
  const drivers = ((await db.from("drivers").select("id").eq("active", true).order("name")).data ?? []) as Array<{ id: string }>;
  const trailers = [null, ...(((await db.from("trailers").select("id").eq("active", true).eq("service_status", "in_service").order("unit_number")).data ?? []) as Array<{ id: string }>).map((t) => t.id)];
  let n = 0;
  for (const [i, back] of [4, 6].entries()) {
    let day = addDays(today, -back);
    while ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) day = addDays(day, -1); // a weekday
    const o = (await must("billing order", db.rpc("save_order_draft", { p_payload: {
      customer_id: tmpl.customer_id, order_date: day, project_name: `${tmpl.site_label ?? "Site"} — ${src.description}`,
      job_instructions: "Demo: delivered exactly as ordered.", site_label: tmpl.site_label, site_line1: tmpl.site_line1, site_city: tmpl.site_city,
      lines: [{ kind: src.kind, calc_method: "per_unit", material_id: src.material_id, description: src.description, unit_code: src.unit_code, quantity: String(qty * 2), unit_rate_cents: Number(src.unit_rate_cents), taxable: src.taxable }],
    } }))) as { order_id: string; order_number: string };
    await must("confirm", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "confirmed", p_note: "" }));
    await must("schedule", db.rpc("update_order_schedule", { p_order_id: o.order_id, p_expected_edit_seq: null, p_payload: { scheduled_start: day, scheduled_end: day } }));
    await must("scheduled", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "scheduled", p_note: "" }));
    const lineId = (((await must("line", db.from("order_lines").select("id").eq("order_id", o.order_id).limit(1))) as Array<{ id: string }>)[0]).id;
    let delivered = 0;
    for (const [k, [start, end]] of [["16:00", "16:45"], ["17:00", "17:45"]].entries()) {
      const loadId = ((await must("billing load", db.rpc("save_order_load", { p_payload: { order_id: o.order_id, load_date: day, start_time: start, end_time: end, planned_quantity: String(qty), unit_code: src.unit_code } }))) as { load_id: string }).load_id;
      // Any truck (with a trailer when it needs one) and driver the dispatch rules accept at that time.
      let ok = false;
      for (const t of trucks) {
        for (const d of drivers) {
          for (const tr of trailers) {
            if (!(await db.rpc("assign_load", { p_load_id: loadId, p_truck_id: t.id, p_trailer_id: tr, p_driver_id: d.id, p_note: "" })).error) { ok = true; break; }
          }
          if (ok) break;
        }
        if (ok) break;
      }
      if (!ok) break;
      const ticket = ((await must("billing ticket", db.rpc("submit_delivery_ticket", { p_payload: { load_id: loadId, order_line_id: lineId, delivered_date: day, delivered_time: end, quantity: String(qty), unit_code: src.unit_code, external_reference: `DEMO-B${i + 1}-${k + 1}` } }))) as { ticket_id: string }).ticket_id;
      await must("accept", db.rpc("review_delivery_ticket", { p_ticket_id: ticket, p_action: "accept", p_note: "" }));
      delivered++;
    }
    n += delivered;
    if (delivered === 2 && i === 1) {
      await must("hand off", db.rpc("hand_off_orders", { p_order_ids: [o.order_id], p_reference: "Demo batch", p_notes: "Demo: handed to billing; nothing is sent or exported.", p_submission_key: randomUUID() }));
      n++;
    }
  }
  return n;
}

/**
 * Plan the day (docs/OPTIMIZATION.md) needs open loads on an upcoming day. When tomorrow has fewer than four
 * unassigned loads, add planned loads to orders already scheduled for tomorrow (same unit and quantity as their
 * other loads), at staggered times. Nothing is assigned; a second run adds nothing while four stay open.
 */
async function planningDay(db: Db, today: string): Promise<number> {
  const day = addDays(today, 1);
  const loads = ((await must("loads", db.from("order_loads").select("id, order_id, planned_quantity, unit_code").eq("load_date", day).eq("status", "planned"))) as Array<{ id: string; order_id: string; planned_quantity: number | null; unit_code: string | null }>);
  const assigned = loads.length
    ? new Set((((await must("assignments", db.from("dispatch_assignments").select("load_id").eq("status", "active").in("load_id", loads.map((l) => l.id)))) as Array<{ load_id: string }>)).map((a) => a.load_id))
    : new Set<string>();
  const open = loads.filter((l) => !assigned.has(l.id)).length;
  if (open >= 4) return 0;
  const orders = ((await must("orders", db.from("orders").select("id, scheduled_start, scheduled_end").in("status", ["scheduled", "dispatched", "in_progress", "partially_completed"]).lte("scheduled_start", day).order("order_number"))) as Array<{ id: string; scheduled_start: string; scheduled_end: string | null }>)
    .filter((o) => (o.scheduled_end ?? o.scheduled_start) >= day)
    .slice(0, 3);
  if (!orders.length) return 0;
  const slots = [["07:00", "08:30"], ["09:00", "10:30"], ["11:00", "12:30"], ["13:00", "14:30"], ["15:00", "16:30"]];
  let n = 0;
  for (let i = 0; i < 4 - open; i++) {
    const order = orders[i % orders.length];
    const like = loads.find((l) => l.order_id === order.id) ?? (((await db.from("order_loads").select("planned_quantity, unit_code").eq("order_id", order.id).limit(1)).data ?? [])[0] as { planned_quantity: number | null; unit_code: string | null } | undefined);
    const [start, end] = slots[(i + loads.length) % slots.length];
    await must("planning load", db.rpc("save_order_load", { p_payload: {
      order_id: order.id, load_date: day, start_time: start, end_time: end,
      planned_quantity: like?.planned_quantity != null ? String(like.planned_quantity) : "", unit_code: like?.planned_quantity != null ? like.unit_code ?? "" : "",
    } }));
    n++;
  }
  return n;
}

/** Open work orders (one safety-critical on an idle truck) and preventive schedules (one coming due). */
async function maintenance(db: Db, today: string, trucks: Array<{ id: string; unit_number: string }>): Promise<number> {
  let n = 0;
  const orders = await count(db, "work_orders");
  if (orders === 0 && trucks.length >= 3) {
    // The safety-critical defect takes its truck out of service: use a truck with no upcoming booking.
    const busy = new Set((((await db.from("dispatch_assignments").select("truck_id").eq("status", "active").gte("ends_at", new Date().toISOString())).data ?? []) as Array<{ truck_id: string }>).map((a) => a.truck_id));
    const idle = trucks.filter((t) => !busy.has(t.id));
    const wo = (p: Record<string, unknown>) => must("work order", db.rpc("maintenance_create_work_order", { p: { submission_key: randomUUID(), ...p } }));
    if (idle.length) { await wo({ truck_id: idle[idle.length - 1].id, title: "Rear brake chamber leaking", category: "brakes", urgency: "immediate", safety_critical: true, description: "Air leak found at the pre-trip inspection." }); n++; }
    await wo({ truck_id: trucks[1].id, title: "Replace worn steer tires", category: "tires", urgency: "high", safety_critical: false, description: "Tread near the limit on both steer tires." }); n++;
    await wo({ truck_id: trucks[2].id, title: "Dash warning light intermittent", category: "electrical", urgency: "normal", safety_critical: false, description: "" }); n++;
  }
  const schedules = await count(db, "maintenance_schedules");
  if (schedules === 0 && trucks.length) {
    for (const [i, t] of trucks.entries()) {
      await must("schedule", db.rpc("maintenance_save_schedule", { p: { truck_id: t.id, name: "Oil and filter", interval_days: 90, interval_miles: 15000, warn_days: 14, warn_miles: 1000, last_done_on: addDays(today, -20 - (i % 8) * 9) } }));
      n++;
    }
    await must("schedule", db.rpc("maintenance_save_schedule", { p: { truck_id: trucks[0].id, name: "Annual inspection", interval_days: 365, warn_days: 30, last_done_on: addDays(today, -350) } }));
    n++;
  }
  return n;
}

/** Registrations (one expiring soon), an inspection due soon and an expired trailer registration. References are placeholders. */
async function documents(db: Db, today: string, trucks: Array<{ id: string; unit_number: string }>): Promise<number> {
  if ((await count(db, "vehicle_documents")) !== 0 || !trucks.length) return 0;
  const trailers = ((await db.from("trailers").select("id, unit_number").eq("active", true).order("unit_number").limit(1)).data ?? []) as Array<{ id: string; unit_number: string }>;
  const rows = [
    ...trucks.map((t, i) => ({ truck_id: t.id, kind: "registration", title: "Registration", reference_number: `DEMO-REG-${t.unit_number}`, issuing_authority: "", expires_on: addDays(today, i === 1 ? 21 : 120 + (i % 8) * 20), submission_key: randomUUID() })),
    { truck_id: trucks[0].id, kind: "inspection", title: "Annual inspection", reference_number: `DEMO-INSP-${trucks[0].unit_number}`, issuing_authority: "", expires_on: addDays(today, 15), submission_key: randomUUID() },
    ...trailers.map((t) => ({ trailer_id: t.id, kind: "registration", title: "Trailer registration", reference_number: `DEMO-REG-${t.unit_number}`, issuing_authority: "", expires_on: addDays(today, -4), submission_key: randomUUID() })),
  ];
  await must("documents", db.from("vehicle_documents").insert(rows));
  return rows.length;
}

/**
 * Team: approved leave next week and a pending request for two drivers. The person viewing the demo (presenter persona
 * or prospect owner who drives relief) gets a pending day three weeks out, so the Driver mode's "My requests" is not
 * empty; pending leave does not affect dispatch, so their driving day stays as it is.
 */
async function timeOff(db: Db, today: string): Promise<number> {
  const total = await count(db, "time_off_requests");
  if (total === null) return 0;
  let n = 0;
  if (total === 0) {
    const people = (await must("employees", db.from("employees").select("id").eq("status", "active").not("driver_id", "is", null).is("user_id", null).order("full_name").limit(2))) as Array<{ id: string }>;
    if (people.length === 2) {
      const approved = (await must("time off", db.rpc("time_off_save", { p: { employee_id: people[0].id, category: "vacation", start_date: addDays(today, 7), end_date: addDays(today, 9), reason: "" } }))) as { id: string };
      await must("approve", db.rpc("time_off_decide", { p_id: approved.id, p_decision: "approved", p_note: "Approved. Enjoy the time off." }));
      await must("time off", db.rpc("time_off_save", { p: { employee_id: people[1].id, category: "personal", start_date: addDays(today, 12), end_date: addDays(today, 12), reason: "" } }));
      n += 2;
    }
  }
  const viewers = (await must("employees", db.from("employees").select("id").eq("status", "active").not("user_id", "is", null).not("driver_id", "is", null))) as Array<{ id: string }>;
  for (const v of viewers) {
    const mine = (await must("time off", db.from("time_off_requests").select("id").eq("employee_id", v.id).limit(1))) as Array<{ id: string }>;
    if (mine.length) continue;
    await must("time off", db.rpc("time_off_save", { p: { employee_id: v.id, category: "personal", start_date: addDays(today, 21), end_date: addDays(today, 21), reason: "" } }));
    n++;
  }
  return n;
}

/** A draft quote for an existing customer, priced with a line copied from the demo's own orders. */
async function quotes(db: Db, today: string): Promise<number> {
  if ((await count(db, "quotes")) !== 0) return 0;
  const lines = (await must("order lines", db.from("order_lines").select("kind, calc_method, material_id, charge_item_id, description, unit_code, quantity, unit_rate_cents, taxable").order("line_no").limit(1))) as Array<Record<string, unknown>>;
  const customers = (await must("customers", db.from("customers").select("id").order("name").limit(1))) as Array<{ id: string }>;
  if (!lines.length || !customers.length) return 0;
  const site = ((await db.from("customer_sites").select("label, line1, city").eq("customer_id", customers[0].id).limit(1)).data ?? [])[0] as { label: string; line1: string; city: string } | undefined;
  const base = Object.fromEntries(Object.entries(lines[0]).filter(([, v]) => v !== null));
  await must("quote", db.rpc("save_quote_draft", { p_payload: {
    customer_id: customers[0].id, quote_date: today, valid_until: addDays(today, 30), tax_rate_bp: 0,
    ...(site ? { site_label: site.label, site_line1: site.line1, site_city: site.city } : {}),
    lines: [{ ...base, quantity: String(Number(base.quantity ?? 1) * 4) }],
  } }));
  return 1;
}

/**
 * Quotes show their locked, issued versions only once a version is issued. Demos never send email (the app records a
 * preview), so the sample uses the app's manual path: a second quote, copied like the draft above, marked as handed to
 * the customer outside Taviron. That locks version 1 and the quote reads Sent; nothing is sent. Added only while the
 * demo has no quote beyond Draft.
 */
async function issuedQuote(db: Db, today: string): Promise<number> {
  const beyondDraft = await db.from("quotes").select("id").neq("status", "draft").limit(1);
  if (missing(beyondDraft.error)) return 0;
  if (beyondDraft.error) throw new Error(`Demo samples (issued quote): ${beyondDraft.error.message}`);
  if ((beyondDraft.data ?? []).length) return 0;
  const lines = (await must("order lines", db.from("order_lines").select("kind, calc_method, material_id, charge_item_id, description, unit_code, quantity, unit_rate_cents, taxable").order("line_no").limit(1))) as Array<Record<string, unknown>>;
  const customers = (await must("customers", db.from("customers").select("id").order("name").limit(2))) as Array<{ id: string }>;
  const customer = customers[1] ?? customers[0];
  if (!lines.length || !customer) return 0;
  const site = ((await db.from("customer_sites").select("label, line1, city").eq("customer_id", customer.id).limit(1)).data ?? [])[0] as { label: string; line1: string; city: string } | undefined;
  const base = Object.fromEntries(Object.entries(lines[0]).filter(([, v]) => v !== null));
  const saved = (await must("issued quote", db.rpc("save_quote_draft", { p_payload: {
    customer_id: customer.id, quote_date: addDays(today, -3), valid_until: addDays(today, 27), tax_rate_bp: 0,
    ...(site ? { site_label: site.label, site_line1: site.line1, site_city: site.city } : {}),
    lines: [{ ...base, quantity: String(Number(base.quantity ?? 1) * 6) }],
  } }))) as { quote_id: string; edit_seq: number };
  await must("mark sent", db.rpc("mark_quote_sent", { p_quote_id: saved.quote_id, p_expected_edit_seq: saved.edit_seq, p_note: "Demo: printed and handed to the customer at the yard (fictional — nothing was sent)." }));
  return 1;
}

/**
 * The Driver and "Dispatcher who also drives" previews show the signed-in person's own day. In the presenter demo
 * the presenter is linked to a relief driver; a prospect owner (a linked employee without a driver record) gets the
 * same: a relief-driver record with valid qualifications and, when the rules allow, one of today's open loads.
 */
async function ownerDriverDay(db: Db, today: string): Promise<number> {
  const owners = ((await db.from("employees").select("id, full_name, user_id").not("user_id", "is", null).is("driver_id", null).eq("department", "management")).data ?? []) as Array<{ id: string; full_name: string; user_id: string }>;
  let n = 0;
  for (const o of owners) {
    const existing = ((await db.from("drivers").select("id").eq("user_id", o.user_id).limit(1)).data ?? []) as Array<{ id: string }>;
    if (existing.length) continue;
    const d = (await must("relief driver", db.from("drivers").insert({ name: o.full_name, user_id: o.user_id, notes: "Demo: the owner drives relief shifts.", active: true }).select("id").single())) as { id: string };
    await must("link", db.from("employees").update({ driver_id: d.id }).eq("id", o.id));
    const verified = new Date().toISOString();
    await must("qualifications", db.from("driver_qualifications").insert([
      { driver_id: d.id, kind: "cdl", cdl_class: "A", expires_on: addDays(today, 700), verified_at: verified },
      { driver_id: d.id, kind: "medical_card", expires_on: addDays(today, 300), verified_at: verified },
    ]));
    n += 2;
    // One open load today (or tomorrow), with a truck free at that time; refused assignments stay open.
    for (const day of [today, addDays(today, 1)]) {
      const open = ((await db.from("order_loads").select("id, starts_at, ends_at").eq("load_date", day).eq("status", "planned").order("starts_at")).data ?? []) as Array<{ id: string }>;
      const booked = new Set((((await db.from("dispatch_assignments").select("load_id").eq("status", "active")).data ?? []) as Array<{ load_id: string }>).map((a) => a.load_id));
      const load = open.find((l) => !booked.has(l.id));
      if (!load) continue;
      const trucks = ((await db.from("trucks").select("id").eq("active", true).eq("service_status", "in_service").order("unit_number")).data ?? []) as Array<{ id: string }>;
      // Tractors need a trailer: try without one, then each in-service trailer; the dispatch rules decide.
      const trailers = [null, ...(((await db.from("trailers").select("id").eq("active", true).eq("service_status", "in_service").order("unit_number")).data ?? []) as Array<{ id: string }>).map((t) => t.id)];
      let assigned = false;
      for (const t of trucks) {
        for (const tr of trailers) {
          const a = await db.rpc("assign_load", { p_load_id: load.id, p_truck_id: t.id, p_trailer_id: tr, p_driver_id: d.id, p_note: "" });
          if (!a.error) { assigned = true; break; }
        }
        if (assigned) { n++; break; }
      }
      break;
    }
  }
  return n;
}

/**
 * Command Center: "Assigned to you" is empty until someone assigns an item. One open ticket to review (or, failing
 * that, the first open item) is assigned to the person viewing the demo through the real assignment path, which checks
 * that their role can resolve it. Added only while the demo has never had an assignment.
 */
async function assignedItem(db: Db, me: string): Promise<number> {
  const existing = await count(db, "exception_assignments");
  if (existing === null || existing > 0) return 0;
  for (const kind of ["ticket_review", null]) {
    const page = await db.rpc("command_center_exceptions", { p_kind: kind, p_mine: false, p_limit: 5, p_offset: 0, p_hidden: false });
    if (missing(page.error)) return 0;
    for (const item of ((page.data as { items?: Array<{ exception_key: string }> } | null)?.items ?? [])) {
      const r = await db.rpc("assign_exception", { p_key: item.exception_key, p_user_id: me, p_note: "Demo: please take this one today." });
      if (!r.error) return 1;
    }
  }
  return 0;
}

/** An operational workspace for an upcoming scheduled order, created through the real feature (members follow dispatch). */
async function workspace(db: Db, today: string, me: string): Promise<number> {
  // operation_workspaces is visible to everyone with comms.operations (owners), so this sees workspaces others made.
  const existing = await count(db, "operation_workspaces");
  if (existing === null || existing > 0) return 0;
  const orders = ((await db.from("orders").select("id, order_number").eq("status", "scheduled").gte("scheduled_start", today).order("scheduled_start").limit(1)).data ?? []) as Array<{ id: string; order_number: string }>;
  if (!orders.length) return 0;
  const dir = await db.rpc("comm_directory");
  if (missing(dir.error)) return 0;
  const staff = (((dir.data ?? []) as Array<{ user_id: string }>).map((p) => p.user_id)).filter((id) => id !== me);
  const r = await db.rpc("comm_create_operation", { p_title: `${orders[0].order_number} job`, p: { scope_type: "project", order_ids: [orders[0].id] }, p_staff: staff });
  if (missing(r.error)) return 0;
  if (r.error) throw new Error(`Demo samples (workspace): ${r.error.message}`);
  return 1;
}
