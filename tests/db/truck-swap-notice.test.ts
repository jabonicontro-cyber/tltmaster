// Truck-only swap notices (migration 20261120011400): a reassignment that keeps the driver, load and times tells the
// driver once ("Truck changed"), not a cancel plus a new load; a swap to another driver still tells both drivers as
// before. The cancel notice is raised at commit, so the tests fire pending notices with SET CONSTRAINTS ALL IMMEDIATE.
// Fictional data, rolled back.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function notices(s: Session, user: string) {
  await s.asAdmin();
  await s.query("set constraints all immediate"); // what commit would do
  return (await s.query<{ event_type: string; title: string; detail: string }>(
    `select a.event_type, a.title, a.detail from public.alerts a join public.alert_recipients r on r.alert_id = a.id
     where r.user_id = $1 and a.event_type like 'dispatch.assignment_%' order by a.created_at, a.event_type`, [user])).rows;
}

describe("truck swap notices", () => {
  it("a truck-only swap is one notice; a driver change is a cancel and a new load", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const office = await s.createUser("office");
      const u1 = await s.createUser("driver");
      const u2 = await s.createUser("driver");
      const f = await fleet(s, office, today);
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $1 where id = $2", [u1, f.d1]);
      await s.query("update public.drivers set user_id = $1 where id = $2", [u2, f.d2]);
      await s.query("set constraints all deferred");
      const order = await scheduledOrder(s, office, today, addDays(today, 6));
      const load = await planLoad(s, order.id, addDays(today, 2), "07:00", "08:30");
      const first = await assign(s, load.load_id, f.t1, null, f.d1);
      expect((await notices(s, u1)).map((n) => n.event_type)).toEqual(["dispatch.assignment_new"]);

      // Same driver, load and times; only the truck changes: one "Truck changed" notice, no cancel.
      await s.query("set constraints all deferred");
      await s.as(office);
      const second = await assign(s, load.load_id, f.t2, null, f.d1, first);
      let n = await notices(s, u1);
      expect(n.map((x) => x.event_type)).toEqual(["dispatch.assignment_new", "dispatch.assignment_truck"]);
      expect(n[1].title).toMatch(new RegExp(`^Truck changed: ${order.number} load 1 on .*, 7:00–8:30$`));
      expect(n[1].detail).toMatch(/^Now truck .+\. Was truck .+\. Same load and times\. Check My Day\.$/);

      // Another driver takes the load: the first driver is told it was canceled, the second gets a new load.
      await s.query("set constraints all deferred");
      await s.as(office);
      await assign(s, load.load_id, f.t2, null, f.d2, second);
      n = await notices(s, u1);
      expect(n.map((x) => x.event_type)).toEqual(["dispatch.assignment_new", "dispatch.assignment_truck", "dispatch.assignment_canceled"]);
      expect((await notices(s, u2)).map((x) => x.event_type)).toEqual(["dispatch.assignment_new"]);
    });
  });
});
