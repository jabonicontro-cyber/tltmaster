// Wait times (B111, migration 20261120005200; track only): the load's assigned driver taps Arrived / Left at the pickup
// and the site (a repeat keeps the first time); another driver and a mechanic cannot; dispatch can enter or correct times
// (validated, audited); free time is settings.manage; other companies see nothing.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

describe("wait times", () => {
  it("drivers and dispatch record stops; others cannot; corrections are validated", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const mechanic = await s.createUser("mechanic");
      const driverUser = await s.createUser("driver");
      const otherDriverUser = await s.createUser("driver");
      const today = await businessToday(s);
      const f = await fleet(s, office, today);
      await s.as(owner);
      await s.query("update public.drivers set user_id = $1 where id = $2", [driverUser, f.d1]);
      await s.query("update public.drivers set user_id = $1 where id = $2", [otherDriverUser, f.d2]);
      const order = await scheduledOrder(s, office, addDays(today, -1), addDays(today, 2), addDays(today, -1));
      const load = await planLoad(s, order.id, today, "07:00", "09:00", { planned_quantity: "20", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);

      // The assigned driver: arrive, a repeat keeps the first time, then leave; leaving the site first is refused.
      await s.as(driverUser);
      expect((await pgError(s.query("select public.load_stop_mark($1, 'site', 'depart')", [load.load_id]))).message).toMatch(/Arrived first/);
      await s.query("select public.load_stop_mark($1, 'pickup', 'arrive')", [load.load_id]);
      const first = (await s.query<{ arrived_at: string }>("select arrived_at from public.load_stop_times where load_id = $1 and stop = 'pickup'", [load.load_id])).rows[0].arrived_at;
      await s.query("select public.load_stop_mark($1, 'pickup', 'arrive')", [load.load_id]);
      await s.query("select public.load_stop_mark($1, 'pickup', 'depart')", [load.load_id]);
      const row = (await s.query<{ arrived_at: string; departed_at: string | null; source: string }>("select arrived_at, departed_at, source from public.load_stop_times where load_id = $1 and stop = 'pickup'", [load.load_id])).rows[0];
      expect(row.arrived_at).toEqual(first);
      expect(row.departed_at).not.toBeNull();
      expect(row.source).toBe("driver");
      expect((await pgError(s.query("select public.load_stop_mark($1, 'yard', 'arrive')", [load.load_id]))).code).toBe("22023");
      expect((await pgError(s.query("select public.load_stop_set($1, 'site', now() - interval '1 hour', now())", [load.load_id]))).code).toBe("42501");

      // Sent later from the phone (B133, 20261120006100): the tapped time is kept, within 16 hours and not in the future;
      // a departure never before its arrival; another driver still cannot.
      expect((await pgError(s.query("select public.load_stop_mark_at($1, 'site', 'arrive', now() + interval '10 minutes')", [load.load_id]))).message).toMatch(/too old|tell the office/);
      expect((await pgError(s.query("select public.load_stop_mark_at($1, 'site', 'arrive', now() - interval '17 hours')", [load.load_id]))).code).toBe("22023");
      await s.query("select public.load_stop_mark_at($1, 'site', 'arrive', now() - interval '50 minutes')", [load.load_id]);
      expect((await pgError(s.query("select public.load_stop_mark_at($1, 'site', 'depart', now() - interval '60 minutes')", [load.load_id]))).message).toMatch(/before Arrived/);
      await s.query("select public.load_stop_mark_at($1, 'site', 'depart', now() - interval '5 minutes')", [load.load_id]);
      const queued = (await s.query<{ minutes: number }>("select extract(epoch from departed_at - arrived_at)::int / 60 minutes from public.load_stop_times where load_id = $1 and stop = 'site'", [load.load_id])).rows[0];
      expect(queued.minutes).toBe(45);
      await s.asAdmin();
      await s.query("update public.load_stop_times set arrived_at = null, departed_at = null where load_id = $1 and stop = 'site'", [load.load_id]);

      // Another driver and a mechanic cannot record this load; the other driver cannot read it either.
      await s.as(otherDriverUser);
      expect((await pgError(s.query("select public.load_stop_mark($1, 'site', 'arrive')", [load.load_id]))).code).toBe("42501");
      expect((await pgError(s.query("select public.load_stop_mark_at($1, 'site', 'arrive', now())", [load.load_id]))).code).toBe("42501");
      expect((await s.query("select 1 from public.load_stop_times where load_id = $1", [load.load_id])).rowCount).toBe(0);
      await s.as(mechanic);
      expect((await pgError(s.query("select public.load_stop_mark($1, 'site', 'arrive')", [load.load_id]))).code).toBe("42501");

      // Dispatch enters the site times; invalid times are refused.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.load_stop_set($1, 'site', now(), now() - interval '1 hour')", [load.load_id]))).code).toBe("22023");
      expect((await pgError(s.query("select public.load_stop_set($1, 'site', now() - interval '20 days', null)", [load.load_id]))).code).toBe("22023");
      await s.query("select public.load_stop_set($1, 'site', now() - interval '90 minutes', now() - interval '10 minutes')", [load.load_id]);
      const site = (await s.query<{ minutes: number; source: string }>("select extract(epoch from departed_at - arrived_at)::int / 60 minutes, source from public.load_stop_times where load_id = $1 and stop = 'site'", [load.load_id])).rows[0];
      expect(site).toEqual({ minutes: 80, source: "office" });
      expect((await pgError(s.query("insert into public.load_stop_times (company_id, load_id, order_id, stop) values (private.current_company_id(), $1, $2, 'site')", [load.load_id, order.id]))).code).toBe("42501");

      // Free time: settings.manage only, validated.
      expect((await pgError(s.query("select public.wait_time_save_settings(30)"))).code).toBe("42501");
      await s.as(owner);
      expect((await pgError(s.query("select public.wait_time_save_settings(2)"))).code).toBe("22023");
      await s.query("select public.wait_time_save_settings(45)");
      expect((await s.query<{ free_minutes: number }>("select free_minutes from public.wait_time_settings")).rows[0].free_minutes).toBe(45);
      expect((await pgError(s.query("select public.demo_wait_time_samples()"))).code).toBe("42501");

      // Another company sees nothing and cannot write.
      const other = await s.createCompany("Wait Elsewhere (test)");
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await s.query("select 1 from public.load_stop_times where load_id = $1", [load.load_id])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.load_stop_mark($1, 'site', 'arrive')", [load.load_id]))).code).toBe("P0002");
    });
  });
});
