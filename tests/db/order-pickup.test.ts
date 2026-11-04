// Pickup on the order (UX7, 20261120006600): an order names one of the company's own active locations; only orders
// editors set it (audited); the driver sees the pickup of their own loads only; other companies' locations are refused.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Pickups = Record<string, { name: string; kind: string; address: string; latitude: string | number | null; longitude: string | number | null }>;
const pickups = async (s: Session) => (await s.query<{ r: Pickups }>("select public.driver_load_pickups() as r")).rows[0].r;
const setPickup = (s: Session, order: string, location: string | null) => s.query("select public.set_order_pickup($1, $2)", [order, location]);

async function world(s: Session) {
  const today = await businessToday(s);
  const office = await s.createUser("office");
  const f = await fleet(s, office, today);
  const order = await scheduledOrder(s, office, today, addDays(today, 1), today);
  const mine = await planLoad(s, order.id, today, "07:00", "09:00");
  await assign(s, mine.load_id, f.t1, null, f.d1);
  const theirs = await planLoad(s, order.id, today, "10:00", "12:00");
  await assign(s, theirs.load_id, f.t2, null, f.d2);
  await s.asAdmin();
  const quarry = await insert(s, "company_locations", { company_id: TOP_LINE, kind: "quarry", name: "North Pit (test)", address_line1: "1 Pit Rd", city: "Ames", state: "IA", latitude: 42.03, longitude: -93.62, location_source: "manual" });
  const closed = await insert(s, "company_locations", { company_id: TOP_LINE, kind: "plant", name: "Old Plant (test)", active: false });
  const other = await s.createCompany("Other Co (test)");
  const foreign = await insert(s, "company_locations", { company_id: other, kind: "quarry", name: "Their Pit (test)" });
  const driver1 = await s.createUser("driver");
  const driver2 = await s.createUser("driver");
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driver1]);
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d2, driver2]);
  return { today, office, order, mine, theirs, quarry, closed, foreign, driver1, driver2 };
}

describe("order pickup", () => {
  it("is set by orders editors, audited, and shown to the driver for their own loads only", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      expect(await pickups(s)).toEqual({});

      await s.as(w.office);
      await setPickup(s, w.order.id, w.quarry);
      expect((await s.query<{ p: string }>("select pickup_location_id as p from public.orders where id = $1", [w.order.id])).rows[0].p).toBe(w.quarry);
      await s.asAdmin();
      expect((await s.query<{ summary: string }>("select summary from public.audit_events where action = 'order.pickup_set' and entity_id = $1", [w.order.id])).rows[0].summary).toMatch(/North Pit \(test\)/);

      await s.as(w.driver1);
      const p = await pickups(s);
      expect(Object.keys(p)).toEqual([w.mine.load_id]);
      expect(p[w.mine.load_id]).toMatchObject({ name: "North Pit (test)", kind: "quarry", address: "1 Pit Rd, Ames, IA" });
      expect(Number(p[w.mine.load_id].latitude)).toBeCloseTo(42.03);
      await s.as(w.driver2);
      expect(Object.keys(await pickups(s))).toEqual([w.theirs.load_id]);

      // Clearing it removes it from the driver's card.
      await s.as(w.office);
      await setPickup(s, w.order.id, null);
      await s.as(w.driver1);
      expect(await pickups(s)).toEqual({});
    });
  });

  it("refuses inactive and other companies' locations, roles without orders.edit, and non-drivers", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      expect((await pgError(setPickup(s, w.order.id, w.closed))).message).toMatch(/active locations/);
      expect((await pgError(setPickup(s, w.order.id, w.foreign))).message).toMatch(/active locations/);
      await s.as(w.driver1);
      expect((await pgError(setPickup(s, w.order.id, w.quarry))).code).toBe("42501");
      const mechanic = await s.createUser("mechanic");
      await s.as(mechanic);
      expect((await pgError(setPickup(s, w.order.id, w.quarry))).code).toBe("42501");
      expect((await pgError(pickups(s))).code).toBe("42501");
      // The foreign key keeps an order from pointing at another company's location even outside the function.
      await s.asAdmin();
      expect((await pgError(s.query("update public.orders set pickup_location_id = $2 where id = $1", [w.order.id, w.foreign]))).code).toBe("23503");
    });
  });
});
