// Digital inspections (B132, 20261120006000): a driver inspects only a truck they drive today (or their own), every
// item must be checked and each defect described; a defect opens a work order, a safety defect takes the truck out of
// service; a missing pre-trip is listed for the office, never blocking; other drivers and companies see nothing.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

const KEYS = ["service_brakes", "parking_brake", "steering", "lights_reflectors", "tires", "wheels_rims", "coupling", "horn", "wipers", "mirrors", "emergency_equipment"];
const items = (bad: Record<string, string> = {}) => KEYS.map((key) => ({ key, ok: !(key in bad), note: bad[key] ?? "" }));

describe("vehicle inspections", () => {
  it("records inspections with the right people, opens work orders for defects and flags a missing pre-trip", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const f = await fleet(s, owner, today);
      const order = await scheduledOrder(s, owner, today);
      const load = await planLoad(s, order.id, today, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);
      const driverUser = await s.createUser("driver");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);
      const submit = (truck: string, kind: string, its: unknown, extra: Record<string, unknown> = {}) =>
        s.query<{ r: { defects: number; safety: boolean; work_order: string | null } }>("select public.inspection_submit($1::jsonb) r", [JSON.stringify({ truck_id: truck, kind, items: its, ...extra })]);

      // The office sees the truck working today without a pre-trip.
      await s.as(owner);
      const missing = async () => (await s.query<{ r: Array<{ truck_id: string }> }>("select public.inspection_missing_today() r")).rows[0].r.map((m) => m.truck_id);
      expect(await missing()).toContain(f.t1);

      await s.as(driverUser);
      expect((await s.query<{ r: Array<{ id: string; pre_trip: boolean }> }>("select public.inspection_my_trucks() r")).rows[0].r).toEqual([expect.objectContaining({ id: f.t1, pre_trip: false, post_trip: false })]);
      expect((await pgError(submit(f.t2, "pre_trip", items()))).message).toMatch(/only for a truck you drove/);
      expect((await pgError(submit(f.t1, "pre_trip", items().slice(1)))).message).toMatch(/Check every item/);
      expect((await pgError(submit(f.t1, "pre_trip", items({ wipers: "" })))).message).toMatch(/Describe each defect/);
      expect((await pgError(submit(f.t1, "mid_trip", items()))).message).toMatch(/pre-trip or post-trip/);
      expect((await pgError(submit(f.t1, "pre_trip", items(), { odometer: "lots" }))).message).toMatch(/odometer/);

      // Saved without signal and sent later (B133): yesterday is accepted for a truck driven yesterday only; older is refused.
      expect((await pgError(submit(f.t1, "pre_trip", items(), { inspected_on: addDays(today, -2) }))).message).toMatch(/today or yesterday/);
      expect((await pgError(submit(f.t1, "pre_trip", items(), { inspected_on: addDays(today, -1) }))).message).toMatch(/only for a truck you drove/);

      // A minor defect: a normal work order, the truck stays in service.
      const pre = (await submit(f.t1, "pre_trip", items({ mirrors: "Cracked passenger mirror" }), { odometer: "120400" })).rows[0].r;
      expect([pre.defects, pre.safety, typeof pre.work_order]).toEqual([1, false, "string"]);
      expect((await pgError(submit(f.t1, "pre_trip", items()))).message).toMatch(/already has a pre-trip/);
      await s.asAdmin();
      expect((await s.query("select service_status from public.trucks where id = $1", [f.t1])).rows[0].service_status).toBe("in_service");
      const wo = (await s.query("select source, safety_critical, urgency, description from public.work_orders where number = $1 and company_id = (select company_id from public.trucks where id = $2)", [pre.work_order, f.t1])).rows[0];
      expect(wo).toEqual({ source: "inspection", safety_critical: false, urgency: "normal", description: "mirrors: Cracked passenger mirror" });

      // A safety defect after the shift: a safety-critical work order and the truck is out of service.
      await s.as(driverUser);
      const post = (await submit(f.t1, "post_trip", items({ service_brakes: "Air leak at rear chamber" }))).rows[0].r;
      expect([post.defects, post.safety]).toEqual([1, true]);
      await s.asAdmin();
      expect((await s.query("select service_status from public.trucks where id = $1", [f.t1])).rows[0].service_status).toBe("out_of_service");

      // The pre-trip is in, so the office list no longer shows the truck.
      await s.as(owner);
      expect(await missing()).not.toContain(f.t1);

      // Another driver sees none of it and cannot inspect the truck.
      const other = await s.createUser("driver");
      await s.as(other);
      expect((await s.query("select 1 from public.vehicle_inspections where truck_id = $1", [f.t1])).rowCount).toBe(0);
      expect((await pgError(submit(f.t1, "pre_trip", items()))).message).toMatch(/only for a truck you drove/);
      expect((await pgError(s.query("select public.inspection_missing_today()"))).code).toBe("42501");

      // Other companies see nothing and change nothing.
      const co = await s.createCompany(`Insp Other ${randomUUID().slice(0, 6)} (test)`);
      const outsider = await s.createUser("owner", { companyId: co });
      await s.as(outsider);
      expect((await s.query("select 1 from public.vehicle_inspections where truck_id = $1", [f.t1])).rowCount).toBe(0);
      expect((await pgError(submit(f.t1, "post_trip", items()))).code).toBe("P0002");
    });
  });

  it("the demo sample is for demo companies only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.demo_inspection_samples()"))).code).toBe("42501");
    });
  });
});
