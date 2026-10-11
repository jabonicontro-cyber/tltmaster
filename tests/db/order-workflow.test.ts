// N14: the order → dispatch link. A confirmed order without a delivery date is
// surfaced as `order_unscheduled` (it is on no day of the dispatch board) until
// it is scheduled; priority follows the customer's requested date; other
// companies never see it.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

interface Item { exception_key: string; kind: string; priority: number; order_id: string | null; reasons: string[] }
const items = async (s: Session) =>
  (await s.query<{ r: { items: Item[] } }>("select public.command_center_exceptions('order_unscheduled', false, 100, 0) as r")).rows[0].r.items;
const today = async (s: Session) => (await s.query<{ d: string }>("select private.business_today('00000000-0000-4000-8000-000000000001')::text as d")).rows[0].d;

async function confirmedOrder(s: Session, ids: Awaited<ReturnType<typeof sampleIds>>, requested: string | null) {
  const r = (await s.query<{ r: { order_id: string } }>("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
    customer_id: ids.customerId, order_date: "2026-10-01", requested_date: requested, project_name: "Unscheduled test",
    lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel", unit_code: "ton", quantity: "22", unit_rate_cents: 1000 }],
  })])).rows[0].r;
  await s.query("select public.set_order_status($1, 'confirmed', '')", [r.order_id]);
  return r.order_id;
}

describe("confirmed orders without a delivery date", () => {
  it("are queued for scheduling with priority from the requested date, and leave the queue once scheduled", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      await s.asAdmin();
      const d0 = await today(s);
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(office);
      const plus = async (n: number) => (await s.query<{ d: string }>("select ($1::date + $2::int)::text as d", [d0, n])).rows[0].d;
      const tomorrow = await confirmedOrder(s, ids, await plus(1));
      const nextWeek = await confirmedOrder(s, ids, await plus(5));
      const someday = await confirmedOrder(s, ids, null);
      const draft = (await s.query<{ r: { order_id: string } }>("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
        customer_id: ids.customerId, order_date: "2026-10-01", lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel", unit_code: "ton", quantity: "1", unit_rate_cents: 1000 }],
      })])).rows[0].r.order_id;

      for (const who of [office, dispatcher]) {
        await s.as(who);
        const q = await items(s);
        const p = (id: string) => q.find((i) => i.order_id === id);
        expect(p(tomorrow)).toMatchObject({ kind: "order_unscheduled", priority: 1, reasons: ["no_delivery_date", "requested_date_soon"] });
        expect(p(nextWeek)?.priority).toBe(2);
        expect(p(someday)?.priority).toBe(3);
        expect(p(draft)).toBeUndefined(); // drafts are not confirmed work
      }

      // Scheduling (dates, then status) removes it from the queue.
      await s.as(dispatcher);
      const seq = (await s.query<{ edit_seq: number }>("select edit_seq from public.orders where id = $1", [tomorrow])).rows[0].edit_seq;
      const r = (await s.query<{ r: { edit_seq: number } }>("select public.update_order_schedule($1, $2, $3::jsonb) as r", [tomorrow, seq, JSON.stringify({ scheduled_start: await plus(1) })])).rows[0].r;
      await s.query("select public.set_order_status($1, 'scheduled', '', $2)", [tomorrow, r.edit_seq]);
      expect((await items(s)).some((i) => i.order_id === tomorrow)).toBe(false);
      expect((await s.query<{ r: { orders_unscheduled: number } }>("select public.command_center_summary() as r")).rows[0].r.orders_unscheduled).toBeGreaterThanOrEqual(2);

      // Another company sees none of it.
      const other = await s.createCompany("Elsewhere Hauling (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await items(s)).filter((i) => [nextWeek, someday].includes(i.order_id ?? ""))).toEqual([]);
    });
  });
});

describe("operations report", () => {
  it("returns each section only with the permission behind it, from the caller's company only", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      const driver = await s.createUser("driver");
      const report = async () => (await s.query<{ r: Record<string, unknown> }>("select public.report_operations(current_date - 365, current_date) as r")).rows[0].r;

      await s.as(office);
      const o = await report();
      expect(Object.keys(o)).toEqual(expect.arrayContaining(["deliveries", "value", "billing", "fleet", "profitability"]));
      expect(o.profitability).toMatchObject({ available: false });
      const value = o.value as { verified_value_cents: number; by_customer: Array<{ name: string }> };

      await s.as(dispatcher); // no billing.view: no money
      const d = await report();
      expect(d.value).toBeUndefined();
      expect(d.billing).toBeUndefined();
      expect(d.deliveries).toBeDefined();
      expect(d.fleet).toBeDefined();

      await s.as(driver); // portal only
      const dr = await report();
      expect(dr.value).toBeUndefined();
      expect(dr.deliveries).toBeUndefined();
      expect(dr.fleet).toBeUndefined();

      // Another company sees only its own (empty) numbers.
      const other = await s.createCompany("Report Isolation Co (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      const x = await report();
      expect((x.value as { verified_value_cents: number }).verified_value_cents).toBe(0);
      expect((x.value as { by_customer: unknown[] }).by_customer).toEqual([]);
      if (value.verified_value_cents > 0) expect(value.by_customer.length).toBeGreaterThan(0);

      await s.as(office);
      expect((await pgError(s.query("select public.report_operations(current_date, current_date - 1)"))).code).toBe("22023");
      await s.as(null);
      expect((await pgError(s.query("select public.report_operations(current_date - 7, current_date)"))).code).toBe("42501");
    });
  });
});
