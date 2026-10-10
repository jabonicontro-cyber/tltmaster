// Workflow coordination (N10): urgent orders (flag, acknowledge, states,
// escalation, history, no automatic assignment), per-person hiding and layout
// in the Command Center, clean company defaults, owners who also drive,
// downstream re-evaluation after a ticket correction, and isolation between
// two independent companies. Synthetic data only; every test is rolled back.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { EXCEPTION_KINDS, knowsReason } from "@/lib/command-center/rules";
import { URGENCY_STATES } from "@/lib/orders/urgency";
import { assign, businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;
type Item = { exception_key: string; kind: string; priority: number; reasons: string[]; details: Row; order_id: string | null; hidden_until: string | null };
type Page = { total: number; hidden: number; items: Item[] };

/** Every page of the queue (a well-used database can hold more than 100 open items). */
const queue = async (s: Session, opts: { kind?: string; hidden?: boolean } = {}): Promise<Page> => {
  const at = async (offset: number) => (await s.query<{ r: Page }>("select public.command_center_exceptions($1, false, 100, $3, $2) as r", [opts.kind ?? null, opts.hidden ?? false, offset])).rows[0].r;
  const first = await at(0);
  const items = [...first.items];
  while (items.length < first.total) items.push(...(await at(items.length)).items);
  return { ...first, items };
};
const summary = async (s: Session) => (await s.query<{ r: Row & { exceptions: Record<string, number>; by_kind: Record<string, number> } }>("select public.command_center_summary() as r")).rows[0].r;
const flag = async (s: Session, orderId: string, reason: string, neededBy: string | null = null) =>
  (await s.query<{ r: { urgency_id: string; created: boolean; changed: boolean } }>("select public.flag_order_urgent($1, $2, $3) as r", [orderId, reason, neededBy])).rows[0].r;
const move = async (s: Session, id: string, state: string, note = "") =>
  (await s.query<{ r: { state: string; changed: boolean } }>("select public.update_order_urgency($1, $2::public.urgency_state, $3) as r", [id, state, note])).rows[0].r;
const urgentItems = (p: Page, orderId: string) => p.items.filter((i) => i.kind === "urgent_order" && i.order_id === orderId);

/** A scheduled Top Line order (synthetic, rolled back) with office, dispatcher and mechanic users and a ready fleet. */
async function world(s: Session) {
  const today = await businessToday(s);
  const office = await s.createUser("office");
  const dispatcher = await s.createUser("dispatcher");
  const mechanic = await s.createUser("mechanic");
  const f = await fleet(s, office, today);
  const order = await scheduledOrder(s, office, today, addDays(today, 1), today);
  return { today, office, dispatcher, mechanic, f, order };
}

describe("urgent orders", () => {
  it("office flags, dispatch acknowledges and moves it through states; nothing is assigned automatically; history is kept", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.asAdmin();
      const assignmentsBefore = (await s.query<{ n: number }>("select count(*)::int as n from public.dispatch_assignments where order_id = $1", [w.order.id])).rows[0].n;

      // Only orders.edit can flag.
      await s.as(w.dispatcher);
      expect((await pgError(flag(s, w.order.id, "Customer moved the pour up"))).code).toBe("42501");
      await s.as(w.office);
      expect((await pgError(flag(s, w.order.id, "  "))).code).toBe("22023");
      const f1 = await flag(s, w.order.id, "Customer moved the pour up to 7 AM");
      expect(f1).toMatchObject({ created: true, changed: true });
      // Retrying the same flag changes nothing and never duplicates it.
      expect(await flag(s, w.order.id, "Customer moved the pour up to 7 AM")).toMatchObject({ urgency_id: f1.urgency_id, created: false, changed: false });
      expect((await s.query("select 1 from public.order_urgencies where order_id = $1", [w.order.id])).rowCount).toBe(1);

      // Dispatch sees it first in the queue, awaiting acknowledgement.
      await s.as(w.dispatcher);
      let items = urgentItems(await queue(s), w.order.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ priority: 1, reasons: ["urgent_awaiting_acknowledgement"] });
      expect(items[0].details).toMatchObject({ state: "awaiting_acknowledgement", reason: "Customer moved the pour up to 7 AM", escalated: false, active_assignments: 0 });
      expect((await summary(s)).urgent_orders).toBeGreaterThanOrEqual(1);

      // A mechanic (no orders or dispatch access) does not see it and cannot move it.
      await s.as(w.mechanic);
      expect(urgentItems(await queue(s), w.order.id)).toHaveLength(0);
      expect((await summary(s)).urgent_orders).toBeNull();
      expect((await pgError(move(s, f1.urgency_id, "acknowledged"))).code).toBe("42501");
      expect((await s.query("select 1 from public.order_urgencies where id = $1", [f1.urgency_id])).rowCount).toBe(0); // RLS

      await s.as(w.dispatcher);
      expect((await pgError(move(s, f1.urgency_id, "awaiting_acknowledgement"))).code).toBe("22023");
      expect(await move(s, f1.urgency_id, "acknowledged")).toMatchObject({ state: "acknowledged", changed: true });
      items = urgentItems(await queue(s), w.order.id);
      expect(items[0]).toMatchObject({ priority: 2, reasons: ["urgent_acknowledged"] });
      expect(items[0].details.acknowledged_by_name).toBe("Test dispatcher");
      // Notes are required where they explain something.
      expect((await pgError(move(s, f1.urgency_id, "blocked"))).code).toBe("22023");
      await move(s, f1.urgency_id, "blocked", "No tri-axle free before 9");
      // "Truck assigned" must be true on the board first.
      expect((await pgError(move(s, f1.urgency_id, "assigned"))).message).toMatch(/No truck is assigned/);
      const load = await planLoad(s, w.order.id, w.today, "23:00", "23:59");
      await assign(s, load.load_id, w.f.t1, null, w.f.d1);
      await move(s, f1.urgency_id, "assigned");
      expect(urgentItems(await queue(s), w.order.id)[0]).toMatchObject({ priority: 3 });

      // Withdrawing needs orders.edit; resolving closes it and it leaves the queue.
      expect((await pgError(move(s, f1.urgency_id, "canceled", "x"))).code).toBe("42501");
      await move(s, f1.urgency_id, "resolved", "Delivered at 6:50");
      expect(urgentItems(await queue(s), w.order.id)).toHaveLength(0);
      expect((await pgError(move(s, f1.urgency_id, "evaluating"))).code).toBe("PT409");

      // History: every step, append-only, plus audit events.
      await s.asAdmin();
      const ev = await s.query<{ action: string; to_state: string }>("select action, to_state::text from public.order_urgency_events where urgency_id = $1 order by occurred_at, id", [f1.urgency_id]);
      expect(ev.rows.map((e) => e.to_state)).toEqual(["awaiting_acknowledgement", "acknowledged", "blocked", "assigned", "resolved"]);
      expect((await pgError(s.query("update public.order_urgency_events set note = 'x' where urgency_id = $1", [f1.urgency_id]))).code).toBe("42501");
      const audit = await s.query<{ action: string }>("select action from public.audit_events where entity_id = $1 and action like 'order.urgent%'", [w.order.id]);
      expect(audit.rows.map((a) => a.action).sort()).toEqual(["order.urgent_acknowledged", "order.urgent_assigned", "order.urgent_blocked", "order.urgent_flagged", "order.urgent_resolved"]);
      // The only assignment is the one dispatch made by hand.
      expect((await s.query<{ n: number }>("select count(*)::int as n from public.dispatch_assignments where order_id = $1", [w.order.id])).rows[0].n).toBe(assignmentsBefore + 1);

      // A new flag after resolution is a new item (new key), and canceling the order closes it.
      await s.as(w.office);
      const f2 = await flag(s, w.order.id, "Second rush request");
      expect(f2.urgency_id).not.toBe(f1.urgency_id);
      await s.query("select public.set_order_status($1, 'canceled', 'Customer canceled')", [w.order.id]);
      await s.asAdmin();
      expect((await s.query("select state::text, closed_at is not null as closed from public.order_urgencies where id = $1", [f2.urgency_id])).rows[0]).toEqual({ state: "resolved", closed: true });
      expect((await s.query("select action from public.order_urgency_events where urgency_id = $1 and action = 'closed_with_order'", [f2.urgency_id])).rowCount).toBe(1);
      await s.as(w.office);
      expect((await pgError(flag(s, w.order.id, "Too late"))).code).toBe("22023");
    });
  });

  it("escalates only when the company sets a time, and flags a passed deadline", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const f = await flag(s, w.order.id, "Rush for a city job", new Date(Date.now() + 3600_000).toISOString());
      await s.asAdmin();
      // Age the flag (test setup only; the app cannot change flagged_at).
      await s.query("set local session_replication_role = replica");
      await s.query("update public.order_urgencies set flagged_at = now() - interval '30 minutes', needed_by = now() - interval '1 minute' where id = $1", [f.urgency_id]);
      await s.query("set local session_replication_role = origin");

      await s.as(w.dispatcher);
      let item = urgentItems(await queue(s), w.order.id)[0];
      expect(item.reasons).toEqual(["urgent_awaiting_acknowledgement", "urgent_deadline_passed"]);
      expect(item.details.escalated).toBe(false);

      await s.asAdmin();
      await s.query("update public.company_settings set urgent_ack_minutes = 15 where company_id = $1", [TOP_LINE]);
      await s.as(w.dispatcher);
      item = urgentItems(await queue(s), w.order.id)[0];
      expect(item.reasons).toContain("urgent_ack_overdue");
      expect(item.details.escalated).toBe(true);
      // Only settings.manage changes it (RLS filters the dispatcher's update), and only to a sensible value.
      expect((await s.query("update public.company_settings set urgent_ack_minutes = 30")).rowCount).toBe(0);
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("update public.company_settings set urgent_ack_minutes = 1"))).code).toBe("23514");
    });
  });

  it("the app knows every urgency state and reason code the database uses", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const states = (await s.query<{ v: string }>("select unnest(enum_range(null::public.urgency_state))::text as v")).rows.map((r) => r.v);
      expect(states).toEqual([...URGENCY_STATES]);
      for (const st of states) expect(knowsReason(`urgent_${st}`) || ["resolved", "canceled"].includes(st), st).toBe(true);
      expect(knowsReason("urgent_ack_overdue") && knowsReason("urgent_deadline_passed")).toBe(true);
      expect(EXCEPTION_KINDS).toContain("urgent_order");
    });
  });
});

describe("urgent flags and sample data", () => {
  it("removing sample data also removes urgent flags on sample orders; otherwise flags cannot be deleted", async () => {
    await withSession(async (s) => {
      const w = await world(s); // the order is for a sample customer
      await s.as(w.office);
      const f = await flag(s, w.order.id, "Sample rush");
      await s.asAdmin();
      expect((await pgError(s.query("delete from public.order_urgency_events where urgency_id = $1", [f.urgency_id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.order_urgencies where id = $1", [f.urgency_id]))).code).toBe("42501");
      const owner = await s.createUser("owner");
      await s.as(owner);
      await s.query("select public.remove_sample_data()");
      await s.asAdmin();
      expect((await s.query("select 1 from public.orders where id = $1", [w.order.id])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.order_urgencies where id = $1", [f.urgency_id])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.order_urgency_events where urgency_id = $1", [f.urgency_id])).rowCount).toBe(0);
    });
  });
});

describe("personal Command Center state", () => {
  it("hiding takes a non-urgent item out of your own view only; urgent items cannot be hidden", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const f = await flag(s, w.order.id, "Rush");
      const key = `urgent_order:${f.urgency_id}`;
      expect((await pgError(s.query("select public.hide_exception($1, 4)", [key]))).message).toMatch(/Urgent items cannot be hidden/);
      await s.as(w.dispatcher);
      await move(s, f.urgency_id, "acknowledged"); // now priority 2
      const before = await summary(s);
      expect((await pgError(s.query("select public.hide_exception($1, 500)", [key]))).code).toBe("22023");
      await s.query("select public.hide_exception($1, 4)", [key]);

      const visible = await queue(s);
      expect(visible.items.some((i) => i.exception_key === key)).toBe(false);
      expect(visible.hidden).toBeGreaterThanOrEqual(1);
      const hidden = await queue(s, { hidden: true });
      expect(hidden.items.find((i) => i.exception_key === key)?.hidden_until).toBeTruthy();
      // Still open and still counted; the order's flag is unchanged.
      const after = await summary(s);
      expect(after.exceptions.total).toBe(before.exceptions.total);
      expect(after.exceptions.hidden).toBe((before.exceptions.hidden ?? 0) + 1);
      await s.asAdmin();
      expect((await s.query("select state::text from public.order_urgencies where id = $1", [f.urgency_id])).rows[0].state).toBe("acknowledged");

      // Everyone else still sees it.
      await s.as(w.office);
      expect((await queue(s)).items.some((i) => i.exception_key === key)).toBe(true);
      expect((await s.query("select 1 from public.exception_dismissals")).rowCount).toBe(0); // only your own rows

      await s.as(w.dispatcher);
      await s.query("select public.unhide_exception($1)", [key]);
      expect((await queue(s)).items.some((i) => i.exception_key === key)).toBe(true);
    });
  });

  it("layout preferences are your own, per company, and only layout", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.dispatcher);
      await s.query("select public.save_my_preference('command_center', $1::jsonb)", [JSON.stringify({ order: ["attention", "my_work"], collapsed: ["activity"] })]);
      expect((await s.query("select value from public.user_preferences")).rows[0].value).toEqual({ order: ["attention", "my_work"], collapsed: ["activity"] });
      for (const bad of [{ role: "owner" }, { order: "attention" }, []]) {
        expect((await pgError(s.query("select public.save_my_preference('command_center', $1::jsonb)", [JSON.stringify(bad)]))).code).toBe("22023");
      }
      expect((await pgError(s.query("select public.save_my_preference('permissions', '{}'::jsonb)"))).code).toBe("22023");
      expect((await pgError(s.query("insert into public.user_preferences (company_id, user_id, key, value) values ($1, $2, 'command_center', '{}')", [TOP_LINE, w.office]))).code).toBe("42501");
      await s.as(w.office);
      expect((await s.query("select 1 from public.user_preferences")).rowCount).toBe(0);
    });
  });
});

describe("company defaults and responsibilities", () => {
  it("a new company starts clean: its own name, no inherited state or records, and onboarding sets its own time zone", async () => {
    await withSession(async (s) => {
      const B = await s.createCompany("Cedar Hollow Hauling (test)");
      await s.asAdmin();
      const st = (await s.query<Row>("select company_name, state, urgent_ack_minutes from public.company_settings where company_id = $1", [B])).rows[0];
      expect(st).toEqual({ company_name: "Cedar Hollow Hauling (test)", state: "", urgent_ack_minutes: null });
      for (const t of ["customers", "orders", "trucks", "drivers", "delivery_tickets", "order_urgencies", "materials", "quotes"]) {
        expect((await s.query(`select 1 from public.${t} where company_id = $1`, [B])).rowCount, t).toBe(0);
      }
      expect((await s.query<{ p: string }>("select permission as p from public.role_permissions where company_id = $1 and role = 'owner' and permission = 'driver.portal'", [B])).rowCount).toBe(1);

      // Onboarding with an access code: the time zone is the company's own choice.
      const code = `TLT${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
      const hash = createHash("sha256").update(code).digest("hex");
      await s.query("select public.early_access_create_code($1, 'Coordination test', 1, now() + interval '1 day')", [hash]);
      const user = await s.createUser(null, { membership: false });
      await s.asAdmin();
      await s.query("update auth.users set email_confirmed_at = now() where id = $1", [user]);
      await s.as(user);
      expect((await pgError(s.query("select public.create_company_with_access_code($1, 'Old path (test)', $2)", [hash, randomUUID()]))).code).toBe("42501");
      expect((await pgError(s.query("select public.create_company_with_access_code($1, 'Bad zone (test)', $2, 'Mars/Olympus')", [hash, randomUUID()]))).code).toBe("22023");
      const key = randomUUID();
      const r = (await s.query<{ r: { ok: boolean; company_id: string; created: boolean } }>("select public.create_company_with_access_code($1, 'Mesa Rock (test)', $2, 'America/Phoenix') as r", [hash, key])).rows[0].r;
      expect(r).toMatchObject({ ok: true, created: true });
      expect((await s.query("select timezone from public.company_settings")).rows[0].timezone).toBe("America/Phoenix");
      // The owner changes it; a retry of the original request does not overwrite it.
      await s.query("update public.company_settings set timezone = 'America/Denver'");
      expect((await s.query<{ r: Row }>("select public.create_company_with_access_code($1, 'Mesa Rock (test)', $2, 'America/Phoenix') as r", [hash, key])).rows[0].r).toMatchObject({ created: false });
      expect((await s.query("select timezone from public.company_settings")).rows[0].timezone).toBe("America/Denver");
    });
  });

  it("an owner who also drives sees their own loads once linked to a driver record; without driver.portal a link grants nothing", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.driver_portal_home()"))).message).toMatch(/not linked/);
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [w.f.d1, owner]);
      await s.as(w.office);
      const load = await planLoad(s, w.order.id, w.today, "22:00", "23:00");
      await assign(s, load.load_id, w.f.t1, null, w.f.d1);
      await s.as(owner);
      const home = (await s.query<{ r: { assignments: Array<{ load: { id: string } }> } }>("select public.driver_portal_home() as r")).rows[0].r;
      expect(home.assignments.map((a) => a.load.id)).toContain(load.load_id);
      // Same link for a dispatcher (no driver.portal): refused — a responsibility is not a permission.
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [w.f.d2, w.dispatcher]);
      await s.as(w.dispatcher);
      expect((await pgError(s.query("select public.driver_portal_home()"))).code).toBe("42501");
    });
  });
});

describe("downstream re-evaluation", () => {
  it("correcting a verified ticket re-evaluates the queue and billing readiness in one step; billing is never approved automatically", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const yesterday = addDays(today, -1);
      const office = await s.createUser("office");
      const f = await fleet(s, office, yesterday);
      const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
      const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "40", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);
      const payload = { load_id: load.load_id, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30", quantity: "40", unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 6)}` };
      const t = (await s.query<{ r: { ticket_id: string; ticket_number: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify(payload)])).rows[0].r;
      // Received is not verified.
      const readiness = async () => (await s.query<{ readiness: string }>("select readiness from public.billing_order_status where order_id = $1", [order.id])).rows[0].readiness;
      expect(await readiness()).toBe("needs_review");
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
      await s.query("select public.set_order_status($1, 'in_progress', '')", [order.id]);
      await s.query("select public.set_order_status($1, 'completed', '')", [order.id]);
      const kinds = async () => (await s.query<{ kind: string }>("select kind from public.billing_exceptions where order_id = $1 order by kind", [order.id])).rows.map((r) => r.kind);
      // Blocked only by the hauling line, which has no ticket of its own; the material load matches its plan.
      expect(await readiness()).toBe("blocked");
      expect(await kinds()).not.toContain("load_quantity");

      // A correction makes a new revision that must be verified again, and billing follows at once.
      const c = (await s.query<{ r: { ticket_id: string } }>("select public.correct_delivery_ticket($1, $2::jsonb, 'Scale reissued') as r", [t.ticket_id, JSON.stringify({ ...payload, quantity: "36" })])).rows[0].r;
      const status = (await s.query<{ status: string }>("select status from public.delivery_tickets where id = $1", [c.ticket_id])).rows[0].status;
      expect(["submitted", "needs_review"]).toContain(status);
      expect(await readiness()).toBe("needs_review");
      expect((await s.query<{ r: Page }>("select public.command_center_exceptions('ticket_review', false, 100, 0) as r")).rows[0].r.items.some((i) => i.exception_key === `ticket_review:${t.ticket_number}`)).toBe(true);
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [c.ticket_id]);
      // 36 t delivered vs 40 t planned: a new difference to acknowledge appears — nothing became "ready" silently.
      expect(await readiness()).toBe("blocked");
      expect(await kinds()).toContain("load_quantity");
      expect((await s.query("select 1 from public.billing_handoff_orders where order_id = $1", [order.id])).rowCount).toBe(0);
      // No driver-pay data model exists yet: billing readiness says nothing about payroll.
      await s.asAdmin();
      expect((await s.query("select 1 from information_schema.tables where table_schema = 'public' and table_name ilike '%payroll%'")).rowCount).toBe(0);
      expect((await s.query("select 1 from public.permissions where code ilike 'payroll%'")).rowCount).toBe(0);
    });
  });
});

describe("two independent companies", () => {
  it("urgent flags, hidden items, preferences and queue items never cross companies, by id or by key", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const f = await flag(s, w.order.id, "Top Line rush (test)");
      await s.as(w.dispatcher);
      await s.query("select public.save_my_preference('command_center', '{\"order\":[\"attention\"]}'::jsonb)");

      const B = await s.createCompany("Brookside Aggregates (test)");
      const bOwner = await s.createUser("owner", { companyId: B });
      const bDispatcher = await s.createUser("dispatcher", { companyId: B });
      await s.as(bOwner);
      const bCustomer = await insert(s, "customers", { name: "Riverbend Builders (test)" });
      expect(bCustomer).toBeTruthy();

      await s.as(bOwner);
      expect((await s.query("select 1 from public.order_urgencies")).rowCount).toBe(0);
      expect((await s.query("select 1 from public.order_urgency_events")).rowCount).toBe(0);
      expect((await pgError(flag(s, w.order.id, "Not mine"))).code).toBe("P0002");
      expect((await pgError(move(s, f.urgency_id, "resolved", "x"))).code).toBe("P0002");
      expect((await pgError(s.query("select public.hide_exception($1, 4)", [`urgent_order:${f.urgency_id}`]))).code).toBe("PT409");
      const bq = await queue(s);
      expect(bq.items.some((i) => i.order_id === w.order.id)).toBe(false);
      expect((await summary(s)).urgent_orders).toBe(0);
      expect((await s.query("select 1 from public.user_preferences")).rowCount).toBe(0);

      // A person in both companies sees each company's items only while it is active.
      await s.asAdmin();
      await s.query("insert into public.company_memberships (company_id, user_id, role) values ($1, $2, 'dispatcher')", [B, w.dispatcher]);
      await s.as(w.dispatcher);
      expect(urgentItems(await queue(s), w.order.id)).toHaveLength(1);
      await s.query("select public.switch_company($1)", [B]);
      expect(urgentItems(await queue(s), w.order.id)).toHaveLength(0);
      expect((await s.query("select 1 from public.order_urgencies")).rowCount).toBe(0);
      expect((await s.query("select 1 from public.user_preferences")).rowCount).toBe(0); // Top Line layout stays with Top Line
      expect((await pgError(move(s, f.urgency_id, "acknowledged"))).code).toBe("P0002");
      await s.query("select public.switch_company($1)", [TOP_LINE]);
      expect(urgentItems(await queue(s), w.order.id)).toHaveLength(1);
      expect(bDispatcher).toBeTruthy();
    });
  });
});
