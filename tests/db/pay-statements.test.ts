// Driver pay statements (B131, 20261120005900): payroll staff read any driver's statement; a driver reads only their own
// and only once the period is approved; other drivers and companies see nothing. Built from the payroll ledger.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

type Statement = { period: { status: string }; driver: { name: string }; lines: Array<{ quantity: number; unit: string; amount_cents: number }>; adjustments: Array<{ reason: string; amount_cents: number }>; earnings_cents: number; adjustments_cents: number };

describe("driver pay statements", () => {
  it("payroll sees every statement; a driver only their own approved ones", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const yesterday = addDays(today, -1);
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const f = await fleet(s, office, yesterday);
      const order = await scheduledOrder(s, office, addDays(today, -2), today, addDays(today, -2));
      const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);
      await s.as(office);
      const t = (await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
        load_id: load.load_id, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30", quantity: "21.47", unit_code: "ton", external_reference: `PS-${randomUUID().slice(0, 8)}` })])).rows[0].r;
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);

      await s.as(owner);
      const rule = (await s.query<{ r: string }>("select public.payroll_rule_draft($1::jsonb) as r", [JSON.stringify({ name: `Per ton ${randomUUID().slice(0, 6)}`, formula: "tons * rate", rate: "4.25", unit_code: "ton", effective_from: addDays(today, -30) })])).rows[0].r;
      await s.query("select public.payroll_rule_activate($1, '')", [rule]);
      await s.query("select public.payroll_settings_save($1::jsonb)", [JSON.stringify({ enabled: true })]);
      const period = (await s.query<{ r: string }>("select public.payroll_period_create($1, $2) as r", [yesterday, today])).rows[0].r;
      await s.query("select public.payroll_record_entries($1, $2::jsonb)", [period, JSON.stringify([{ ticket_id: t.ticket_id, driver_id: f.d1, rule_version_id: rule, status: "calculated", amount_cents: 9125, inputs: { tons: "21.47", rate: "4.25" }, breakdown: "21.47 × 4.25", exception: "" }])]);

      // Payroll staff: the statement with its ticket line.
      const st = (await s.query<{ r: Statement }>("select public.payroll_statement($1, $2) r", [period, f.d1])).rows[0].r;
      expect(st.lines).toEqual([expect.objectContaining({ quantity: 21.47, unit: "ton", amount_cents: 9125 })]);
      expect([st.earnings_cents, st.adjustments_cents, st.period.status]).toEqual([9125, 0, "open"]);
      await s.as(office);
      expect((await pgError(s.query("select public.payroll_statement($1, $2)", [period, f.d1]))).code).toBe("42501");

      // The driver: nothing until the period is approved, then their own only.
      const driverUser = await s.createUser("driver");
      const otherUser = await s.createUser("driver");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d2, otherUser]);
      await s.as(driverUser);
      expect((await s.query<{ r: unknown[] }>("select public.my_pay_statements() r")).rows[0].r).toEqual([]);
      expect((await pgError(s.query("select public.my_pay_statement($1)", [period]))).code).toBe("P0002");
      await s.as(owner);
      await s.query("select public.payroll_period_approve($1)", [period]);
      await s.as(driverUser);
      expect((await s.query<{ r: Array<{ period_id: string; total_cents: number }> }>("select public.my_pay_statements() r")).rows[0].r).toEqual([expect.objectContaining({ period_id: period, total_cents: 9125 })]);
      const mine = (await s.query<{ r: Statement }>("select public.my_pay_statement($1) r", [period])).rows[0].r;
      expect(mine.earnings_cents).toBe(9125);
      // Another driver sees an empty statement list and an empty statement of their own, never driver A's.
      await s.as(otherUser);
      expect((await s.query<{ r: unknown[] }>("select public.my_pay_statements() r")).rows[0].r).toEqual([]);
      expect((await s.query<{ r: Statement }>("select public.my_pay_statement($1) r", [period])).rows[0].r.lines).toEqual([]);

      // Another company sees nothing.
      const co = await s.createCompany(`Pay Other ${randomUUID().slice(0, 6)} (test)`);
      const outsider = await s.createUser("owner", { companyId: co });
      await s.as(outsider);
      expect((await pgError(s.query("select public.payroll_statement($1, $2)", [period, f.d1]))).code).toBe("P0002");
    });
  });
});
