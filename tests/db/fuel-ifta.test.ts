// Fuel and IFTA (B130, 20261120005800): drivers record fuel and trip sheets only for a truck they drove that day (or
// their own truck), the office for any truck; miles per state must add up to the odometer; one live trip sheet per truck
// and day; voids need a reason; drivers see only their own entries; other companies see nothing.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

describe("fuel and IFTA", () => {
  it("records fuel and trip sheets with the right people, checks the miles and voids with a reason", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const day = addDays(today, -1);
      const f = await fleet(s, owner, day);
      const order = await scheduledOrder(s, owner, day);
      const load = await planLoad(s, order.id, day, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);
      const driverUser = await s.createUser("driver");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);

      const trip = (truck: string, legs: unknown, start = 1000, end = 1150, on = day) =>
        s.query<{ r: string }>("select public.fuel_record_trip_sheet($1::jsonb) as r", [JSON.stringify({ truck_id: truck, sheet_date: on, start_odometer: start, end_odometer: end, legs })]);
      const fuel = (truck: string, extra: Record<string, unknown> = {}) =>
        s.query<{ r: string }>("select public.fuel_record_purchase($1::jsonb) as r", [JSON.stringify({ truck_id: truck, purchased_on: day, jurisdiction: "IA", gallons: "80.5", total_cents: 31000, vendor: "Fuel stop", ...extra })]);

      // The driver: only the truck they drove that day (My Day offers exactly those).
      await s.as(driverUser);
      expect((await s.query<{ r: Array<{ id: string; sheet_done: boolean }> }>("select public.fuel_my_trucks($1) r", [day])).rows[0].r).toEqual([{ id: f.t1, unit: expect.any(String), sheet_done: false }]);
      expect((await pgError(trip(f.t2, [{ jurisdiction: "IA", miles: 150 }]))).message).toMatch(/only for a truck you drove/);
      expect((await pgError(trip(f.t1, [{ jurisdiction: "IA", miles: 100 }]))).message).toMatch(/must add up/);
      expect((await pgError(trip(f.t1, [{ jurisdiction: "IA", miles: 75 }, { jurisdiction: "IA", miles: 75 }]))).message).toMatch(/each state once/);
      expect((await pgError(trip(f.t1, [{ jurisdiction: "Iowa", miles: 150 }]))).message).toMatch(/each state/);
      expect((await pgError(trip(f.t1, [{ jurisdiction: "IA", miles: 150 }], 1000, 1150, addDays(today, 1)))).message).toMatch(/not in the future/);
      const sheet = (await trip(f.t1, [{ jurisdiction: "IA", miles: 120 }, { jurisdiction: "NE", miles: 30 }])).rows[0].r;
      expect((await pgError(trip(f.t1, [{ jurisdiction: "IA", miles: 150 }]))).message).toMatch(/already has a trip sheet/);
      expect((await pgError(fuel(f.t1, { gallons: "0" }))).message).toMatch(/more than 0/);
      expect((await pgError(fuel(f.t1, { jurisdiction: "" }))).message).toMatch(/state or province/);
      const purchase = (await fuel(f.t1)).rows[0].r;
      expect((await s.query<{ driver_id: string; gallons: string }>("select driver_id, gallons from public.fuel_purchases where id = $1", [purchase])).rows[0]).toEqual({ driver_id: f.d1, gallons: "80.500" });
      // The driver cannot void; their own entries are readable to them.
      expect((await pgError(s.query("select public.fuel_void('trip_sheet', $1, 'Wrong')", [sheet]))).code).toBe("42501");
      expect((await s.query("select 1 from public.trip_sheets where id = $1", [sheet])).rowCount).toBe(1);

      // Another driver sees none of it.
      const other = await s.createUser("driver");
      await s.as(other);
      expect((await s.query("select 1 from public.trip_sheets where id = $1", [sheet])).rowCount).toBe(0);
      expect((await pgError(fuel(f.t1))).message).toMatch(/only for a truck you drove/);

      // The office records for any truck, voids with a reason, and can then replace the sheet.
      await s.as(owner);
      await fuel(f.t2, { jurisdiction: "NE" });
      expect((await pgError(s.query("select public.fuel_void('trip_sheet', $1, ' ')", [sheet]))).message).toMatch(/why/);
      await s.query("select public.fuel_void('trip_sheet', $1, 'Odometer typo')", [sheet]);
      await trip(f.t1, [{ jurisdiction: "IA", miles: 150 }]);
      expect((await s.query("select count(*)::int n from public.trip_sheets where truck_id = $1 and sheet_date = $2 and not voided", [f.t1, day])).rows[0].n).toBe(1);

      // Other companies see nothing and change nothing.
      const co = await s.createCompany(`Fuel Other ${randomUUID().slice(0, 6)} (test)`);
      const outsider = await s.createUser("owner", { companyId: co });
      await s.as(outsider);
      expect((await s.query("select 1 from public.fuel_purchases where id = $1", [purchase])).rowCount).toBe(0);
      expect((await pgError(fuel(f.t1))).code).toBe("P0002");
      expect((await pgError(s.query("select public.fuel_void('purchase', $1, 'x')", [purchase]))).code).toBe("P0002");
    });
  });

  it("the demo sample is for demo companies only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.demo_fuel_samples()"))).code).toBe("42501");
    });
  });
});
