import { afterAll, describe, expect, it } from "vitest";
import { pool, withSession } from "./helpers";

afterAll(() => pool.end());

// Demos refresh themselves (20261120002800): the database lets only a demo's owner claim a refresh, once per version
// and day, one at a time; a failure waits an hour; real companies are never claimed.

const claim = async (s: { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<{ r: boolean }> }> }, version: string) =>
  (await s.query("select public.demo_auto_refresh_claim($1, current_date) r", [version])).rows[0].r;
const finish = (s: { query: (q: string, p?: unknown[]) => Promise<unknown> }, version: string, ok: boolean) =>
  s.query("select public.demo_auto_refresh_finish($1, current_date, $2, 'test')", [version, ok]);

describe("demo auto refresh", () => {
  it("only a demo's owner claims it, once per version and day, one run at a time", async () => {
    await withSession(async (s) => {
      const demo = await s.createCompany("Auto Refresh Demo (test)");
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      const owner = await s.createUser("owner", { companyId: demo });
      const dispatcher = await s.createUser("dispatcher", { companyId: demo });
      await s.query("update public.profiles set active_company_id = $1 where id = any($2::uuid[])", [demo, [owner, dispatcher]]);

      await s.as(dispatcher);
      expect(await claim(s, "v1")).toBe(false);

      await s.as(owner);
      expect(await claim(s, "v1")).toBe(true);
      expect(await claim(s, "v1")).toBe(false); // already running
      await finish(s, "v1", true);
      expect(await claim(s, "v1")).toBe(false); // current
      expect(await claim(s, "v2")).toBe(true); // a new deployment
      await finish(s, "v2", false);
      expect(await claim(s, "v3")).toBe(false); // a failure waits an hour

      await s.asAdmin();
      const log = await s.query<{ action: string; summary: string }>("select action, summary from private.platform_audit where target_id = $1 order by id", [demo]);
      expect(log.rows.map((r) => r.action)).toEqual(["demo_refreshed", "demo_refresh_failed"]);
      expect(log.rows[0].summary).toBe("Automatic: test");
    });
  });

  it("a real company's owner never claims a refresh", async () => {
    await withSession(async (s) => {
      const real = await s.createCompany("Real Hauling (test)");
      const owner = await s.createUser("owner", { companyId: real });
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [real, owner]);
      await s.as(owner);
      expect(await claim(s, "v1")).toBe(false);
      await finish(s, "v1", true);
      await s.asAdmin();
      expect((await s.query("select 1 from private.demo_refresh_state where company_id = $1", [real])).rowCount).toBe(0);
    });
  });
});
