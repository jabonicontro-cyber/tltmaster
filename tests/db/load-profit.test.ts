// Profit per load (B104, migration 20261120004400): revenue is the verified delivered value of accepted tickets, cost
// comes only from the company's own rates (truck and driver per planned hour, plus a fixed amount per load); billing
// managers set the rates, billing viewers read the report, others cannot; nothing is costed without rates.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

type Row = { name: string; loads: number; revenue_cents: number; cost_cents: number; profit_cents: number; hours: number };

describe("profit per load", () => {
  it("costs a delivered load from the company's rates and planned hours", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const yesterday = addDays(today, -1);
      const f = await fleet(s, owner, yesterday);
      const order = await scheduledOrder(s, owner, addDays(today, -2), addDays(today, 2), addDays(today, -2));
      const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);
      await s.as(owner);
      const t = (await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
        load_id: load.load_id, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:00", quantity: "40", unit_code: "ton", external_reference: `PR-${randomUUID().slice(0, 8)}`,
      })])).rows[0].r;
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
      const rate = Number((await s.query<{ r: number }>("select unit_rate_cents r from public.order_lines where id = $1", [order.materialLine])).rows[0].r);
      const unit = (await s.query<{ u: string }>("select unit_number u from public.trucks where id = $1", [f.t1])).rows[0].u;
      const report = async () => (await s.query<{ r: { has_rates: boolean; by_truck: Row[] } }>("select public.report_profit($1, $2) r", [yesterday, yesterday])).rows[0].r;

      // No rates yet: nothing is costed.
      await s.asAdmin();
      const company = (await s.query<{ c: string }>("select company_id c from public.orders where id = $1", [order.id])).rows[0].c;
      await s.query("delete from public.company_cost_rates where company_id = $1", [company]);
      await s.as(owner);
      const before = await report();
      expect(before.has_rates).toBe(false);
      expect(before.by_truck.find((r) => r.name === unit)).toBeUndefined();

      // The owner sets rates: 2 planned hours × ($65 + $32) + $15 per load.
      expect((await pgError(s.query("select public.set_cost_rates(-1, 0, 0)"))).message).toMatch(/between/);
      await s.query("select public.set_cost_rates(6500, 3200, 1500)");
      const row = (await report()).by_truck.find((r) => r.name === unit)!;
      expect(row).toMatchObject({ loads: 1, revenue_cents: 40 * rate, cost_cents: 2 * (6500 + 3200) + 1500 });
      expect(row.profit_cents).toBe(40 * rate - (2 * (6500 + 3200) + 1500));

      // Dispatch cannot read profit or change rates.
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.report_profit($1, $1)", [yesterday]))).message).toMatch(/permission/);
      expect((await pgError(s.query("select public.set_cost_rates(1, 1, 1)"))).message).toMatch(/permission/);
      expect((await s.query("select * from public.company_cost_rates")).rowCount).toBe(0);

      // Another company sees only its own (no rates, no loads of ours).
      const other = await s.createCompany("Other Profit Co (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      const theirs = (await s.query<{ r: { has_rates: boolean; loads: number } }>("select public.report_profit($1, $1) r", [yesterday])).rows[0].r;
      expect(theirs).toMatchObject({ has_rates: false, loads: 0 });
    });
  });
});
