import { describe, expect, it } from "vitest";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { TOP_LINE, withSession } from "./helpers";

// A driver on a sample load reports a real truck problem and a mechanic opens a work order from it. Removing sample data
// deletes the sample order and its reports; it used to fail on the work order's link (20261120019600). The work order
// stays, about its real truck, with the link to the deleted sample report cleared.
describe("sample data removal and work orders opened from sample reports", () => {
  it("removes the sample order and its report, keeps the work order and clears only its report link", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const order = await scheduledOrder(s, owner, today); // for the sample customer
      const load = await planLoad(s, order.id, today, "08:00", "12:00");
      const f = await fleet(s, owner, today);
      const assignment = await assign(s, load.load_id, f.t1, null, f.d1);
      await s.asAdmin();
      const report = (await s.query<{ id: string }>(
        `insert into public.field_reports (company_id, kind, equipment, truck_id, driver_id, assignment_id, load_id, order_id, description, snapshot)
         values ($1, 'breakdown', 'truck', $2, $3, $4, $5, $6, 'Air leak at the rear axle (test)', '{}') returning id`,
        [TOP_LINE, f.t1, f.d1, assignment, load.load_id, order.id],
      )).rows[0].id;
      const wo = (await s.query<{ id: string }>(
        "insert into public.work_orders (company_id, number, title, truck_id, field_report_id) values ($1, $2, 'Air leak (test)', $3, $4) returning id",
        [TOP_LINE, `WO-T-${Math.random().toString(36).slice(2, 7)}`, f.t1, report],
      )).rows[0].id;

      await s.as(owner);
      await s.query("select public.remove_sample_data()");
      await s.asAdmin();
      expect((await s.query("select 1 from public.orders where id = $1", [order.id])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.field_reports where id = $1", [report])).rowCount).toBe(0);
      const kept = await s.query<{ company_id: string; truck_id: string; field_report_id: string | null }>(
        "select company_id, truck_id, field_report_id from public.work_orders where id = $1", [wo]);
      expect(kept.rows).toEqual([{ company_id: TOP_LINE, truck_id: f.t1, field_report_id: null }]);
    });
  });
});
