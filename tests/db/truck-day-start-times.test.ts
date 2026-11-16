// Truck-day jobs, different start times in one step (UX11 open item, migration 20261120022100): one slot per start time,
// all or none, with the same permission, company and order checks as truck_day_plan.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { businessToday, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

describe("truck-day slots with their own start times", () => {
  it("adds one slot per start time, all in one step, for dispatch.edit in the caller's own company only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const driver = await s.createUser("driver");
      const today = await businessToday(s);
      const order = await scheduledOrder(s, owner, today);
      const count = async () => (await s.query("select 1 from public.order_loads where order_id = $1", [order.id])).rowCount;

      // Only a truck-day order.
      await s.as(owner);
      expect((await pgError(s.query("select public.truck_day_slots($1, $2, array['06:00','07:30']::time[], '17:00')", [order.id, today]))).message).toMatch(/set number of loads/);
      await s.query("select public.set_order_job_type($1, 'truck_day', 'tickets')", [order.id]);

      // A driver (no dispatch.edit) is refused.
      await s.as(driver);
      expect((await pgError(s.query("select public.truck_day_slots($1, $2, array['06:00']::time[], '17:00')", [order.id, today]))).code).toBe("42501");

      // The dispatcher adds two trucks at 6:00 and one at 7:30.
      await s.as(dispatcher);
      const before = await count();
      const r = (await s.query<{ r: { load_ids: string[]; count: number } }>(
        "select public.truck_day_slots($1, $2, array['06:00','06:00','07:30']::time[], '17:00', 'Gate 2') r", [order.id, today],
      )).rows[0].r;
      expect(r.count).toBe(3);
      expect(r.load_ids).toHaveLength(3);
      const slots = (await s.query<{ start_time: string; end_time: string; notes: string; planned_quantity: string | null }>(
        "select start_time::text, end_time::text, notes, planned_quantity from public.order_loads where id = any($1::uuid[]) order by start_time, load_number", [r.load_ids],
      )).rows;
      expect(slots.map((x) => x.start_time)).toEqual(["06:00:00", "06:00:00", "07:30:00"]);
      expect(slots.every((x) => x.end_time === "17:00:00" && x.notes === "Gate 2" && x.planned_quantity === null)).toBe(true);
      expect(await count()).toBe(before! + 3);

      // Invalid input changes nothing: an empty list, a missing time, more than 50 trucks, or one truck starting after
      // the planned end (the whole call is refused, the earlier valid slots in it included).
      const n = await count();
      expect((await pgError(s.query("select public.truck_day_slots($1, $2, array[]::time[], '17:00')", [order.id, today]))).code).toBe("22023");
      expect((await pgError(s.query("select public.truck_day_slots($1, $2, array['06:00', null]::time[], '17:00')", [order.id, today]))).code).toBe("22023");
      expect((await pgError(s.query("select public.truck_day_slots($1, $2, array_fill('06:00'::time, array[51]), '17:00')", [order.id, today]))).code).toBe("22023");
      await pgError(s.query("select public.truck_day_slots($1, $2, array['06:00','18:00']::time[], '17:00')", [order.id, today]));
      expect(await count()).toBe(n);

      // Another company's dispatcher does not see the order.
      const other = await s.createCompany(`Slots Other Hauling ${randomUUID().slice(0, 6)} (test)`);
      const otherDispatcher = await s.createUser("dispatcher", { companyId: other });
      await s.as(otherDispatcher);
      expect((await pgError(s.query("select public.truck_day_slots($1, $2, array['06:00']::time[], '17:00')", [order.id, today]))).code).toBe("P0002");
      await s.as(dispatcher);
      expect(await count()).toBe(n);
    });
  });
});
