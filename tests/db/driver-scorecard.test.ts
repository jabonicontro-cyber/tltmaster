// Driver scorecard (B96, migration 20261120003800): counts only recorded deliveries and reports; a driver sees only
// their own row, dispatch sees every driver, another company sees none.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

type Row = { driver_id: string; loads: number; on_time: number; own_tickets: number; same_day: number; reports: number };

describe("driver scorecard", () => {
  it("counts on-time loads, tickets the driver entered and reports, and shows a driver only their own row", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const day = today;
      const order = await scheduledOrder(s, owner, day);
      const early = await planLoad(s, order.id, day, "08:00", "10:00", { planned_quantity: "20", unit_code: "ton" });
      const late = await planLoad(s, order.id, day, "11:00", "12:00", { planned_quantity: "20", unit_code: "ton" });
      const f = await fleet(s, owner, day);
      await s.as(owner);
      const a1 = await assign(s, early.load_id, f.t1, null, f.d1);
      const a2 = await assign(s, late.load_id, f.t2, null, f.d1);
      const driverUser = await s.createUser("driver");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);
      const tz = (await s.query<{ tz: string }>("select timezone tz from public.company_settings limit 1")).rows[0]?.tz ?? "America/Chicago";
      const line = (await s.query<{ id: string }>("select id from public.order_lines where order_id = $1 limit 1", [order.id])).rows[0].id;
      const ticket = async (assignment: string, load: string, time: string, createdBy: string | null, created: string) =>
        s.query(
          `insert into public.delivery_tickets (company_id, ticket_number, status, order_id, load_id, assignment_id, order_line_id, truck_id, driver_id, delivered_at, quantity, unit_code, snapshot, created_by, created_at)
           select o.company_id, 'T-' || substr(md5(random()::text), 1, 6), 'accepted', o.id, $2, $1, $3, a.truck_id, a.driver_id, (($4::date + $5::time) at time zone $6), 20, 'ton', '{}'::jsonb, $7, (($8::date + time '18:00') at time zone $6)
             from public.orders o join public.dispatch_assignments a on a.id = $1 where o.id = $9`,
          [assignment, load, line, day, time, tz, createdBy, created, order.id],
        );
      // On time and entered by the driver the same day; late (after 12:00) and entered by the office.
      await ticket(a1, early.load_id, "09:30", driverUser, day);
      await ticket(a2, late.load_id, "12:40", null, day);
      await s.query(`insert into public.field_reports (company_id, kind, driver_id, assignment_id, load_id, order_id, description, snapshot, created_at)
                     select company_id, 'delay', $1, $2, $3, $4, 'Waiting at the scale', '{}'::jsonb, (($5::date + time '10:00') at time zone $6) from public.orders where id = $4`, [f.d1, a2, late.load_id, order.id, day, tz]);

      await s.as(owner);
      const all = (await s.query<Row>("select * from public.driver_scorecard($1, $2)", [addDays(day, -1), today])).rows;
      const mine = all.find((r) => r.driver_id === f.d1)!;
      expect([mine.loads, mine.on_time, mine.own_tickets, mine.same_day, mine.reports]).toEqual([2, 1, 1, 1, 1]);
      expect(all.length).toBeGreaterThan(1);
      // The owner's own row only (none: the owner is not a driver).
      expect((await s.query<Row>("select * from public.driver_scorecard($1, $2, true)", [addDays(day, -1), today])).rows).toEqual([]);

      await s.as(driverUser);
      const own = (await s.query<Row>("select * from public.driver_scorecard($1, $2)", [addDays(day, -1), today])).rows;
      expect(own.map((r) => r.driver_id)).toEqual([f.d1]);

      const other = await s.createCompany("Other Co (scorecard)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query<Row>("select * from public.driver_scorecard($1, $2)", [addDays(day, -1), today])).rows.some((r) => r.driver_id === f.d1)).toBe(false);
      expect((await pgError(s.query("select * from public.driver_scorecard($1, $2)", [today, addDays(today, -1)]))).message).toMatch(/up to one year/);
    });
  });
});
