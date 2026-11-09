// Saved ticket driver name (migration 20261120011300): a ticket's snapshot names the driver with driver_list's rule —
// in a demo company the driver record's own name first, otherwise the login's profile name, else the record's name.
// Fictional data, rolled back.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { TOP_LINE, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function submitFor(s: Session, office: string, order: { materialLine: string }, load: string, day: string) {
  await s.as(office);
  const r = await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
    load_id: load, order_line_id: order.materialLine, delivered_date: day, delivered_time: "08:30", quantity: "10", unit_code: "ton",
    external_reference: `SC-${randomUUID().slice(0, 8)}`,
  })]);
  await s.asAdmin();
  return (await s.query<{ name: string }>("select snapshot ->> 'driver_name' as name from public.delivery_tickets where id = $1", [r.rows[0].r.ticket_id])).rows[0].name;
}

describe("ticket driver name", () => {
  it("uses the same name as driver_list, in live and demo companies", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const yesterday = addDays(today, -1);
      const office = await s.createUser("office");
      const driverUser = await s.createUser("driver"); // profile name "Test driver"
      const f = await fleet(s, office, yesterday);
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $1, name = 'Dana Record' where id = $2", [driverUser, f.d1]);
      await s.query("update public.drivers set name = 'Ray Nologin' where id = $1", [f.d2]);
      const order = await scheduledOrder(s, office, addDays(today, -2), today, addDays(today, -2));
      const l1 = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
      const l2 = await planLoad(s, order.id, yesterday, "09:00", "11:00", { planned_quantity: "22", unit_code: "ton" });
      const l3 = await planLoad(s, order.id, yesterday, "11:00", "13:00", { planned_quantity: "22", unit_code: "ton" });
      await assign(s, l1.load_id, f.t1, null, f.d1);
      await assign(s, l2.load_id, f.t2, null, f.d1);
      await assign(s, l3.load_id, f.t1, null, f.d2);
      const listed = async (driver: string) => {
        await s.as(office);
        return (await s.query<{ n: string }>("select display_name n from public.driver_list where id = $1", [driver])).rows[0].n;
      };

      // A live company: the login's profile name, as driver_list shows it; a driver without a login keeps the record's name.
      expect(await submitFor(s, office, order, l1.load_id, yesterday)).toBe("Test driver");
      expect(await listed(f.d1)).toBe("Test driver");
      expect(await submitFor(s, office, order, l3.load_id, yesterday)).toBe("Ray Nologin");

      // A demo company: the driver record's own name first, as driver_list shows it.
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [TOP_LINE]);
      expect(await submitFor(s, office, order, l2.load_id, yesterday)).toBe("Dana Record");
      expect(await listed(f.d1)).toBe("Dana Record");
    });
  });
});
