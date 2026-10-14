import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pool, withSession, type Session } from "./helpers";

// Driver schedule notices (migration 20261114000500): a driver with a login is told, inside Taviron, when a load is
// assigned to them and when its date or times change; each distinct change once. Fictional data, rolled back.

afterAll(() => pool.end());

const save = (s: Session, p: Record<string, unknown>) => s.query("select public.save_order_load($1::jsonb)", [JSON.stringify(p)]);
async function notices(s: Session, user: string) {
  await s.asAdmin();
  return (await s.query<{ event_type: string; title: string; detail: string; priority: string }>(
    `select a.event_type, a.title, a.detail, a.priority from public.alerts a
     join public.alert_recipients r on r.alert_id = a.id
     where r.user_id = $1 and a.event_type like 'dispatch.assignment_%' order by a.created_at, a.title`, [user])).rows;
}

describe("driver schedule notices", () => {
  it("a driver is told about a new load and each change of its date or time, once per change", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const office = await s.createUser("office");
      const driverUser = await s.createUser("driver");
      const f = await fleet(s, office, today);
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $1 where id = $2", [driverUser, f.d1]);
      const day = addDays(today, 3);
      const order = await scheduledOrder(s, office, today, addDays(today, 6));
      const load = await planLoad(s, order.id, day, "07:00", "08:30");
      await assign(s, load.load_id, f.t1, null, f.d1);

      let n = await notices(s, driverUser);
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ event_type: "dispatch.assignment_new", priority: "informational" });
      expect(n[0].title).toMatch(new RegExp(`^New load: ${order.number} load 1 on .*, 7:00–8:30$`));

      await s.as(office);
      await save(s, { load_id: load.load_id, load_date: day, start_time: "09:00", end_time: "10:30" });
      await save(s, { load_id: load.load_id, load_date: day, start_time: "09:00", end_time: "10:30" }); // same again: merged
      await save(s, { load_id: load.load_id, load_date: addDays(day, 1), start_time: "09:00", end_time: "10:30" });
      n = await notices(s, driverUser);
      const changed = n.filter((x) => x.event_type === "dispatch.assignment_changed");
      expect(changed).toHaveLength(2);
      expect(changed[0].title).toMatch(/, 9:00–10:30$/);
      expect(changed[0].detail).toMatch(/^Was .*, 7:00–8:30\. Check My Day\.$/);
    });
  });

  it("drivers without a login and other drivers are not told; unrelated edits raise nothing", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const office = await s.createUser("office");
      const bystander = await s.createUser("driver");
      const f = await fleet(s, office, today);
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $1 where id = $2", [bystander, f.d2]); // d2 has a login, d1 not
      const order = await scheduledOrder(s, office, today, addDays(today, 6));
      const load = await planLoad(s, order.id, addDays(today, 2), "07:00", "08:00");
      await assign(s, load.load_id, f.t1, null, f.d1);
      await s.as(office);
      await save(s, { load_id: load.load_id, load_date: addDays(today, 2), start_time: "07:00", end_time: "08:00", notes: "gate code 1234" });
      expect(await notices(s, bystander)).toEqual([]);
    });
  });
});
