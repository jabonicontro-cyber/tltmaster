// Dispatch bases (20261120000100): one default base per company (backfilled, also for new companies), records default
// to it, plan limits enforced in the database, settings.manage to change, other companies see nothing, and per-base
// reporting counts each record once.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TOP_LINE, pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const company = async (s: Session) => s.createCompany(`Bases Hauling ${randomUUID().slice(0, 6)} (test)`);
const addBase = (s: Session, code: string) => s.query("insert into public.dispatch_bases (code, name, timezone) values ($1, $2, 'America/Chicago') returning id", [code, `Base ${code}`]);

describe("dispatch bases", () => {
  it("every company has exactly one default base; new trucks, drivers and orders land there", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const missing = await s.query("select c.id from public.companies c where (select count(*) from public.dispatch_bases b where b.company_id = c.id and b.is_default) <> 1");
      expect(missing.rowCount).toBe(0);
      const unassigned = await s.query("select 1 from public.trucks where base_id is null union all select 1 from public.drivers where base_id is null union all select 1 from public.orders where base_id is null");
      expect(unassigned.rowCount).toBe(0);
      const c = await company(s);
      expect((await s.query("select 1 from public.dispatch_bases where company_id = $1 and is_default", [c])).rowCount).toBe(1);
      const owner = await s.createUser("owner", { companyId: c });
      await s.as(owner);
      const t = (await s.query<{ base: string; def: string }>("insert into public.trucks (unit_number, truck_type) values ('B-1', 'tri_axle_dump') returning base_id as base, (select id from public.dispatch_bases where is_default) as def")).rows[0];
      expect(t.base).toBe(t.def);
    });
  });

  it("plan limits: one base without a plan or on Essential, two on Growth, three on Professional; deactivating frees a slot", async () => {
    await withSession(async (s) => {
      const c = await company(s);
      const owner = await s.createUser("owner", { companyId: c });
      await s.as(owner);
      expect((await pgError(addBase(s, "NORTH"))).message).toMatch(/plan includes 1 dispatch base\./);
      await s.asAdmin();
      const plan = async (key: string) => {
        const v = (await s.query<{ id: string }>("select id from private.platform_plan_versions where plan_key = $1 order by version desc limit 1", [key])).rows[0].id;
        await s.query("insert into private.company_lifecycle (company_id, plan_version_id) values ($1, $2) on conflict (company_id) do update set plan_version_id = excluded.plan_version_id", [c, v]);
      };
      await plan("growth");
      await s.as(owner);
      const north = (await addBase(s, "north")).rows[0].id as string;
      expect((await s.query<{ code: string }>("select code from public.dispatch_bases where id = $1", [north])).rows[0].code).toBe("NORTH");
      expect((await pgError(addBase(s, "SOUTH"))).message).toMatch(/plan includes 2 dispatch bases/);
      await s.asAdmin();
      await plan("professional");
      await s.as(owner);
      const south = (await addBase(s, "SOUTH")).rows[0].id as string;
      expect((await pgError(addBase(s, "EAST"))).message).toMatch(/plan includes 3 dispatch bases/);
      await s.query("update public.dispatch_bases set active = false where id = $1", [south]);
      await addBase(s, "EAST");
      // Back to Essential: existing bases stay (nothing deleted or moved); reactivating beyond the limit is refused.
      await s.asAdmin();
      await plan("essential");
      await s.as(owner);
      expect((await s.query("select 1 from public.dispatch_bases where active")).rowCount).toBe(3);
      expect((await pgError(s.query("update public.dispatch_bases set active = true where id = $1", [south])))).toBeTruthy();
      // The default cannot be deactivated without choosing another.
      expect((await pgError(s.query("update public.dispatch_bases set active = false where is_default"))).message).toMatch(/another base the default/);
      await s.query("select public.set_default_dispatch_base($1)", [north]);
      expect((await s.query<{ code: string }>("select code from public.dispatch_bases where is_default")).rows[0].code).toBe("NORTH");
    });
  });

  it("only settings.manage changes bases; other companies see none; records cannot point at another company's base", async () => {
    await withSession(async (s) => {
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await s.query("select 1 from public.dispatch_bases")).rowCount).toBeGreaterThan(0);
      expect(["42501", "P0001"]).toContain((await pgError(addBase(s, "X1"))).code); // refused (permission or plan limit)
      expect((await s.query("update public.dispatch_bases set name = 'Renamed' where is_default")).rowCount).toBe(0);
      const topLineBase = (await s.query<{ id: string }>("select id from public.dispatch_bases where is_default")).rows[0].id;
      const other = await company(s);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await s.query("select 1 from public.dispatch_bases where id = $1", [topLineBase])).rowCount).toBe(0);
      expect(["23503", "42501"]).toContain((await pgError(s.query("insert into public.trucks (unit_number, truck_type, base_id) values ('X', 'tri_axle_dump', $1)", [topLineBase]))).code);
      expect(TOP_LINE).toBeTruthy();
    });
  });

  it("per-base summary counts each truck once and adds up to the company total", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const rows = (await s.query<{ r: Array<{ trucks: number }> }>("select public.dispatch_base_summary(current_date - 30, current_date) as r")).rows[0].r;
      const total = Number((await s.query<{ n: string }>("select count(*) n from public.trucks where active")).rows[0].n);
      expect(rows.reduce((n, b) => n + b.trucks, 0)).toBe(total);
    });
  });
});
