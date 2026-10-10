// Command center: exception classification, deduplication, exceptions
// disappearing when their records change, priority and paging, per-role
// visibility, assignment to a person, the billing audit restriction and
// company isolation.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EXCEPTION_KINDS, knowsReason } from "@/lib/command-center/rules";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Item = {
  exception_key: string;
  kind: string;
  priority: number;
  since: string | null;
  reasons: string[];
  details: Record<string, unknown>;
  load_id: string | null;
  order_id: string | null;
  ticket_id: string | null;
  equipment_id: string | null;
  assigned_to: string | null;
  assignee_name: string | null;
};
type Page = { total: number; limit: number; offset: number; items: Item[] };

const queue = async (s: Session, opts: { kind?: string | null; mine?: boolean; limit?: number; offset?: number } = {}) =>
  (await s.query<{ r: Page }>("select public.command_center_exceptions($1, $2, $3, $4) as r", [opts.kind ?? null, opts.mine ?? false, opts.limit ?? 100, opts.offset ?? 0])).rows[0].r;
const summary = async (s: Session) => (await s.query<{ r: Record<string, unknown> & { by_kind: Record<string, number>; exceptions: Record<string, number> } }>("select public.command_center_summary() as r")).rows[0].r;
const mineOnly = (p: Page, ids: string[]) => p.items.filter((i) => ids.some((id) => i.exception_key.includes(id)));
const submit = async (s: Session, payload: Record<string, unknown>) =>
  (await s.query<{ r: { ticket_id: string; ticket_number: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify(payload)])).rows[0].r;

/** A scheduled order (two days back to two days ahead) for a fresh office user, with a ready fleet. */
async function world(s: Session) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const office = await s.createUser("office");
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  return { today, yesterday, tomorrow: addDays(today, 1), office, f, order };
}

describe("exception classification and deduplication", () => {
  it("lists each underlying issue once, and an item leaves the queue only when its record changes", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const past = await planLoad(s, w.order.id, w.yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
      await assign(s, past.load_id, w.f.t1, null, w.f.d1);
      const pastUnassigned = await planLoad(s, w.order.id, w.yesterday, "10:00", "11:00");
      const later = await planLoad(s, w.order.id, w.today, "23:00", "23:59");
      const ids = [past.load_id, pastUnassigned.load_id, later.load_id, w.order.id];

      let items = mineOnly(await queue(s), ids);
      expect(items.map((i) => [i.kind, i.load_id])).toEqual(
        expect.arrayContaining([["missing_ticket", past.load_id], ["missing_ticket", pastUnassigned.load_id], ["unassigned_load", later.load_id]]),
      );
      expect(items).toHaveLength(3); // the past unassigned load is a missing ticket, not also an unassigned load
      expect(items.find((i) => i.load_id === pastUnassigned.load_id)?.reasons).toEqual(["no_ticket", "not_assigned"]);
      const unassigned = items.find((i) => i.kind === "unassigned_load")!;
      expect(unassigned).toMatchObject({ priority: 1, reasons: ["no_assignment"] });
      expect(items.find((i) => i.load_id === past.load_id)).toMatchObject({ priority: 2 });
      expect(new Set(items.map((i) => i.exception_key)).size).toBe(items.length);
      // Urgent first, then oldest first.
      expect(items[0].kind).toBe("unassigned_load");

      // Assigning the load resolves the item; nothing else is needed.
      await assign(s, later.load_id, w.f.t2, null, w.f.d2);
      items = mineOnly(await queue(s), ids);
      expect(items.some((i) => i.kind === "unassigned_load")).toBe(false);

      // A ticket replaces "missing" by "to review"; accepting it clears that too.
      const t = await submit(s, { load_id: past.load_id, order_line_id: w.order.materialLine, delivered_date: w.yesterday, delivered_time: "08:30", quantity: "21.47", unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 6)}` });
      items = mineOnly(await queue(s), [...ids, t.ticket_number]);
      expect(items.find((i) => i.load_id === past.load_id)).toMatchObject({ kind: "ticket_review", priority: 3, reasons: ["awaiting_acceptance"], ticket_id: t.ticket_id });
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);

      // The order still has a missing ticket, so it is not also listed as a billing block.
      items = mineOnly(await queue(s), [...ids, t.ticket_number]);
      expect(items.map((i) => i.kind).sort()).toEqual(["missing_ticket"]);
      await s.query("select public.cancel_order_load($1, 'Did not run (test)')", [pastUnassigned.load_id]);
      items = mineOnly(await queue(s), ids);
      expect(items).toEqual([expect.objectContaining({ kind: "billing_blocked", order_id: w.order.id, priority: 3, since: null, reasons: ["exceptions_unacknowledged"] })]);

      // Acknowledging the difference unblocks billing.
      const st = (await s.query<{ f: string }>("select exceptions_fingerprint as f from public.billing_order_status where order_id = $1", [w.order.id])).rows[0];
      await s.query("select public.acknowledge_billing_exceptions($1, $2, 'Short load accepted (test)')", [w.order.id, st.f]);
      expect(mineOnly(await queue(s), ids)).toEqual([]);
      for (const i of [unassigned]) for (const r of i.reasons) expect(knowsReason(r), r).toBe(true);
    });
  });

  it("flags equipment out of service once per unit, and the upcoming assignments on it once each", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const tomorrow = await planLoad(s, w.order.id, w.tomorrow, "07:00", "09:00");
      const a = await assign(s, tomorrow.load_id, w.f.t2, null, w.f.d2);
      await s.query("select public.set_equipment_service_status('truck', $1, 'out_of_service', 'Hydraulic leak (test)', $2)", [w.f.t2, addDays(w.today, 5)]);

      const items = mineOnly(await queue(s), [w.f.t2, a]);
      expect(items).toHaveLength(2);
      expect(items.find((i) => i.kind === "assignment_problem")).toMatchObject({ priority: 1, reasons: ["truck_out_of_service"], load_id: tomorrow.load_id });
      expect(items.find((i) => i.kind === "equipment_out_of_service")).toMatchObject({
        priority: 2, equipment_id: w.f.t2, reasons: ["out_of_service"],
        details: expect.objectContaining({ reason: "Hydraulic leak (test)", upcoming_loads: 1 }),
      });
      for (const i of items) for (const r of i.reasons) expect(knowsReason(r), r).toBe(true);

      // Back in service: both items disappear.
      await s.query("select public.set_equipment_service_status('truck', $1, 'in_service', '', null)", [w.f.t2]);
      expect(mineOnly(await queue(s), [w.f.t2, a])).toEqual([]);

      // Moving the order's dates leaves the load outside them: a scheduling problem on the assignment.
      await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [w.order.id, JSON.stringify({ scheduled_start: addDays(w.today, -2), scheduled_end: w.today })]);
      expect(mineOnly(await queue(s), [a])).toEqual([expect.objectContaining({ kind: "assignment_problem", reasons: ["load_outside_schedule"] })]);
    });
  });
});

describe("visibility by role and company", () => {
  it("shows each role only the kinds and figures its permissions cover; drivers and signed-out users are refused", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const past = await planLoad(s, w.order.id, w.yesterday, "07:00", "09:00");
      await assign(s, past.load_id, w.f.t1, null, w.f.d1);
      await s.query("select public.set_equipment_service_status('truck', $1, 'out_of_service', 'Brakes (test)', null)", [w.f.t2]);

      const office = await summary(s);
      for (const k of ["loads_today", "unassigned_loads", "missing_tickets", "tickets_to_review", "billing_blocked", "billing_ready", "trucks_out_of_service"]) {
        expect(office[k], k).not.toBeNull();
      }
      expect(office.can).toMatchObject({ assign: true, billing: true });

      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      const d = await summary(s);
      expect(d).toMatchObject({ billing_blocked: null, billing_ready: null, can: expect.objectContaining({ billing: false, assign: false }) });
      expect(d.missing_tickets).not.toBeNull();
      const dq = await queue(s);
      expect(dq.items.some((i) => i.kind === "billing_blocked")).toBe(false);
      expect(dq.items.some((i) => i.load_id === past.load_id && i.kind === "missing_ticket")).toBe(true);
      expect((await queue(s, { kind: "billing_blocked" })).total).toBe(0);

      const mechanic = await s.createUser("mechanic");
      await s.as(mechanic);
      const m = await summary(s);
      expect(m).toMatchObject({ loads_today: null, missing_tickets: null, tickets_to_review: null, billing_blocked: null, unassigned_loads: null, assignment_problems: null });
      expect(m.trucks_out_of_service).not.toBeNull();
      const mq = await queue(s);
      expect(new Set(mq.items.map((i) => i.kind))).toEqual(new Set(["equipment_out_of_service"]));

      for (const role of ["driver", null] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await pgError(summary(s))).code, String(role)).toBe("42501");
        expect((await pgError(queue(s))).code, String(role)).toBe("42501");
      }
      await s.as(null);
      expect((await pgError(summary(s))).code).toBe("42501");
      expect((await pgError(s.query("select private.operational_exceptions($1)", [w.order.id]))).code).toBe("42501");
    });
  });

  it("another company sees none of Top Line's items and cannot act on them", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const past = await planLoad(s, w.order.id, w.yesterday, "07:00", "09:00");
      const key = `missing_ticket:${past.load_id}`;
      expect((await queue(s)).items.some((i) => i.exception_key === key)).toBe(true);

      const B = await s.createCompany("Brookside Aggregates (test)");
      const bOwner = await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      const bq = await queue(s);
      expect(bq).toMatchObject({ total: 0, items: [] });
      expect(await summary(s)).toMatchObject({ exceptions: { total: 0, urgent: 0, mine: 0 }, missing_tickets: 0, loads_today: 0 });
      expect((await pgError(s.query("select public.assign_exception($1, $2, '')", [key, bOwner]))).code).toBe("PT409");
      expect((await pgError(s.query("select public.assign_exception($1, $2, '')", [key, w.office]))).code).toBe("PT409");
      expect((await s.query("select id from public.exception_assignments")).rowCount).toBe(0);
    });
  });

  it("billing entries in order history are visible only with billing.view", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      await s.asAdmin();
      await s.query("insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary) values ('00000000-0000-4000-8000-000000000001', $1, 'billing.handed_off', 'order', $2, 'Handed off (test)'), ('00000000-0000-4000-8000-000000000001', $1, 'order.status_changed', 'order', $2, 'Status (test)')", [w.office, w.order.id]);
      await s.as(w.office);
      expect((await s.query("select action from public.audit_events where entity_id = $1 and summary like '%(test)' order by action", [w.order.id])).rows.map((r) => r.action)).toEqual(["billing.handed_off", "order.status_changed"]);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await s.query("select action from public.audit_events where entity_id = $1 and summary like '%(test)'", [w.order.id])).rows.map((r) => r.action)).toEqual(["order.status_changed"]);
    });
  });
});

describe("paging and filters", () => {
  it("returns bounded, ordered pages with a total, and validates the filter", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      for (let i = 0; i < 4; i++) await planLoad(s, w.order.id, w.yesterday, `0${i + 1}:00`, `0${i + 1}:30`);
      const all = await queue(s, { limit: 1000 });
      expect(all.limit).toBe(100);
      expect(all.total).toBeGreaterThanOrEqual(4);
      const p1 = await queue(s, { limit: 2, offset: 0 });
      const p2 = await queue(s, { limit: 2, offset: 2 });
      expect(p1.items).toHaveLength(2);
      expect(p1.total).toBe(all.total);
      expect(p2.items[0].exception_key).toBe(all.items[2].exception_key);
      const pr = all.items.map((i) => i.priority);
      expect(pr).toEqual([...pr].sort((a, b) => a - b));
      expect((await queue(s, { limit: 0 })).limit).toBe(1);
      const missing = await queue(s, { kind: "missing_ticket" });
      expect(missing.items.every((i) => i.kind === "missing_ticket")).toBe(true);
      expect((await pgError(queue(s, { kind: "everything" }))).message).toMatch(/Unknown exception type/);
    });
  });
});

describe("assigning an item to a person", () => {
  it("assigns only open items to people who can resolve them, keeps the history, and never closes the item", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const past = await planLoad(s, w.order.id, w.yesterday, "07:00", "09:00");
      await assign(s, past.load_id, w.f.t1, null, w.f.d1);
      const key = `missing_ticket:${past.load_id}`;
      const dispatcher = await s.createUser("dispatcher");
      const mechanic = await s.createUser("mechanic");
      const office2 = await s.createUser("office");

      const options = (await s.query<{ r: Array<{ user_id: string; kinds: string[] }> }>("select public.exception_assignee_options() as r")).rows[0].r;
      expect(options.find((o) => o.user_id === dispatcher)?.kinds).toEqual(expect.arrayContaining(["missing_ticket", "unassigned_load"]));
      expect(options.find((o) => o.user_id === dispatcher)?.kinds).not.toContain("billing_blocked");
      expect(options.find((o) => o.user_id === mechanic)?.kinds).toEqual(["equipment_out_of_service"]);

      expect((await pgError(s.query("select public.assign_exception($1, $2, '')", [key, mechanic]))).message).toMatch(/cannot resolve this item \(needs tickets.edit\)/);
      await s.query("select public.assign_exception($1, $2, 'Paper is in the truck (test)')", [key, dispatcher]);
      expect((await pgError(s.query("select public.assign_exception($1, $2, '')", [key, dispatcher]))).code).toBe("PT409");
      let item = (await queue(s)).items.find((i) => i.exception_key === key)!;
      expect(item).toMatchObject({ assigned_to: dispatcher, assignee_name: "Test dispatcher" });

      await s.query("select public.assign_exception($1, $2, '')", [key, office2]);
      const rows = (await s.query<{ assigned_to: string; end_reason: string }>("select assigned_to, end_reason from public.exception_assignments where exception_key = $1 order by assigned_at, ended_at nulls last", [key])).rows;
      expect(rows).toEqual([{ assigned_to: dispatcher, end_reason: "reassigned" }, { assigned_to: office2, end_reason: "" }]);
      expect((await s.query("select 1 from public.audit_events where action = 'exception.assigned' and entity_id = $1", [w.order.id])).rowCount).toBe(2);

      // The assignee sees it under "mine"; the dispatcher cannot assign.
      await s.as(office2);
      expect((await queue(s, { mine: true })).items.map((i) => i.exception_key)).toContain(key);
      expect((await summary(s)).exceptions).toMatchObject({ mine: expect.any(Number) });
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.assign_exception($1, $2, '')", [key, dispatcher]))).code).toBe("42501");
      // A former assignee still reads their own (ended) row, nothing else.
      expect((await s.query<{ assigned_to: string }>("select assigned_to from public.exception_assignments where exception_key = $1", [key])).rows).toEqual([{ assigned_to: dispatcher }]);

      // Writes only through the functions; rows only end once.
      await s.as(w.office);
      expect((await pgError(s.query("insert into public.exception_assignments (company_id, exception_key, kind, assigned_to) values ('00000000-0000-4000-8000-000000000001', 'x:y', 'missing_ticket', $1)", [w.office]))).code).toBe("42501");
      await s.asAdmin();
      expect((await pgError(s.query("update public.exception_assignments set note = 'changed' where exception_key = $1", [key]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.exception_assignments where exception_key = $1", [key]))).code).toBe("42501");

      // Fixing the record closes the item; the assignment does not keep it open.
      await s.as(w.office);
      await submit(s, { load_id: past.load_id, order_line_id: w.order.materialLine, delivered_date: w.yesterday, delivered_time: "08:00", quantity: "20", unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 6)}` });
      item = (await queue(s)).items.find((i) => i.exception_key === key)!;
      expect(item).toBeUndefined();
      expect((await pgError(s.query("select public.assign_exception($1, $2, '')", [key, dispatcher]))).message).toMatch(/no longer open/);
      await s.query("select public.unassign_exception($1)", [key]);
      expect((await pgError(s.query("select public.unassign_exception($1)", [key]))).code).toBe("PT409");
    });
  });
});

describe("rule parity", () => {
  it("the app knows every exception kind the database produces", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const src = (await s.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'exception_resolve_permission'")).rows[0].src;
      const kinds = [...src.matchAll(/when '([a-z_]+)'/g)].map((m) => m[1]);
      expect(kinds.sort()).toEqual([...EXCEPTION_KINDS].sort());
    });
  });
});
