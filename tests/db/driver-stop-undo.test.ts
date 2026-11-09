// Driver undo for Arrived / Left (migration 20261120011000): the load's own driver takes back their last tap within
// 10 minutes on the same day; Left before Arrived; never another driver's load, the office's times, an old tap, or a
// stop whose detention was decided; another company is refused; each undo is in the history. Fictional data, rolled back.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

describe("driver stop undo", () => {
  it("the driver undoes their own last tap; everyone and everything else is refused", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      const driverUser = await s.createUser("driver");
      const otherDriverUser = await s.createUser("driver");
      const today = await businessToday(s);
      const f = await fleet(s, office, today);
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $1 where id = $2", [driverUser, f.d1]);
      await s.query("update public.drivers set user_id = $1 where id = $2", [otherDriverUser, f.d2]);
      const order = await scheduledOrder(s, office, addDays(today, -1), addDays(today, 2), addDays(today, -1));
      const load = await planLoad(s, order.id, today, "07:00", "09:00", { planned_quantity: "20", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);
      const row = async () => {
        await s.asAdmin();
        return (await s.query<{ arrived_at: string | null; departed_at: string | null }>("select arrived_at, departed_at from public.load_stop_times where load_id = $1 and stop = 'pickup'", [load.load_id])).rows[0];
      };

      await s.as(driverUser);
      expect((await pgError(s.query("select public.load_stop_undo($1, 'pickup', 'arrive')", [load.load_id]))).code).toBe("P0002");
      await s.query("select public.load_stop_mark($1, 'pickup', 'arrive')", [load.load_id]);
      await s.query("select public.load_stop_mark($1, 'pickup', 'depart')", [load.load_id]);
      // The last event first: Arrived cannot be undone while Left is recorded.
      expect((await pgError(s.query("select public.load_stop_undo($1, 'pickup', 'arrive')", [load.load_id]))).message).toMatch(/Undo Left first/);
      expect((await pgError(s.query("select public.load_stop_undo($1, 'yard', 'arrive')", [load.load_id]))).code).toBe("22023");

      // Another driver, the dispatcher (the office corrects with load_stop_set) are refused.
      await s.as(otherDriverUser);
      expect((await pgError(s.query("select public.load_stop_undo($1, 'pickup', 'depart')", [load.load_id]))).code).toBe("42501");
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.load_stop_undo($1, 'pickup', 'depart')", [load.load_id]))).code).toBe("42501");

      await s.as(driverUser);
      await s.query("select public.load_stop_undo($1, 'pickup', 'depart')", [load.load_id]);
      expect((await row()).departed_at).toBeNull();
      // Already undone: a second undo of Left is refused, nothing changes.
      await s.as(driverUser);
      expect((await pgError(s.query("select public.load_stop_undo($1, 'pickup', 'depart')", [load.load_id]))).code).toBe("22023");
      await s.query("select public.load_stop_undo($1, 'pickup', 'arrive')", [load.load_id]);
      expect(await row()).toEqual({ arrived_at: null, departed_at: null });
      // A new tap records again.
      await s.as(driverUser);
      await s.query("select public.load_stop_mark($1, 'pickup', 'arrive')", [load.load_id]);
      expect((await row()).arrived_at).not.toBeNull();

      // Older than 10 minutes: refused.
      await s.query("update public.load_stop_times set arrived_at = now() - interval '11 minutes' where load_id = $1 and stop = 'pickup'", [load.load_id]);
      await s.as(driverUser);
      expect((await pgError(s.query("select public.load_stop_undo($1, 'pickup', 'arrive')", [load.load_id]))).message).toMatch(/10 minutes/);

      // Times the office entered are not the driver's to undo.
      await s.as(dispatcher);
      await s.query("select public.load_stop_set($1, 'site', now() - interval '5 minutes', null)", [load.load_id]);
      await s.as(driverUser);
      expect((await pgError(s.query("select public.load_stop_undo($1, 'site', 'arrive')", [load.load_id]))).code).toBe("42501");

      // A decided detention keeps its Left time.
      await s.asAdmin();
      await s.query("update public.load_stop_times set arrived_at = now() - interval '5 minutes', departed_at = now(), detention_status = 'dismissed', detention_reason = 'test' where load_id = $1 and stop = 'pickup'", [load.load_id]);
      await s.as(driverUser);
      expect((await pgError(s.query("select public.load_stop_undo($1, 'pickup', 'depart')", [load.load_id]))).message).toMatch(/detention/);

      // History.
      await s.asAdmin();
      const log = (await s.query<{ summary: string }>("select summary from public.audit_events where action = 'wait_time.undone' and entity_id = $1 order by summary desc", [order.id])).rows;
      expect(log.map((l) => l.summary)).toEqual(["Left pickup undone by the driver", "Arrived pickup undone by the driver"]);

      // Another company's member cannot reach the load at all.
      const other = await s.createCompany("Undo Other Co");
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await pgError(s.query("select public.load_stop_undo($1, 'pickup', 'depart')", [load.load_id]))).code).toBe("P0002");
    });
  });
});
