// The whole chain in one run (master plan B77): quote → acceptance → order → loads → dispatch → driver ticket → review
// → completion → billing readiness → invoice draft → billing handoff, each step through the app's own database
// functions as the person who does it. Covers a partial delivery, a canceled load, duplicate submissions, permission
// denials, readable references, reconciliation between the order, the tickets, the invoice draft and the handoff, and
// another company seeing nothing.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildInvoiceDraft, type DraftOrderLine, type DraftTicket } from "@/lib/billing/invoice-draft";
import { addDays } from "@/lib/dates";
import { businessToday, fleet, planLoad } from "./fixtures";
import { pgError, pool, sampleIds, saveQuote, withSession } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;

describe("order to cash, end to end", () => {
  it("a quote becomes one order, is delivered in part, reconciled, drafted and handed off once — by the right people only", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const today = await businessToday(s);
      const yesterday = addDays(today, -1);
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      const driverUser = await s.createUser("driver");

      // 1. Quote: 40 t of gravel at the contract customer's $8.50, issued, sent, accepted.
      await s.as(owner);
      const q = await saveQuote(s, {
        customer_id: ids.contractCustomerId, quote_date: yesterday, valid_until: addDays(today, 30), tax_rate_bp: 700,
        contact_name: "Pat Morgan", site_line1: "1500 Example Hwy (test)", site_city: "Merrillville", customer_po: `PO-${randomUUID().slice(0, 6)}`,
        lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "40", unit_rate_cents: 850, taxable: true }],
      });
      expect(q.quote_number).toMatch(/^QTE-\d{4,}$/);
      await s.query("select public.mark_quote_sent($1, $2, 'Handed over (test)')", [q.quote_id, q.edit_seq]);
      await s.query("select public.set_quote_status($1, 'accepted', 'Signed (test)')", [q.quote_id]);

      // 2. Conversion is idempotent: a retry or double click returns the same order.
      const first = (await s.query<{ r: { order_id: string; created: boolean } }>("select public.convert_quote_to_order($1) as r", [q.quote_id])).rows[0].r;
      const again = (await s.query<{ r: { order_id: string; created: boolean } }>("select public.convert_quote_to_order($1) as r", [q.quote_id])).rows[0].r;
      expect(again).toMatchObject({ order_id: first.order_id, created: false });
      const orderId = first.order_id;
      await s.asAdmin();
      const order = (await s.query<Row>("select order_number, status, total_cents::int as total_cents, source_quote_id from public.orders where id = $1", [orderId])).rows[0];
      expect(order).toMatchObject({ status: "confirmed", source_quote_id: q.quote_id });
      expect(String(order.order_number)).toMatch(/^ORD-\d{4,}$/);
      expect(Number(order.total_cents)).toBe(q.total_cents);
      expect((await s.query("select 1 from public.orders where source_quote_id = $1", [q.quote_id])).rowCount).toBe(1);
      const line = (await s.query<Row>("select id, unit_rate_cents::int as unit_rate_cents, quantity::text as qty from public.order_lines where order_id = $1", [orderId])).rows;
      expect(line).toEqual([expect.objectContaining({ unit_rate_cents: 850, qty: "40.000" })]);

      // 3. The office schedules it; two loads of 20 t are planned and one is later canceled (partial delivery).
      await s.as(office);
      await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [orderId, JSON.stringify({ scheduled_start: today, scheduled_end: addDays(today, 1) })]);
      await s.query("select public.set_order_status($1, 'scheduled', '')", [orderId]);
      const f = await fleet(s, office, today);
      await s.as(office);
      // Converted orders are dated today, so the run happens today: load 1 early this morning, load 2 tomorrow.
      const l1 = await planLoad(s, orderId, today, "00:00", "00:30", { planned_quantity: "20", unit_code: "ton" });
      const l2 = await planLoad(s, orderId, addDays(today, 1), "07:00", "09:00", { planned_quantity: "20", unit_code: "ton" });

      // 4. Dispatch assigns load 1; a second assignment of the same load without replacing is refused.
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);
      await s.as(dispatcher);
      const assignment = (await s.query<{ r: { assignment_id: string } }>("select public.assign_load($1, $2, null, $3, '', null) as r", [l1.load_id, f.t1, f.d1])).rows[0].r.assignment_id;
      expect((await pgError(s.query("select public.assign_load($1, $2, null, $3, '', null)", [l1.load_id, f.t2, f.d2]))).code).toBeDefined();

      // 5. The driver records the delivery from their phone; a retry with the same key does not make a second ticket;
      //    they cannot accept their own ticket.
      await s.as(driverUser);
      const payload = {
        assignment_id: assignment, order_line_id: line[0].id, delivered_date: today, delivered_time: "00:20", quantity: "20", unit_code: "ton",
        external_reference: `SC-${randomUUID().slice(0, 8)}`, notes: "", submission_key: randomUUID(),
      };
      const ticket = (await s.query<{ r: { ticket_id: string; ticket_number: string; created: boolean } }>("select public.driver_submit_ticket($1::jsonb) as r", [JSON.stringify(payload)])).rows[0].r;
      const retry = (await s.query<{ r: { ticket_id: string; created: boolean } }>("select public.driver_submit_ticket($1::jsonb) as r", [JSON.stringify(payload)])).rows[0].r;
      expect(ticket.ticket_number).toMatch(/^TKT-\d{4,}$/);
      expect(retry).toMatchObject({ ticket_id: ticket.ticket_id, created: false });
      expect((await pgError(s.query("select public.review_delivery_ticket($1, 'accept', '')", [ticket.ticket_id]))).code).toBe("42501");

      // 6. The office accepts it, cancels the second load, and completes the order.
      await s.as(office);
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [ticket.ticket_id]);
      await s.query("select public.cancel_order_load($1, 'Customer took 20 t only (test)')", [l2.load_id]);
      await s.query("select public.set_order_status($1, 'in_progress', '')", [orderId]);
      await s.query("select public.set_order_status($1, 'completed', '')", [orderId]);

      // 7. Reconciliation: 20 of 40 t delivered is a difference someone must acknowledge before billing.
      let st = (await s.query<Row>("select * from public.billing_order_status where order_id = $1", [orderId])).rows[0];
      expect(st).toMatchObject({ readiness: "blocked", tickets_accepted: 1, loads_total: 1 });
      expect(Number(st.exceptions_count)).toBeGreaterThan(0);
      await s.query("select public.acknowledge_billing_exceptions($1, $2, $3)", [orderId, st.exceptions_fingerprint, "Customer took 20 t only; bill delivered tons (test)"]);
      st = (await s.query<Row>("select * from public.billing_order_status where order_id = $1", [orderId])).rows[0];
      expect(st.readiness).toBe("ready");

      // 8. The invoice draft bills what was delivered and accepted, at the quote's price — half the ordered total.
      const lines = (await s.query<Row>("select id, line_no, kind, calc_method, description, unit_code, quantity::text as quantity, unit_rate_cents::int as unit_rate_cents, percent_bp::int as percent_bp, taxable, amount_cents::int as amount_cents from public.order_lines where order_id = $1", [orderId])).rows as unknown as DraftOrderLine[];
      const tickets = (await s.query<Row>("select order_line_id, status, quantity::text as quantity, unit_code from public.delivery_tickets where order_id = $1", [orderId])).rows as unknown as DraftTicket[];
      const draft = buildInvoiceDraft({ lines, tickets, taxRateBp: 700, orderTotalCents: Number(order.total_cents), readiness: "ready" });
      expect(draft.stage).toBe("draft");
      expect(draft.lines[0]).toMatchObject({ basis: "delivered", quantity: 20, rateCents: 850 });
      expect(draft.subtotalCents).toBe(17_000);
      expect(draft.totalCents).toBe(17_000 + Math.round(17_000 * 0.07));
      expect(draft.totalCents * 2).toBe(Number(order.total_cents));

      // 9. Handoff to accounting happens once: a retry with the same key returns the same batch; a new key is refused.
      const key = randomUUID();
      const h1 = (await s.query<{ r: { handoff_id: string; batch_number: string; created: boolean } }>("select public.hand_off_orders($1::uuid[], '', '', $2) as r", [[orderId], key])).rows[0].r;
      const h2 = (await s.query<{ r: { handoff_id: string; created: boolean } }>("select public.hand_off_orders($1::uuid[], '', '', $2) as r", [[orderId], key])).rows[0].r;
      expect(h1.created).toBe(true);
      expect(h1.batch_number).toMatch(/^BIL-\d{4,}$/);
      expect(h2).toMatchObject({ handoff_id: h1.handoff_id, created: false });
      expect((await pgError(s.query("select public.hand_off_orders($1::uuid[], '', '', $2)", [[orderId], randomUUID()]))).code).toBeDefined();
      expect((await s.query<Row>("select readiness from public.billing_order_status where order_id = $1", [orderId])).rows[0].readiness).toBe("handed_off");

      // Billing records are for billing people: dispatch can neither read the handoff nor make one.
      await s.as(dispatcher);
      expect((await s.query("select 1 from public.billing_handoffs where id = $1", [h1.handoff_id])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.hand_off_orders($1::uuid[], '', '', $2)", [[orderId], randomUUID()]))).code).toBe("42501");

      // 10. Another company sees none of it.
      const other = await s.createCompany(`Other ${randomUUID().slice(0, 6)}`);
      const stranger = await s.createUser("owner", { companyId: other });
      await s.as(stranger);
      for (const [table, id] of [["quotes", q.quote_id], ["orders", orderId], ["delivery_tickets", ticket.ticket_id], ["billing_handoffs", h1.handoff_id]] as const) {
        expect((await s.query(`select 1 from public.${table} where id = $1`, [id])).rowCount, table).toBe(0);
      }
      expect((await s.query("select 1 from public.billing_order_status where order_id = $1", [orderId])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.review_delivery_ticket($1, 'void', 'not mine')", [ticket.ticket_id]))).code).toBeDefined();
    });
  });
});
