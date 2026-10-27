// End-of-day owner summary (B97, migration 20261120004200): off until switched on; due once the company's hour has
// come; recorded once per day; never for a demo; the scheduled-job functions are service role only.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession } from "./helpers";

afterAll(() => pool.end());

describe("daily summary", () => {
  it("is due only when switched on and past the hour, once a day, never for a demo", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const mine = (await s.query<{ r: Record<string, number> }>("select public.my_daily_summary(current_date) r")).rows[0].r;
      expect(Object.keys(mine).sort()).toEqual(["day", "delivered", "loads", "missing_tickets", "open_reports", "to_review", "tomorrow_loads", "tomorrow_without_truck", "trucks_down", "without_truck"].sort());
      // The scheduled-job functions are not for app users.
      expect((await pgError(s.query("select public.daily_summary_due()"))).message).toMatch(/permission denied/);
      expect((await pgError(s.query("select public.daily_summary_record($1, current_date, 'sent', 1, '')", [TOP_LINE]))).message).toMatch(/permission denied/);

      await s.asAdmin();
      const due = async () => ((await s.query<{ r: Array<{ company_id: string; recipients: string[] }> }>("select public.daily_summary_due() r")).rows[0].r).filter((x) => x.company_id === TOP_LINE);
      await s.query("update public.company_settings set daily_summary_enabled = false where company_id = $1", [TOP_LINE]);
      expect(await due()).toEqual([]);
      await s.query("update public.company_settings set daily_summary_enabled = true, daily_summary_hour = 23 where company_id = $1", [TOP_LINE]);
      const hour = (await s.query<{ h: number }>("select extract(hour from now() at time zone coalesce(timezone, 'America/Chicago'))::int h from public.company_settings where company_id = $1", [TOP_LINE])).rows[0].h;
      if (hour < 23) expect(await due()).toEqual([]);
      await s.query("update public.company_settings set daily_summary_hour = 0 where company_id = $1", [TOP_LINE]);
      const [row] = await due();
      expect(row.recipients.length).toBeGreaterThan(0);
      const day = (await s.query<{ d: string }>("select (now() at time zone coalesce(timezone, 'America/Chicago'))::date::text d from public.company_settings where company_id = $1", [TOP_LINE])).rows[0].d;
      expect((await s.query<{ r: boolean | null }>("select public.daily_summary_record($1, $2, 'sent', 1, '') r", [TOP_LINE, day])).rows[0].r).toBe(true);
      expect((await s.query<{ r: boolean | null }>("select public.daily_summary_record($1, $2, 'sent', 1, '') r", [TOP_LINE, day])).rows[0].r).toBeNull();
      expect(await due()).toEqual([]);

      // A demo company is never due.
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [TOP_LINE]);
      await s.query("delete from public.daily_summary_log where company_id = $1", [TOP_LINE]);
      expect(await due()).toEqual([]);
    });
  });
});
