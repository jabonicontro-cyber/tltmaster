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
  note("trailer maintenance", await trailerMaintenance(db, today));
  note("maintenance crews", await maintenanceCrews(db, today));
  note("vehicle documents", await documents(db, today, trucks));
  note("driver day for the demo owner", await ownerDriverDay(db, today));
  // Schedules first: full-day requests then count scheduled hours (20261114000300).
  note("work schedules", await workSchedules(db));
  // Balances first: once a bank covers vacation and personal time, requests on it need hours and a balance.
  note("time-off balances", await ptoBalances(db, today));
  note("time off", await timeOff(db, today));
  note("quotes", await quotes(db, today));
  note("issued quote", await issuedQuote(db, today));
  note("operational workspace", await workspace(db, today, userId));
  note("assigned attention item", await assignedItem(db, userId));
  note("order waiting for a date", await needsScheduling(db, today));
  note("planning day", await planningDay(db, today));
  note("billing: ready and handed off", await billing(db, today));
  // After the driver day, so the owner's own load can carry the flagged site.
  note("site directions verification", await siteDirections(db, today, userId));
  note("payroll period", await payrollPeriod(db, today));
  note("CRM pipeline", await crm(db, today, userId));
  note("customer portal", await customerPortal(db));
  note("guided onboarding", await guidedOnboarding(db));
  // After the driver day and planning samples: assigns some of today's own open loads so routes exist today.
  note("route planner", await routePlanner(db, today));
  return result;
}

/**
 * Guided onboarding (B68, 20261120001000): a fictional mid-onboarding checklist — finished, submitted for review,
 * changes requested, blocked, awaiting the customer and not started — built by the database from the demo's own plan,
 * fleet and bases. Only while the demo has no checklist; nothing is sent.
 */
async function guidedOnboarding(db: Db): Promise<number> {
  const { data, error } = await db.rpc("onboarding_demo_samples");
  if (missing(error)) return 0;
  if (error) throw new Error(`Demo samples (guided onboarding): ${error.message}`);
  return Number(data ?? 0);
}

/**
 * Company CRM (20261119000100): on the demo's three most recent customers with orders — an opportunity in Quoting
 * valued at that customer's latest order total (the demo's own figure), one in Negotiation with no value (a stated
 * unknown), an overdue follow-up and a follow-up for this week assigned to the viewer, and one logged call each.
 * Only while the demo has no opportunity; nothing is sent.
 */
async function crm(db: Db, today: string, me: string): Promise<number> {
  const n = await count(db, "crm_opportunities");
  if (n === null || n > 0) return 0;
  const orders = ((await db.from("orders").select("customer_id, total_cents, order_date").neq("status", "canceled").order("order_date", { ascending: false }).limit(200)).data ?? []) as Array<{ customer_id: string; total_cents: number }>;
  const latest = new Map<string, number>();
  for (const o of orders) if (!latest.has(o.customer_id)) latest.set(o.customer_id, o.total_cents);
  const customers = [...latest.keys()].slice(0, 3);
  if (customers.length === 0) return 0;
  let added = 0;
  const [a, b = a, c = a] = customers;
  await must("opportunity", db.from("crm_opportunities").insert({ customer_id: a, title: "Repeat of the last order (demo)", stage: "quoting", value_cents: latest.get(a) ?? null, probability: 50, owner_id: me, follow_up_on: addDays(today, 2), next_action: "Send the updated quote" }));
  await must("opportunity", db.from("crm_opportunities").insert({ customer_id: b, title: "Next season's work (demo)", stage: "negotiation", owner_id: me, next_action: "Agree the start date" }));
  added += 2;
  await must("task", db.from("customer_tasks").insert({ customer_id: a, title: "Call back about delivery windows (demo)", due_on: addDays(today, -1), assigned_to: me }));
  await must("task", db.from("customer_tasks").insert({ customer_id: c, title: "Check how the last delivery went (demo)", due_on: addDays(today, 3), assigned_to: me }));
  added += 2;
  for (const id of new Set([a, b, c])) {
    await must("activity", db.from("customer_activities").insert({ customer_id: id, kind: "call", subject: "Check-in call (demo)", body: "Fictional sample activity.", occurred_at: `${addDays(today, -2)}T15:00:00Z` }));
    added++;
  }
  return added;
}

/**
 * Driver payroll (B27, 20261118000200): one open period over the last two weeks, so the owner sees the demo's verified
 * tickets waiting for payroll. No pay rule is added: pay rules are each company's own (docs/PAYROLL.md) and never
 * invented, so calculation stays off until someone in the demo writes and activates one. Only while the demo has no
 * payroll period.
 */
async function payrollPeriod(db: Db, today: string): Promise<number> {
  const n = await count(db, "payroll_periods");
  if (n === null || n > 0) return 0;
  await must("payroll period", db.rpc("payroll_period_create", { p_starts: addDays(today, -14), p_ends: addDays(today, -1) }));
  return 1;
}

/**
 * Site directions verification (B51, 20261115000200): three job sites that have no directions get fictional ones —
 * safety/access critical and not verified (flagged to dispatch and drivers), safety/access critical and verified
 * through the real database function, and standard and not verified. Sites of loads assigned from today on come
 * first (loads of drivers who sign in first, for My Day). Demo orders were created with the site's address
 * but not linked to the saved site, so those upcoming orders are linked through the normal order edit
 * (update_order_details, every other detail kept). The three samples are added only while nobody in the demo has used
 * the feature (no verification, no critical site); directions someone already typed are never changed. On every run,
 * a driver who signs in (an owner's relief load added by Refresh) whose upcoming loads have no site directions gets
 * the flagged sample on their first load's site, if it has none, so My Day shows the check.
 */
async function siteDirections(db: Db, today: string, me: string): Promise<number> {
  const used = await db.from("customer_sites").select("id").or("directions_verified_at.not.is.null,directions_risk.eq.safety_access").limit(1);
  if (used.error && (missing(used.error) || used.error.code === "42703")) return 0;
  if (used.error) throw new Error(`Demo samples (site directions): ${used.error.message}`);
  type Site = { id: string; customer_id: string; line1: string; directions: string | null };
  const sites = ((await db.from("customer_sites").select("id, customer_id, line1, directions").eq("active", true).order("label")).data ?? []) as Site[];
  const blank = sites.filter((x) => !x.directions?.trim());

  type Order = {
    id: string; customer_id: string; status: string; site_id: string | null; site_label: string; site_line1: string; site_line2: string; site_city: string; site_state: string; site_postal_code: string;
    contact_id: string | null; contact_name: string; contact_email: string; contact_phone: string; project_name: string; customer_po: string; job_instructions: string; internal_notes: string; requested_date: string | null;
  };
  // Drivers who sign in (the demo's owners who drive relief, and the viewer) see these loads on My Day.
  const drivers = ((await db.from("drivers").select("id, user_id").not("user_id", "is", null)).data ?? []) as Array<{ id: string; user_id: string }>;
  const own = new Set(drivers.filter((d) => d.user_id === me).map((d) => d.id));
  const signIn = new Set(drivers.map((d) => d.id));
  type Load = { orders: Order | null; dispatch_assignments: Array<{ driver_id: string | null }> };
  const upcoming = (only: string[] | null) => {
    let q = db.from("order_loads")
      .select("orders(id, customer_id, status, site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code, contact_id, contact_name, contact_email, contact_phone, project_name, customer_po, job_instructions, internal_notes, requested_date), dispatch_assignments!inner(status, driver_id)")
      .gte("load_date", today).eq("status", "planned").eq("dispatch_assignments.status", "active");
    if (only) q = q.in("dispatch_assignments.driver_id", only);
    return q.order("starts_at").limit(200).then((r) => (r.data ?? []) as unknown as Load[]);
  };
  const loads = [...(signIn.size ? await upcoming([...signIn]) : []), ...(await upcoming(null))];
  const by = (set: Set<string>) => (l: Load) => l.dispatch_assignments.some((a) => a.driver_id !== null && set.has(a.driver_id));
  const siteOf = (o: Order, among: Site[] = sites) => among.find((x) => x.customer_id === o.customer_id && (o.site_id ? o.site_id === x.id : x.line1.trim() === o.site_line1.trim()));
  const linked = new Set<string>();
  // Upcoming orders at a saved site with directions are linked to it (normal order edit, every other detail kept).
  const link = async (only: (o: Order) => boolean) => {
    for (const l of loads) {
      const o = l.orders;
      if (!o || o.site_id || linked.has(o.id) || ["completed", "canceled"].includes(o.status) || !only(o)) continue;
      const site = siteOf(o);
      if (!site?.directions?.trim()) continue;
      linked.add(o.id);
      const payload: Record<string, unknown> = { ...o, site_id: site.id };
      for (const k of ["id", "customer_id", "status"]) delete payload[k];
      await must("link order to site", db.rpc("update_order_details", { p_order_id: o.id, p_expected_edit_seq: null, p_payload: payload }));
    }
  };
  const samples = [
    { risk: "safety_access", verify: false, directions: "Enter by the north gate only: the east entrance has a soft shoulder. Gate code from the site contact on arrival. Hard hat and vest past the scale house." },
    { risk: "safety_access", verify: true, directions: "Low power line over the back lot: dump only at the marked pad by the fence. Call the site contact before raising the bed." },
    { risk: "standard", verify: false, directions: "Dump at the north end of the lot, past the stockpiles. Turn around in the gravel area." },
  ];
  const give = async (site: Site, sample: (typeof samples)[number]) => {
    await must("site directions", db.from("customer_sites").update({ directions: sample.directions, directions_risk: sample.risk }).eq("id", site.id));
    if (sample.verify) await must("verify directions", db.rpc("verify_site_directions", { p_site: site.id }));
    site.directions = sample.directions;
  };
  // Every driver who signs in sees the check on My Day: when none of their upcoming loads is at a site with directions,
  // the site of their first one (if it has none) gets the flagged sample. Runs after Refresh adds an owner's relief load.
  const forDrivers = async () => {
    let added = 0;
    for (const d of signIn) {
      const theirs = loads.filter(by(new Set([d])));
      if (!theirs.length || theirs.some((l) => l.orders && siteOf(l.orders)?.directions?.trim())) continue;
      const site = theirs.map((l) => (l.orders ? siteOf(l.orders, blank) : undefined)).find(Boolean);
      if (!site || site.directions?.trim()) continue;
      await give(site, samples[0]);
      added++;
    }
    const mine = new Set(loads.filter(by(signIn)).map((l) => l.orders?.id));
    await link((o) => mine.has(o.id));
    return added;
  };
  if ((used.data ?? []).length || !blank.length) return forDrivers();
  const chosen: Site[] = [];
  for (const l of [...loads.filter(by(own)), ...loads.filter(by(signIn)), ...loads]) {
    const site = l.orders ? siteOf(l.orders, blank) : undefined;
    if (site && !chosen.includes(site)) chosen.push(site);
  }
  for (const x of blank) if (!chosen.includes(x)) chosen.push(x);

  let n = 0;
  for (const [i, site] of chosen.slice(0, samples.length).entries()) {
    await give(site, samples[i]);
    n++;
  }
  const samplesAt = new Set(chosen.slice(0, samples.length).map((x) => x.id));
  await link((o) => samplesAt.has(siteOf(o)?.id ?? ""));
  return n + (await forDrivers());
}

/**
 * Billing (docs/IMPLEMENTATION_PLAN.md §5k): the Ready to bill and Handed off views need an order delivered exactly as
 * ordered. When the demo has neither, two small past orders are created through the real paths — order, schedule,
 * loads, assignment, tickets entered and accepted — copying a per-unit line (rate included) from the demo's own
 * orders, for a customer that needs no PO. The second is handed off to billing (an internal batch: nothing is sent,
 * exported or invoiced). Each state is checked on its own: late in the day the seed's own same-day orders become
 * ready by themselves, and the Handed off example must still be added. A second run adds nothing.
 */
async function billing(db: Db, today: string): Promise<number> {
  const [ready, handed] = await Promise.all(["ready", "handed_off"].map((r) => db.from("billing_order_status").select("readiness").eq("readiness", r).limit(1)));
  for (const q of [ready, handed]) {
    if (missing(q.error)) return 0;
    if (q.error) throw new Error(`Demo samples (billing): ${q.error.message}`);
  }
  const needed = [!(ready.data ?? []).length, !(handed.data ?? []).length]; // [a ready order, a handed-off order]
  if (!needed.some(Boolean)) return 0;
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
    if (!needed[i]) continue;
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
      const ticket = ((await must("billing ticket", db.rpc("submit_delivery_ticket", { p_payload: { load_id: loadId, order_line_id: lineId, delivered_date: day, delivered_time: end, quantity: String(qty), unit_code: src.unit_code, external_reference: `DEMO-${o.order_number}-${k + 1}` } }))) as { ticket_id: string }).ticket_id;
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
 * Dispatch's "Needs scheduling" queue lists confirmed orders without a delivery date; demos had none. One is added
 * through the real path (draft → confirmed), copying a per-unit line and its rate from the demo's own orders. Added
 * only while no confirmed order is waiting for a date.
 */
async function needsScheduling(db: Db, today: string): Promise<number> {
  const waiting = await must("waiting", db.from("orders").select("id").eq("status", "confirmed").is("scheduled_start", null).limit(1));
  if ((waiting as unknown[]).length) return 0;
  type Line = { kind: string; calc_method: string; material_id: string | null; description: string; unit_code: string | null; unit_rate_cents: number; taxable: boolean };
  type Tmpl = { customer_id: string; site_label: string | null; site_line1: string | null; site_city: string | null; order_lines: Line[] };
  const candidates = (await must("template", db.from("orders")
    .select("customer_id, site_label, site_line1, site_city, order_lines(kind, calc_method, material_id, description, unit_code, unit_rate_cents, taxable)")
    .not("site_line1", "is", null).order("order_number", { ascending: false }).limit(20))) as unknown as Tmpl[];
  const tmpl = candidates.find((o) => o.order_lines.some((l) => l.calc_method === "per_unit" && l.unit_code));
  if (!tmpl) return 0;
  const src = tmpl.order_lines.find((l) => l.calc_method === "per_unit" && l.unit_code)!;
  const o = (await must("waiting order", db.rpc("save_order_draft", { p_payload: {
    customer_id: tmpl.customer_id, order_date: today, project_name: `${tmpl.site_label ?? "Site"} — next phase`,
    job_instructions: "Demo: the customer will call with a start date.", site_label: tmpl.site_label, site_line1: tmpl.site_line1, site_city: tmpl.site_city,
    lines: [{ kind: src.kind, calc_method: "per_unit", material_id: src.material_id, description: src.description, unit_code: src.unit_code, quantity: "40", unit_rate_cents: Number(src.unit_rate_cents), taxable: src.taxable }],
  } }))) as { order_id: string };
  await must("confirm", db.rpc("set_order_status", { p_order_id: o.order_id, p_status: "confirmed", p_note: "Demo: waiting for the customer's start date." }));
  return 1;
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

/**
 * One trailer shop visit (annual inspection in three days), so the trailer side of Maintenance and its dispatch rule
 * have data. Not safety-critical: no demo trailer is taken out of service. Skipped until trailer work orders exist
 * (20261115000100) and once any trailer work order exists.
 */
async function trailerMaintenance(db: Db, today: string): Promise<number> {
  const { data: existing, error } = await db.from("work_orders").select("id").not("trailer_id", "is", null).limit(1);
  if (error && (missing(error) || error.code === "42703")) return 0;
  if (error) throw new Error(`Demo samples (trailer work orders): ${error.message}`);
  if ((existing ?? []).length) return 0;
  const trailers = ((await db.from("trailers").select("id, unit_number").eq("active", true).eq("service_status", "in_service").order("unit_number").limit(1)).data ?? []) as Array<{ id: string }>;
  if (!trailers.length) return 0;
  await must("trailer work order", db.rpc("maintenance_create_work_order", { p: {
    submission_key: randomUUID(), trailer_id: trailers[0].id, title: "Annual trailer inspection", category: "inspection",
    urgency: "normal", safety_critical: false, scheduled_for: addDays(today, 3), description: "Brakes, lights, tires and landing gear.",
  } }));
  return 1;
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
      const approved = (await must("time off", db.rpc("time_off_save", { p: { employee_id: people[0].id, category: "vacation", start_date: addDays(today, 7), end_date: addDays(today, 9), hours: 24, reason: "" } }))) as { id: string };
      await must("approve", db.rpc("time_off_decide", { p_id: approved.id, p_decision: "approved", p_note: "Approved. Enjoy the time off." }));
      await must("time off", db.rpc("time_off_save", { p: { employee_id: people[1].id, category: "personal", start_date: addDays(today, 12), end_date: addDays(today, 12), hours: 8, reason: "" } }));
      n += 2;
    }
  }
  const viewers = (await must("employees", db.from("employees").select("id").eq("status", "active").not("user_id", "is", null).not("driver_id", "is", null))) as Array<{ id: string }>;
  for (const v of viewers) {
    const mine = (await must("time off", db.from("time_off_requests").select("id").eq("employee_id", v.id).limit(1))) as Array<{ id: string }>;
    if (mine.length) continue;
    await must("time off", db.rpc("time_off_save", { p: { employee_id: v.id, category: "personal", start_date: addDays(today, 21), end_date: addDays(today, 21), hours: 8, reason: "" } }));
    n++;
  }
  return n;
}

/**
 * Time-off balances (20261112000100): one combined "Paid time off" bank (vacation and personal; full- and part-time)
 * and a fictional opening grant for each current employee who has no entry on it yet, so My balances, Banks and
 * balances and the request form show real numbers. Grants go through pto_adjust (owner's time_off.balances); amounts
 * are demo data, labelled as such in the history, never a policy.
 */
/**
 * Work schedules (migration 20261114000300): fictional weekly hours for current full- and part-time people without
 * one — full-time Monday–Friday 8 h (every third person 10 h days Monday–Thursday), part-time Monday, Wednesday and
 * Friday 6 h — so full-day time off counts scheduled hours in the demo. Existing schedules are kept; a second run adds
 * nothing. Skipped on a database without the table.
 */
async function workSchedules(db: Db): Promise<number> {
  const existing = await db.from("employee_work_schedules").select("employee_id");
  if (existing.error) return 0; // not installed yet
  const have = new Set(((existing.data ?? []) as Array<{ employee_id: string }>).map((r) => r.employee_id));
  const people = (await must("employees", db.from("employees").select("id, employment_type").in("status", ["active", "on_leave"]).in("employment_type", ["full_time", "part_time"]).order("full_name"))) as Array<{ id: string; employment_type: string }>;
  const rows = people.filter((p) => !have.has(p.id)).map((p, i) =>
    p.employment_type === "part_time"
      ? { employee_id: p.id, mon_hours: 6, tue_hours: 0, wed_hours: 6, thu_hours: 0, fri_hours: 6, sat_hours: 0, sun_hours: 0 }
      : i % 3 === 2
        ? { employee_id: p.id, mon_hours: 10, tue_hours: 10, wed_hours: 10, thu_hours: 10, fri_hours: 0, sat_hours: 0, sun_hours: 0 }
        : { employee_id: p.id, mon_hours: 8, tue_hours: 8, wed_hours: 8, thu_hours: 8, fri_hours: 8, sat_hours: 0, sun_hours: 0 });
  if (!rows.length) return 0;
  await must("work schedules", db.from("employee_work_schedules").insert(rows));
  return rows.length;
}

async function ptoBalances(db: Db, today: string): Promise<number> {
  const banks = await db.from("pto_banks").select("id, active");
  if (missing(banks.error)) return 0;
  if (banks.error) throw new Error(`Demo samples (time-off banks): ${banks.error.message}`);
  let n = 0;
  let bankId = ((banks.data ?? []) as Array<{ id: string; active: boolean }>).find((b) => b.active)?.id;
  if (!bankId) {
    if ((banks.data ?? []).length) return 0; // banks exist but none is active: the demo owner changed them, leave them be
    bankId = ((await must("time-off bank", db.rpc("pto_bank_save", { p: { name: "Paid time off", categories: ["vacation", "personal"], employment_types: ["full_time", "part_time"], waiting_days: 0 } }))) as { id: string }).id;
    n++;
  }
  const people = (await must("employees", db.from("employees").select("id, employment_type").in("status", ["active", "on_leave"]).in("employment_type", ["full_time", "part_time"]).order("full_name"))) as Array<{ id: string; employment_type: string }>;
  const have = new Set(((await must("balances", db.from("pto_ledger").select("employee_id").eq("bank_id", bankId))) as Array<{ employee_id: string }>).map((r) => r.employee_id));
  for (const [i, p] of people.entries()) {
    if (have.has(p.id)) continue;
    const hours = p.employment_type === "part_time" ? 16 : 40 + (i % 3) * 8;
    await must("time-off grant", db.rpc("pto_adjust", { p: { employee_id: p.id, bank_id: bankId, kind: "grant", hours, note: "Demo: opening balance (fictional)" } }));
    n++;
  }
  // Accruals (20261112000300): a fictional every-two-weeks policy for full-time employees, started eight weeks ago,
  // and one run so the history shows accrued hours. A demo with a policy already keeps it.
  const policies = await db.from("pto_policies").select("id").eq("bank_id", bankId).eq("active", true).limit(1);
  if (!missing(policies.error) && !policies.error && !(policies.data ?? []).length) {
    const start = addDays(today, -56);
    await must("time-off policy", db.rpc("pto_policy_save", { p: { bank_id: bankId, employment_type: "full_time", method: "per_pay_period", amount: 3.08, pay_period: "biweekly", anchor_date: start, effective_from: start } }));
    const run = (await must("time-off accruals", db.rpc("pto_run_accruals", { p_through: today }))) as { entries: number };
    n += 1 + run.entries;
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
      const open = ((await db.from("order_loads").select("id, starts_at, ends_at, orders(customer_id, site_line1)").eq("load_date", day).eq("status", "planned").order("starts_at")).data ?? []) as unknown as Array<{ id: string; orders: { customer_id: string; site_line1: string } | null }>;
      const booked = new Set((((await db.from("dispatch_assignments").select("load_id").eq("status", "active")).data ?? []) as Array<{ load_id: string }>).map((a) => a.load_id));
      // A load at a site with directions first, so My Day shows the site directions check (B51).
      const withDirections = (((await db.from("customer_sites").select("customer_id, line1").neq("directions", "")).data ?? []) as Array<{ customer_id: string; line1: string }>);
      const atSite = (l: (typeof open)[number]) => withDirections.some((x) => x.customer_id === l.orders?.customer_id && x.line1.trim() === l.orders?.site_line1.trim());
      const free = open.filter((l) => !booked.has(l.id));
      const load = free.find(atSite) ?? free[0];
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
 * Command Center: "Assigned to you" is empty until someone assigns an item. One open item that stays open in a demo
 * (a ticket to review, a blocked billing order, equipment out of service; failing those, the first open item) is assigned to the person viewing the demo through the real assignment path, which checks
 * that their role can resolve it. Added only while the demo has never had an assignment.
 */
async function assignedItem(db: Db, me: string): Promise<number> {
  const existing = await count(db, "exception_assignments");
  if (existing === null || existing > 0) return 0;
  // Kinds that stay open in a demo first (a load without a truck may be assigned by another sample).
  for (const kind of ["ticket_review", "billing_blocked", "equipment_out_of_service", "missing_ticket", null]) {
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

/**
 * Customer portal (20261120000700): entitle and open the demo's portal with a public page, plus a few published help
 * articles. Entitlement is the platform owner's call (platform_portal_set_entitlement) and the person refreshing a demo
 * is the platform owner; for anyone else it is skipped. The company's own portal choices are never overwritten.
 */
async function customerPortal(db: Db): Promise<number> {
  const state = await db.rpc("portal_admin_state");
  if (missing(state.error)) return 0;
  let added = 0;
  const s = state.data as { entitled: boolean; slug: string; settings: Record<string, unknown> | null };
  const { data: access } = await db.rpc("my_access");
  const companyId = (access as { company_id?: string } | null)?.company_id;
  let entitled = s.entitled;
  if (!entitled && companyId) {
    const r = await db.rpc("platform_portal_set_entitlement", { p_company: companyId, p_entitled: true, p_note: "Demo company (sample data)" });
    if (!r.error) {
      added++;
      entitled = true;
    }
  }
  // Settings only once the demo is entitled (a company cannot turn on a portal it is not entitled to).
  if (entitled && !s.settings) {
    const r = await db.rpc("portal_save_settings", {
      p: {
        enabled: true, public_page: true, feature_orders: true, feature_quotes: true, feature_documents: true, feature_support: true, feature_help: true, feature_tracking: true,
        welcome: "Welcome to our customer portal. Follow your orders and deliveries, see your quotes and ask us anything. (Demo company: all records are fictional.)",
        hours: "Mon–Fri 6:30 AM – 5:00 PM\nSat 7:00 AM – noon",
      },
    });
    if (!r.error) added++;
  }
  const existing = await count(db, "portal_help_articles");
  if (existing === 0) {
    const articles: Array<[string, string, string]> = [
      ["Ordering", "How do I place an order?", "Request a quote in the portal (Quotes → Request a Quote) or call the office. Once you accept a quote and we confirm it, your order appears under Orders with its planned deliveries. (Sample article in a demo company.)"],
      ["Deliveries", "What should the site have ready?", "A clear, safe place to dump, a contact on site, and the gate code if there is one. Add site notes when you request a quote. (Sample article in a demo company.)"],
      ["Tickets", "How do I get a copy of a delivery ticket?", "Open the order under Orders, then open the ticket. Each ticket has a printable customer copy. (Sample article in a demo company.)"],
    ];
    for (const [category, title, body] of articles) {
      const r = await db.rpc("portal_help_save", { p_id: null, p_title: title, p_category: category, p_body: body, p_status: "published" });
      if (r.error) throw new Error(`Demo samples (portal help): ${r.error.message}`);
      added++;
    }
  }
  return added;
}


/**
 * Route Planner (B10, 20261120002600): saved places around the demo's own yard, routing dimensions on two trucks, saved
 * routes, and today's routes (up to three of today's open loads assigned through assign_load; the dispatch rules decide
 * and a refusal leaves the load open).
 *
 * Places are fictional (named so) and placed a few miles out from the yard, not at real businesses; their address is
 * the demo's own town only. One of each kind, a yard per extra dispatch base (Growth and Professional demos), and one
 * place without a location yet so locating can be tried. Each place and route is added by name when missing, so
 * existing demos receive new samples on Refresh and a person's own edits are kept.
 */
export const DEMO_PLACES = [
  { kind: "yard", name: "Main yard (demo)", d: [0, 0], notes: "Demo: trucks start and end the day here." },
  { kind: "quarry", name: "North Pit (fictional)", d: [0.11, -0.04], notes: "Demo: scale house opens 6:00. Queue on the east lane." },
  { kind: "quarry", name: "River Gravel Pit (fictional)", d: [-0.08, 0.12], notes: "Demo: washed stone and sand." },
  { kind: "plant", name: "Asphalt Plant 2 (fictional)", d: [0.03, 0.19], notes: "Demo: hot mix loads by appointment." },
  { kind: "terminal", name: "Rail Terminal (fictional)", d: [-0.14, -0.09], notes: "Demo: rail-delivered stone; trucks load at track 3." },
  { kind: "pickup", name: "Sand Pickup, Hwy 24 (fictional)", d: [0.06, -0.16], notes: "Demo: self-load; bring a ticket from the office." },
  { kind: "other", name: "Overflow parking (demo, not located yet)", d: null, notes: "Demo: no location yet. Use Edit to place it on the map." },
] as const;

async function routePlanner(db: Db, today: string): Promise<number> {
  if ((await count(db, "company_locations")) === null) return 0;
  let n = 0;
  const settings = (await db.from("company_settings").select("yard_latitude, yard_longitude, city, state").maybeSingle()).data as { yard_latitude: number | null; yard_longitude: number | null; city: string | null; state: string | null } | null;
  const yard = settings?.yard_latitude != null && settings.yard_longitude != null ? { lat: Number(settings.yard_latitude), lng: Number(settings.yard_longitude) } : null;
  const town = { city: (settings?.city ?? "").slice(0, 80), state: (settings?.state ?? "").slice(0, 40) };
  if (yard) {
    const at = (d: readonly [number, number] | null) => d
      ? { latitude: Math.round((yard.lat + d[0]) * 1e6) / 1e6, longitude: Math.round((yard.lng + d[1]) * 1e6) / 1e6, location_source: "manual" }
      : { latitude: null, longitude: null, location_source: "" };
    const existing = new Set((((await db.from("company_locations").select("name")).data ?? []) as Array<{ name: string }>).map((r) => r.name));
    const bases = ((await db.from("dispatch_bases").select("id, code, name").eq("active", true).neq("code", "MAIN").order("code")).data ?? []) as Array<{ id: string; code: string; name: string }>;
    const rows = [
      ...DEMO_PLACES.map((p) => ({ kind: p.kind, name: p.name, notes: p.notes, ...at(p.d) })),
      // A yard per extra base, spread around the main yard.
      ...bases.map((b, i) => ({ kind: "yard", name: `${b.name} yard (demo)`.slice(0, 120), notes: "Demo: this dispatch base's trucks start here.", base_id: b.id, ...at([0.22 * Math.cos(i * 2.1), 0.28 * Math.sin(i * 2.1)]) })),
    ].filter((r) => !existing.has(r.name)).map((r) => ({ ...town, ...r }));
    if (rows.length) {
      await must("locations", db.from("company_locations").insert(rows));
      n += rows.length;
    }
    // Earlier samples had no address: give them the demo's town (only where still blank).
    if (town.city) await db.from("company_locations").update(town).in("name", DEMO_PLACES.map((p) => p.name)).eq("city", "").eq("address_line1", "");
  }

  // Routing dimensions on two trucks that have none (a typical tri-axle dump truck; fictional).
  const dims = await db.from("trucks").select("id").eq("active", true).is("height_cm", null).order("unit_number").limit(2);
  if (!dims.error && (await db.from("trucks").select("id", { count: "exact", head: true }).not("height_cm", "is", null)).count === 0) {
    for (const t of (dims.data ?? []) as Array<{ id: string }>) {
      const r = await db.from("trucks").update({ height_cm: 396, width_cm: 259, length_cm: 1036, gross_weight_kg: 33112, axle_count: 4 }).eq("id", t.id);
      if (!r.error) n++;
    }
  }

  // Today's routes: assign up to three of today's open loads to free trucks and drivers.
  const loads = ((await db.from("order_loads").select("id").eq("load_date", today).eq("status", "planned").order("starts_at")).data ?? []) as Array<{ id: string }>;
  if (loads.length) {
    const active = new Set((((await db.from("dispatch_assignments").select("load_id").eq("status", "active").in("load_id", loads.map((l) => l.id))).data ?? []) as Array<{ load_id: string }>).map((a) => a.load_id));
    if (active.size < 3) {
      const trucks = ((await db.from("trucks").select("id").eq("active", true).eq("service_status", "in_service").order("unit_number")).data ?? []) as Array<{ id: string }>;
      const drivers = ((await db.from("drivers").select("id").eq("active", true).order("name")).data ?? []) as Array<{ id: string }>;
      const trailers = [null, ...(((await db.from("trailers").select("id").eq("active", true).eq("service_status", "in_service").order("unit_number")).data ?? []) as Array<{ id: string }>).map((t) => t.id)];
      let made = active.size;
      for (const load of loads.filter((l) => !active.has(l.id))) {
        if (made >= 3) break;
        let done = false;
        for (const t of trucks) {
          for (const d of drivers) {
            for (const tr of trailers) {
              if ((await db.rpc("assign_load", { p_load_id: load.id, p_truck_id: t.id, p_trailer_id: tr, p_driver_id: d.id, p_note: "Demo: today's route sample." })).error) continue;
              done = true;
              break;
            }
            if (done) break;
          }
          if (done) break;
        }
        if (done) { made++; n++; }
      }
    }
  }

  // Saved routes, each added by name when missing: a first load of the day, and a plant run with a sized truck.
  const placeIds = new Map((((await db.from("company_locations").select("id, name").eq("active", true)).data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.name, p.id]));
  const routeNames = new Set((((await db.from("saved_routes").select("name")).data ?? []) as Array<{ name: string }>).map((r) => r.name));
  const site = (((await db.from("customer_sites").select("id, label").not("latitude", "is", null).eq("active", true).order("label").limit(1)).data ?? []) as Array<{ id: string; label: string }>)[0];
  const sized = (((await db.from("trucks").select("id").eq("active", true).not("height_cm", "is", null).order("unit_number").limit(1)).data ?? []) as Array<{ id: string }>)[0];
  const place = (name: string, minutes: number) => (placeIds.has(name) ? { company_location_id: placeIds.get(name)!, label: name, service_minutes: minutes } : null);
  const samples = [
    { name: "Yard → North Pit → job site (demo)", notes: "Demo: a typical first load of the day.", truck_id: null, stops: [place("Main yard (demo)", 0), place("North Pit (fictional)", 25), site ? { customer_site_id: site.id, label: site.label, service_minutes: 15 } : null, place("Main yard (demo)", 0)] },
    { name: "Plant run via River Gravel (demo)", notes: "Demo: a sized truck, so its height and weight go to the routing provider.", truck_id: sized?.id ?? null, stops: [place("Main yard (demo)", 0), place("River Gravel Pit (fictional)", 20), place("Asphalt Plant 2 (fictional)", 30), place("Rail Terminal (fictional)", 20), place("Main yard (demo)", 0)] },
  ];
  for (const r of samples) {
    if (routeNames.has(r.name) || r.stops.some((x) => !x)) continue;
    const head = (await must("saved route", db.from("saved_routes").insert({ name: r.name, notes: r.notes, truck_id: r.truck_id }).select("id").single())) as { id: string };
    await must("saved route stops", db.from("saved_route_stops").insert(r.stops.map((x, i) => ({ route_id: head.id, position: i + 1, ...x }))));
    n++;
  }
  return n;
}


/**
 * Maintenance crews, labor time and checklists (20261120002900): on up to three open work orders, the demo's owner (a
 * real login, as crew must be) on the crew (lead on the first), time logged yesterday (no timer is left running), and a four-step checklist
 * half done on the first. Only while the demo has no checklist yet; every write goes through the same functions as
 * the work order page, so the overlap and permission rules apply.
 */
async function maintenanceCrews(db: Db, today: string): Promise<number> {
  const tasks = await count(db, "work_order_tasks");
  if (tasks === null || tasks > 0) return 0;
  const { userId } = await demoCompany(db);
  const open = ((await db.from("work_orders").select("id, status, title").in("status", ["in_progress", "scheduled", "triaged", "reported"]).order("created_at").limit(3)).data ?? []) as Array<{ id: string; status: string; title: string }>;
  if (!open.length) return 0;
  let n = 0;
  const yesterday = addDays(today, -1);
  // Yesterday, mid-morning and early afternoon UTC: two separate, non-overlapping blocks.
  const blocks: Array<[string, string]> = [[`${yesterday}T14:00:00Z`, `${yesterday}T16:15:00Z`], [`${yesterday}T17:00:00Z`, `${yesterday}T18:30:00Z`], [`${yesterday}T19:00:00Z`, `${yesterday}T19:45:00Z`]];
  for (const [i, w] of open.entries()) {
    // Lead on the first job (it shows the Lead badge), helping on the others.
    const added = await db.rpc("maintenance_add_mechanic", { p_wo: w.id, p_user: userId, p_lead: i === 0 });
    if (added.error) continue;
    const t = await db.rpc("maintenance_add_time", { p_wo: w.id, p_user: userId, p_started: blocks[i][0], p_ended: blocks[i][1], p_note: "Demo: logged labor" });
    if (!t.error) n++;
  }
  const first = open[0];
  const steps = ["Inspect and photograph the defect", "Order the parts", "Replace and torque to spec", "Road test and sign off"];
  const ids: string[] = [];
  for (const title of steps) {
    const r = await db.rpc("maintenance_add_task", { p_wo: first.id, p_title: title });
    if (!r.error) { ids.push(r.data as string); n++; }
  }
  for (const id of ids.slice(0, 2)) await db.rpc("maintenance_set_task", { p_task: id, p_status: "done" });
  return n;
}
