// Detention (DT1, migration 20261120008200): off until a customer has free minutes and an hourly rate; a recorded wait
// past the free time is proposed; billing adds it as an order line (billed without a ticket) or dismisses it with a
// reason, once per stop; only billing can decide; other companies see nothing.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

type Proposal = { stop_time_id: string; stop: string; wait_minutes: number; free_minutes: number; billable_minutes: number; hours: string; rate_cents: number; amount_cents: string; status: string | null };

describe("detention", () => {
  it("proposes waits past the customer's free time; billing adds or dismisses each once", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      const today = await businessToday(s);
      const f = await fleet(s, office, today);
      const order = await scheduledOrder(s, office, addDays(today, -1), addDays(today, 2), addDays(today, -1));
      const load = await planLoad(s, order.id, today, "07:00", "09:00", { planned_quantity: "20", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);
      await s.as(dispatcher);
      await s.query("select public.load_stop_set($1, 'site', now() - interval '160 minutes', now() - interval '10 minutes')", [load.load_id]);
      await s.query("select public.load_stop_set($1, 'pickup', now() - interval '240 minutes', now() - interval '200 minutes')", [load.load_id]);

      // Off until both are set for the customer (no default rate).
      await s.as(office);
      const customer = (await s.query<{ customer_id: string; total_cents: string }>("select customer_id, total_cents from public.orders where id = $1", [order.id])).rows[0];
      expect((await s.query("select * from public.detention_proposals($1)", [order.id])).rowCount).toBe(0);
      await s.as(owner);
      expect((await pgError(s.query("update public.customers set detention_free_minutes = 60 where id = $1", [customer.customer_id]))).code).toBe("23514");
      await s.query("update public.customers set detention_free_minutes = 60, detention_rate_cents = 7500 where id = $1", [customer.customer_id]);

      // The site waited 150 min: 90 billable, 1.50 h x $75 = $112.50. The pickup (40 min) is within the free time.
      await s.as(office);
      const rows = (await s.query<Proposal>("select * from public.detention_proposals($1)", [order.id])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ stop: "site", wait_minutes: 150, free_minutes: 60, billable_minutes: 90, hours: "1.50", rate_cents: 7500, amount_cents: "11250", status: null });

      // Dispatch can't see or decide billing; billing adds it once.
      await s.as(dispatcher);
      expect((await pgError(s.query("select * from public.detention_proposals($1)", [order.id]))).code).toBe("42501");
      expect((await pgError(s.query("select public.detention_apply($1)", [rows[0].stop_time_id]))).code).toBe("42501");
      await s.as(office);
      const line = (await s.query<{ id: string }>("select public.detention_apply($1) as id", [rows[0].stop_time_id])).rows[0].id;
      expect((await pgError(s.query("select public.detention_apply($1)", [rows[0].stop_time_id]))).code).toBe("PT409");
      expect((await pgError(s.query("select public.detention_dismiss($1, 'no')", [rows[0].stop_time_id]))).code).toBe("PT409");
      const added = (await s.query<{ description: string; unit_code: string; quantity: string; amount_cents: string; ticket_required: boolean; code: string }>(
        `select ol.description, ol.unit_code, ol.quantity::text, ol.amount_cents::text, ci.ticket_required, ci.code
         from public.order_lines ol join public.charge_items ci on ci.id = ol.charge_item_id where ol.id = $1`, [line])).rows[0];
      expect(added).toMatchObject({ unit_code: "hour", quantity: "1.500", amount_cents: "11250", ticket_required: false, code: "DETENTION" });
      expect(added.description).toMatch(/^Detention: .+, waited 2 h 30 min \(60 min free\)$/);
      const after = (await s.query<{ total_cents: string }>("select total_cents from public.orders where id = $1", [order.id])).rows[0];
      expect(Number(after.total_cents)).toBe(Number(customer.total_cents) + 11250);
      // Billing doesn't wait for a ticket on it, and the decision is shown.
      expect((await s.query("select 1 from public.billing_line_status where line_id = $1", [line])).rowCount).toBe(0);
      expect((await s.query<Proposal>("select * from public.detention_proposals($1)", [order.id])).rows[0].status).toBe("applied");

      // A second load: dismissed with a reason (a reason is required); nothing is added.
      const load2 = await planLoad(s, order.id, today, "10:00", "12:00", { planned_quantity: "20", unit_code: "ton" });
      await assign(s, load2.load_id, f.t2, null, f.d2);
      await s.as(dispatcher);
      await s.query("select public.load_stop_set($1, 'site', now() - interval '130 minutes', now() - interval '5 minutes')", [load2.load_id]);
      await s.as(office);
      const second = (await s.query<Proposal & { load_id: string }>("select * from public.detention_proposals($1) where load_id = $2", [order.id, load2.load_id])).rows[0];
      expect(second.billable_minutes).toBe(65);
      expect((await pgError(s.query("select public.detention_dismiss($1, '  ')", [second.stop_time_id]))).message).toMatch(/why/);
      await s.query("select public.detention_dismiss($1, 'Customer waived it this time')", [second.stop_time_id]);
      expect((await s.query("select 1 from public.order_lines where order_id = $1 and description like 'Detention:%'", [order.id])).rowCount).toBe(1);

      // Another company sees nothing and cannot decide.
      const other = await s.createCompany("Detention Elsewhere (test)");
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await s.query("select * from public.detention_proposals($1)", [order.id])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.detention_dismiss($1, 'x')", [second.stop_time_id]))).message).toMatch(/not found/);
    });
  });
});
