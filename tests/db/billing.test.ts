// Ticket reconciliation and billing readiness: missing tickets, review state,
// quantity comparisons (same unit only), readiness precedence, acknowledgments
// and their invalidation, billing handoff (duplicates, idempotency, undo,
// concurrency), pricing integrity, permissions and company isolation.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EXCEPTION_KINDS, READINESS } from "@/lib/billing/rules";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;

async function submit(s: Session, payload: Row) {
  const r = await s.query<{ r: { ticket_id: string; ticket_number: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify(payload)]);
  return r.rows[0].r;
}
const review = (s: Session, id: string, action: string, note = "") => s.query("select public.review_delivery_ticket($1, $2, $3)", [id, action, note]);
const correct = async (s: Session, id: string, payload: Row, reason: string) =>
  (await s.query<{ r: { ticket_id: string } }>("select public.correct_delivery_ticket($1, $2::jsonb, $3) as r", [id, JSON.stringify(payload), reason])).rows[0].r;
const orderStatus = async (s: Session, id: string) => (await s.query<Row>("select * from public.billing_order_status where order_id = $1", [id])).rows[0];
const loadStatus = async (s: Session, id: string) => (await s.query<Row>("select *, delivered_quantity::text as delivered, quantity_difference::text as diff from public.billing_load_status where load_id = $1", [id])).rows[0];
const exceptions = async (s: Session, orderId: string) =>
  (await s.query<Row>("select kind, load_id, line_id, expected_quantity::text as expected, actual_quantity::text as actual, unit_code, difference::text as diff from public.billing_exceptions where order_id = $1 order by kind", [orderId])).rows;
const acknowledge = (s: Session, orderId: string, fingerprint: unknown, reason: string) =>
  s.query("select public.acknowledge_billing_exceptions($1, $2, $3)", [orderId, fingerprint, reason]);
const handOff = async (s: Session, ids: string[], key: string | null = randomUUID(), ref = "") =>
  (await s.query<{ r: { handoff_id: string; batch_number: string; created: boolean; orders: number } }>("select public.hand_off_orders($1::uuid[], $2, '', $3) as r", [ids, ref, key])).rows[0].r;

/** An order (gravel 40 t + hauling 40 t) scheduled from two days ago to two days ahead, with an assigned load yesterday planned at 22 t. */
async function world(s: Session) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const office = await s.createUser("office");
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
  await assign(s, load.load_id, f.t1, null, f.d1);
  const payload = (extra: Row = {}) => ({
    load_id: load.load_id,
    order_line_id: order.materialLine,
    delivered_date: yesterday,
    delivered_time: "08:30",
    quantity: "22",
    unit_code: "ton",
    external_reference: `SC-${randomUUID().slice(0, 8)}`,
    ...extra,
  });
  return { today, yesterday, office, f, order, load, payload };
}

const complete = async (s: Session, orderId: string) => {
  await s.query("select public.set_order_status($1, 'in_progress', '')", [orderId]);
  await s.query("select public.set_order_status($1, 'completed', '')", [orderId]);
};

/** A completed order (40 t delivered on a 22 t load plan; hauling without a ticket) with its exceptions acknowledged: ready to bill. */
async function readyOrder(s: Session) {
  const w = await world(s);
  await s.as(w.office);
  const t = await submit(s, w.payload({ quantity: "40", delivered_time: "08:00" }));
  await review(s, t.ticket_id, "accept");
  await complete(s, w.order.id);
  const st = await orderStatus(s, w.order.id);
  await acknowledge(s, w.order.id, st.exceptions_fingerprint, "Hauling billed on delivered tons (test)");
  return { ...w, ticket: t };
}

describe("missing tickets and review", () => {
  it("lists due loads without a live ticket, ignores future and canceled loads, and follows the ticket through review, correction and void", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const future = await planLoad(s, w.order.id, addDays(w.today, 1), "07:00", "09:00");
      const unassigned = await planLoad(s, w.order.id, w.yesterday, "10:00", "11:00");
      const canceled = await planLoad(s, w.order.id, w.yesterday, "12:00", "13:00");
      await s.query("select public.cancel_order_load($1, 'Did not run (test)')", [canceled.load_id]);

      expect(await loadStatus(s, w.load.load_id)).toMatchObject({ documentation_state: "missing", is_due: true, live_count: 0 });
      expect(await loadStatus(s, future.load_id)).toMatchObject({ documentation_state: "not_due", is_due: false });
      expect(await loadStatus(s, unassigned.load_id)).toMatchObject({ documentation_state: "missing", assignment_id: null });
      expect(await loadStatus(s, canceled.load_id)).toBeUndefined();
      expect(await orderStatus(s, w.order.id)).toMatchObject({ readiness: "missing_documentation", loads_missing: 2, loads_not_due: 1, loads_total: 3 });

      const t = await submit(s, w.payload({ quantity: "21.47" }));
      expect(await loadStatus(s, w.load.load_id)).toMatchObject({ documentation_state: "needs_review", pending_count: 1 });
      await s.query("select public.cancel_order_load($1, 'Not needed (test)')", [unassigned.load_id]);
      // A pending ticket outranks the exception and the open order.
      expect(await orderStatus(s, w.order.id)).toMatchObject({ readiness: "needs_review", tickets_pending: 1 });

      await review(s, t.ticket_id, "accept");
      expect(await loadStatus(s, w.load.load_id)).toMatchObject({ documentation_state: "documented", quantity_check: "under", delivered: "21.470", diff: "-0.530" });
      // The quantity exception blocks, even before the order is completed.
      expect(await orderStatus(s, w.order.id)).toMatchObject({ readiness: "blocked", exceptions_count: 1 });

      // A correction supersedes revision 1; only the current revision counts.
      const c = await correct(s, t.ticket_id, w.payload({ quantity: "22", external_reference: "" }), "Scale copy re-read (test)");
      expect(await loadStatus(s, w.load.load_id)).toMatchObject({ live_count: 1, delivered: "22.000", documentation_state: "needs_review" });
      await review(s, c.ticket_id, "accept");
      expect(await loadStatus(s, w.load.load_id)).toMatchObject({ quantity_check: "match", diff: "0.000" });
      expect(await orderStatus(s, w.order.id)).toMatchObject({ readiness: "in_progress", exceptions_count: 0 });

      // Voided without a replacement: the load is missing its ticket again.
      await review(s, c.ticket_id, "void", "Wrong load (test)");
      const after = await loadStatus(s, w.load.load_id);
      expect(after).toMatchObject({ documentation_state: "missing", live_count: 0 });
      expect(after.voided_numbers).toEqual([t.ticket_number]);
      expect(await orderStatus(s, w.order.id)).toMatchObject({ readiness: "missing_documentation" });
    });
  });

  it("a completed order without any ticket is missing documentation; canceled and on-hold orders are out of scope", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      await s.query("select public.cancel_order_load($1, 'Not run (test)')", [w.load.load_id]);
      await complete(s, w.order.id);
      expect(await orderStatus(s, w.order.id)).toMatchObject({ readiness: "missing_documentation", loads_total: 0, tickets_live: 0 });

      const other = await scheduledOrder(s, w.office, w.today, null, w.today);
      expect(await orderStatus(s, other.id)).toMatchObject({ readiness: "in_progress" });
      await s.query("select public.set_order_status($1, 'on_hold', 'Customer asked to wait (test)')", [other.id]);
      expect(await orderStatus(s, other.id)).toBeUndefined();
    });
  });
});

describe("quantity reconciliation", () => {
  it("compares only in the same recorded unit, never converts, skips loads without a plan and checks lines once the order is completed", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      // A ticket in loads against a plan in tons cannot be compared.
      const t = await submit(s, w.payload({ quantity: "1", unit_code: "load" }));
      await review(s, t.ticket_id, "accept");
      const l = await loadStatus(s, w.load.load_id);
      expect(l).toMatchObject({ quantity_check: "units_differ", diff: null, delivered: null, other_unit_count: 1 });
      expect(await exceptions(s, w.order.id)).toEqual([expect.objectContaining({ kind: "load_units_differ", expected: "22.000", actual: null, diff: null })]);

      // No planned quantity: not compared and not an exception.
      const unplanned = await planLoad(s, w.order.id, w.yesterday, "10:00", "11:00");
      await assign(s, unplanned.load_id, w.f.t2, null, w.f.d2);
      const t2 = await submit(s, w.payload({ load_id: unplanned.load_id, quantity: "18.5", delivered_time: "10:30" }));
      await review(s, t2.ticket_id, "accept");
      expect(await loadStatus(s, unplanned.load_id)).toMatchObject({ quantity_check: "not_planned", diff: null });

      // Lines are compared once the order is completed.
      const lines = async () =>
        (await s.query<Row>("select line_id, quantity_check, delivered_quantity::text as delivered, quantity_difference::text as diff from public.billing_line_status where order_id = $1 order by line_no", [w.order.id])).rows;
      expect((await lines()).map((r) => r.quantity_check)).toEqual(["in_progress", "in_progress"]);
      await complete(s, w.order.id);
      // Gravel: 18.5 t + 1 load → the load ticket makes the line not comparable. Hauling: no ticket.
      expect(await lines()).toEqual([
        expect.objectContaining({ line_id: w.order.materialLine, quantity_check: "units_differ", diff: null }),
        expect.objectContaining({ line_id: w.order.haulingLine, quantity_check: "no_tickets", delivered: null, diff: null }),
      ]);
      expect((await exceptions(s, w.order.id)).map((e) => e.kind)).toEqual(["line_no_tickets", "line_units_differ", "load_units_differ"]);

      // Replace the load ticket with tons: the line becomes comparable (18.5 + 22.5 = 41 > 40 ordered).
      await review(s, t.ticket_id, "void", "Entered in the wrong unit (test)");
      const t3 = await submit(s, w.payload({ quantity: "22.5" }));
      await review(s, t3.ticket_id, "accept");
      expect((await lines())[0]).toMatchObject({ quantity_check: "over", delivered: "41.000", diff: "1.000" });
      const ex = await exceptions(s, w.order.id);
      expect(ex).toContainEqual(expect.objectContaining({ kind: "line_quantity", expected: "40.000", actual: "41.000", unit_code: "ton", diff: "1.000" }));
      expect(ex).toContainEqual(expect.objectContaining({ kind: "load_quantity", expected: "22.000", actual: "22.500", diff: "0.500" }));
    });
  });

  it("flags a missing PO when the customer requires one, and a zero rate", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.asAdmin();
      await s.query("update public.customers set po_required = true where id = (select customer_id from public.orders where id = $1)", [w.order.id]);
      await s.as(w.office);
      expect((await exceptions(s, w.order.id)).map((e) => e.kind)).toEqual(["po_missing"]);
      await s.query("select public.update_order_details($1, null, $2::jsonb)", [w.order.id, JSON.stringify({ customer_po: "PO-778 (test)" })]);
      expect(await exceptions(s, w.order.id)).toEqual([]);
    });
  });
});

describe("acknowledging exceptions", () => {
  it("records who and why for exactly the exceptions shown, and stops counting when they change", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const t = await submit(s, w.payload({ quantity: "21.47" }));
      await review(s, t.ticket_id, "accept");
      await complete(s, w.order.id);
      const before = await orderStatus(s, w.order.id);
      expect(before).toMatchObject({ readiness: "blocked", exceptions_count: 3 }); // load under, gravel under, hauling no ticket

      expect((await pgError(acknowledge(s, w.order.id, "0".repeat(32), "x"))).code).toBe("PT409");
      expect((await pgError(acknowledge(s, w.order.id, before.exceptions_fingerprint, "  "))).message).toMatch(/Enter the reason/);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(acknowledge(s, w.order.id, before.exceptions_fingerprint, "x"))).code).toBe("42501");

      await s.as(w.office);
      await acknowledge(s, w.order.id, before.exceptions_fingerprint, "Customer agreed to bill delivered tons (test)");
      const acked = await orderStatus(s, w.order.id);
      expect(acked).toMatchObject({ readiness: "ready", acknowledged_by: w.office, acknowledgment_reason: "Customer agreed to bill delivered tons (test)" });
      expect((await pgError(acknowledge(s, w.order.id, before.exceptions_fingerprint, "again"))).code).toBe("PT409");
      const rev = (await s.query<{ exceptions: unknown[] }>("select exceptions from public.billing_reviews where order_id = $1", [w.order.id])).rows;
      expect(rev).toHaveLength(1);
      expect(rev[0].exceptions).toHaveLength(3);
      const audit = await s.query("select summary from public.audit_events where entity_id = $1 and action = 'billing.exceptions_acknowledged'", [w.order.id]);
      expect(audit.rowCount).toBe(1);

      // A correction changes the compared quantities: the acknowledgment no longer applies.
      const c = await correct(s, t.ticket_id, w.payload({ quantity: "21.9" }), "Re-read the scale ticket (test)");
      expect(await orderStatus(s, w.order.id)).toMatchObject({ readiness: "needs_review" });
      await review(s, c.ticket_id, "accept");
      const stale = await orderStatus(s, w.order.id);
      expect(stale).toMatchObject({ readiness: "blocked", acknowledgment_id: null });
      expect(stale.exceptions_fingerprint).not.toBe(before.exceptions_fingerprint);
      expect(stale.last_acknowledged_at).not.toBeNull();

      // The record is append-only.
      await s.asAdmin();
      expect((await pgError(s.query("update public.billing_reviews set reason = 'changed' where order_id = $1", [w.order.id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.billing_reviews where order_id = $1", [w.order.id]))).code).toBe("42501");
    });
  });
});

describe("billing handoff", () => {
  it("hands off only ready orders, once, without touching the order, and keeps a stable snapshot", async () => {
    await withSession(async (s) => {
      const w = await readyOrder(s);
      await s.as(w.office);
      const notReady = await scheduledOrder(s, w.office, w.today, null, w.today);
      expect((await pgError(handOff(s, [w.order.id, notReady.id]))).message).toMatch(new RegExp(`Not ready: ${notReady.number} \\(in progress\\)`));
      expect((await pgError(handOff(s, []))).message).toMatch(/Choose at least one order/);

      const orderBefore = (await s.query("select to_jsonb(o) - 'updated_at' as o from public.orders o where id = $1", [w.order.id])).rows[0].o;
      const linesBefore = (await s.query("select jsonb_agg(to_jsonb(l) order by line_no) as l from public.order_lines l where order_id = $1", [w.order.id])).rows[0].l;

      const key = randomUUID();
      const r = await handOff(s, [w.order.id], key, "QB batch Oct (test)");
      expect(r).toMatchObject({ created: true, orders: 1 });
      expect(r.batch_number).toMatch(/^BIL-\d{4,}$/);
      expect(await handOff(s, [w.order.id], key)).toMatchObject({ handoff_id: r.handoff_id, created: false });
      const dup = await pgError(handOff(s, [w.order.id]));
      expect(dup.code).toBe("PT409");
      expect(dup.message).toMatch(new RegExp(`${w.order.number} \\(in batch ${r.batch_number}\\)`));

      expect(await orderStatus(s, w.order.id)).toMatchObject({ readiness: "handed_off", batch_number: r.batch_number, handoff_reference: "QB batch Oct (test)", changed_since_handoff: false });
      // Nothing about the order changed: status, prices, totals and lines.
      expect((await s.query("select to_jsonb(o) - 'updated_at' as o from public.orders o where id = $1", [w.order.id])).rows[0].o).toEqual(orderBefore);
      expect((await s.query("select jsonb_agg(to_jsonb(l) order by line_no) as l from public.order_lines l where order_id = $1", [w.order.id])).rows[0].l).toEqual(linesBefore);

      const snap = (await s.query<{ snapshot: { order: Row; lines: Row[]; tickets: Row[] } }>("select snapshot from public.billing_handoff_orders where order_id = $1", [w.order.id])).rows[0].snapshot;
      expect(snap.order).toMatchObject({ order_number: w.order.number, total_cents: orderBefore.total_cents });
      expect(snap.lines.map((l) => l.line_no)).toEqual([1, 2]);
      expect(snap.tickets).toEqual([expect.objectContaining({ ticket_number: w.ticket.ticket_number, quantity: 40, unit_code: "ton" })]);
      expect((await s.query("select 1 from public.audit_events where entity_id = $1 and action = 'billing.handed_off'", [w.order.id])).rowCount).toBe(1);

      // Downloads are counted and logged.
      expect((await s.query<{ r: Row }>("select public.record_billing_export($1) as r", [r.handoff_id])).rows[0].r).toMatchObject({ export_count: 1 });
      expect((await s.query<{ r: Row }>("select public.record_billing_export($1) as r", [r.handoff_id])).rows[0].r).toMatchObject({ export_count: 2 });

      // Clients cannot write billing tables; the records resist direct changes.
      expect((await pgError(s.query("update public.billing_handoff_orders set reverted_at = now(), revert_reason = 'x' where order_id = $1", [w.order.id]))).code).toBe("42501");
      expect((await pgError(s.query("insert into public.billing_handoffs (company_id, batch_number) values ($1, 'B-X')", [TOP_LINE]))).code).toBe("42501");
      await s.asAdmin();
      expect((await pgError(s.query("update public.billing_handoff_orders set snapshot = '{}' where order_id = $1", [w.order.id]))).code).toBe("42501");
      expect((await pgError(s.query("update public.billing_handoffs set reference = 'changed' where id = $1", [r.handoff_id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.billing_handoffs where id = $1", [r.handoff_id]))).code).toBe("42501");
    });
  });

  it("shows tickets changed after the handoff, and an undo keeps the record and allows a new handoff", async () => {
    await withSession(async (s) => {
      const w = await readyOrder(s);
      await s.as(w.office);
      const r = await handOff(s, [w.order.id]);
      const c = await correct(s, w.ticket.ticket_id, w.payload({ quantity: "39.5" }), "Late scale correction (test)");
      expect(await orderStatus(s, w.order.id)).toMatchObject({ readiness: "handed_off", changed_since_handoff: true });

      const h = (await s.query<{ id: string }>("select id from public.billing_handoff_orders where order_id = $1", [w.order.id])).rows[0].id;
      expect((await pgError(s.query("select public.revert_billing_handoff($1, '')", [h]))).message).toMatch(/Enter the reason/);
      await s.query("select public.revert_billing_handoff($1, 'Quantity corrected before invoicing (test)')", [h]);
      expect((await pgError(s.query("select public.revert_billing_handoff($1, 'again')", [h]))).code).toBe("PT409");
      const back = await orderStatus(s, w.order.id);
      expect(back).toMatchObject({ readiness: "needs_review", handoff_order_id: null });

      await review(s, c.ticket_id, "accept");
      const st = await orderStatus(s, w.order.id);
      expect(st.readiness).toBe("blocked"); // 39.5 t changes the compared quantities: new exceptions
      await acknowledge(s, w.order.id, st.exceptions_fingerprint, "Bill the corrected tons (test)");
      const r2 = await handOff(s, [w.order.id]);
      expect(r2.batch_number).not.toBe(r.batch_number);
      const rows = (await s.query<Row>("select handoff_id, reverted_at, revert_reason from public.billing_handoff_orders where order_id = $1 order by reverted_at nulls last", [w.order.id])).rows;
      expect(rows).toEqual([
        expect.objectContaining({ handoff_id: r.handoff_id, revert_reason: "Quantity corrected before invoicing (test)" }),
        expect.objectContaining({ handoff_id: r2.handoff_id, reverted_at: null }),
      ]);
      expect((await s.query("select 1 from public.audit_events where entity_id = $1 and action = 'billing.handoff_undone'", [w.order.id])).rowCount).toBe(1);
    });
  });
});

describe("permissions and isolation", () => {
  it("only billing roles see and act on billing; other companies see nothing and cannot act on Top Line records", async () => {
    await withSession(async (s) => {
      const w = await readyOrder(s);
      await s.as(w.office);
      const r = await handOff(s, [w.order.id]);
      const h = (await s.query<{ id: string }>("select id from public.billing_handoff_orders where order_id = $1", [w.order.id])).rows[0].id;

      for (const role of ["dispatcher", "mechanic", "driver"] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await s.query("select id from public.billing_handoffs")).rowCount, role).toBe(0);
        expect((await s.query("select id from public.billing_handoff_orders")).rowCount, role).toBe(0);
        expect((await pgError(handOff(s, [w.order.id]))).code, role).toBe("42501");
        expect((await pgError(s.query("select public.revert_billing_handoff($1, 'x')", [h]))).code, role).toBe("42501");
      }

      const B = await s.createCompany("Brookside Aggregates (test)");
      await s.asAdmin();
      expect((await s.query("select prefix from public.document_sequences where company_id = $1 and key = 'billing'", [B])).rows).toEqual([{ prefix: "BIL-" }]);
      const bOwner = await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      for (const v of ["billing_order_status", "billing_load_status", "billing_line_status", "billing_exceptions"]) {
        expect((await s.query(`select 1 from public.${v} where order_id = $1`, [w.order.id])).rowCount, v).toBe(0);
      }
      expect((await s.query("select id from public.billing_handoffs where id = $1", [r.handoff_id])).rowCount).toBe(0);
      expect((await s.query("select id from public.billing_reviews where order_id = $1", [w.order.id])).rowCount).toBe(0);
      expect((await pgError(handOff(s, [w.order.id]))).message).toMatch(/Order not found/);
      expect((await pgError(acknowledge(s, w.order.id, "0".repeat(32), "hijack"))).message).toMatch(/Order not found/);
      expect((await pgError(s.query("select public.revert_billing_handoff($1, 'hijack')", [h]))).message).toMatch(/Handoff not found/);
      expect((await pgError(s.query("select public.record_billing_export($1)", [r.handoff_id]))).message).toMatch(/not found/);

      await s.as(w.office);
      expect(await orderStatus(s, w.order.id)).toMatchObject({ readiness: "handed_off" });
    });
  });
});

describe("handoff under concurrency", () => {
  it("two simultaneous handoffs of the same order: one batch wins, the other is refused", async () => {
    const setup = await pool.connect();
    const ids: { office?: string; order?: string; trucks: string[] } = { trucks: [] };
    try {
      await setup.query("begin");
      const s: Session = {
        client: setup,
        as: async (uid) => {
          await setup.query("reset role");
          await setup.query("set local role authenticated");
          await setup.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
        },
        asAdmin: async () => {
          await setup.query("reset role");
        },
        query: (sql, params) => setup.query(sql, params as unknown[]),
        createCompany: async () => {
          throw new Error("not used");
        },
        createUser: async (role) => {
          await setup.query("reset role");
          const id = (await setup.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;
          await setup.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, `race-${id.slice(0, 8)}@test.example`]);
          await setup.query("insert into public.company_memberships (company_id, user_id, role) values ($1, $2, $3)", [TOP_LINE, id, role]);
          return id;
        },
      };
      const w = await readyOrder(s);
      ids.office = w.office;
      ids.order = w.order.id;
      ids.trucks.push(w.f.t1, w.f.t2);
      await setup.query("commit");
    } finally {
      setup.release();
    }

    const a = await pool.connect();
    const b = await pool.connect();
    const begin = async (c: typeof a) => {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.office, role: "authenticated" })]);
    };
    const call = (c: typeof a) => c.query("select public.hand_off_orders($1::uuid[], 'race', '', $2) as r", [[ids.order], randomUUID()]);
    try {
      await begin(a);
      await begin(b);
      const ra = await call(a);
      const pb = call(b).then(
        () => ({ ok: true as const }),
        (e: { code: string; message: string }) => ({ ok: false as const, code: e.code, message: e.message }),
      );
      await new Promise((r) => setTimeout(r, 300)); // b waits for the order lock
      await a.query("commit");
      const rb = await pb;
      await b.query("rollback");
      expect(ra.rows[0].r.created).toBe(true);
      expect(rb).toMatchObject({ ok: false, code: "PT409" });
      expect(rb.ok ? "" : rb.message).toMatch(/Already handed off/);
      const n = await pool.query("select count(*)::int as n from public.billing_handoff_orders where order_id = $1", [ids.order]);
      expect(n.rows[0].n).toBe(1);
    } finally {
      a.release();
      b.release();
      const c = await pool.connect();
      await c.query("begin");
      await c.query("select set_config('tlt.sample_purge', 'on', true)");
      const batches = (await c.query<{ handoff_id: string }>("select handoff_id from public.billing_handoff_orders where order_id = $1", [ids.order])).rows.map((r) => r.handoff_id);
      await c.query("delete from public.orders where id = $1", [ids.order]);
      await c.query("delete from public.billing_handoffs where id = any($1)", [batches]);
      await c.query("delete from public.driver_qualifications where driver_id in (select id from public.drivers where created_by = $1)", [ids.office]);
      await c.query("delete from public.drivers where created_by = $1", [ids.office]);
      await c.query("delete from public.trucks where id = any($1)", [ids.trucks]);
      await c.query("commit");
      c.release();
    }
  });
});

describe("rule parity", () => {
  it("the app knows every readiness state and exception kind the database produces", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const def = async (v: string) => (await s.query<{ d: string }>("select pg_get_viewdef($1::regclass) as d", [`public.${v}`])).rows[0].d;
      const order = await def("billing_order_status");
      const readiness = [...order.matchAll(/(?:THEN|ELSE) '([a-z_]+)'::text/g)].map((m) => m[1]);
      expect([...new Set(readiness)].sort()).toEqual([...READINESS].sort());
      const exc = await def("billing_exceptions");
      const kinds = new Set([...exc.matchAll(/'((?:load|line|po)_[a-z_]+)'::text/g)].map((m) => m[1]));
      expect([...kinds].sort()).toEqual([...EXCEPTION_KINDS].sort());
    });
  });
});
