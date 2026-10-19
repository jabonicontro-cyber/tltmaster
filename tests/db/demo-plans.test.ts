// Plan demos (20261120000300): the platform owner shows a demo company as Essential, Growth or Professional. Bases
// follow the plan (1/2/3), records are spread across bases once (stable, idempotent), switching back to Essential
// returns everything to the default base, and a real company or a non-platform user is refused.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  return id;
}

async function demoCompany(s: Session, demo = true) {
  await s.asAdmin();
  const id = await s.createCompany(`Plan Demo ${randomUUID().slice(0, 8)} (test)`);
  if (demo) await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [id]);
  for (let i = 0; i < 12; i++) await s.query("insert into public.trucks (company_id, unit_number, truck_type) values ($1, $2, 'tri_axle_dump')", [id, `D-${i}`]);
  for (let i = 0; i < 9; i++) await s.query("insert into public.drivers (company_id, name) values ($1, $2)", [id, `Driver ${i}`]);
  return id;
}

const layout = async (s: Session, c: string) => {
  await s.asAdmin();
  const bases = (await s.query<{ code: string; active: boolean; trucks: string }>(
    "select b.code, b.active, (select count(*) from public.trucks t where t.base_id = b.id) trucks from public.dispatch_bases b where b.company_id = $1 order by b.code", [c])).rows;
  return Object.fromEntries(bases.map((b) => [b.code, { active: b.active, trucks: Number(b.trucks) }]));
};

describe("plan demos", () => {
  it("only the platform owner, only demo companies", async () => {
    await withSession(async (s) => {
      const real = await demoCompany(s, false);
      const demo = await demoCompany(s);
      const owner = await s.createUser("owner", { companyId: demo });
      await s.as(owner);
      expect((await pgError(s.query("select public.platform_demo_set_plan($1, 'growth')", [demo]))).code).toBe("42501");
      const admin = await platformAdmin(s);
      await s.as(admin);
      expect((await pgError(s.query("select public.platform_demo_set_plan($1, 'growth')", [real]))).code).toBe("42501");
      expect((await pgError(s.query("select public.platform_demo_set_plan($1, 'enterprise')", [demo]))).code).toBe("22023");
    });
  });

  it("Growth and Professional add bases and spread records once; Essential puts everything back", async () => {
    await withSession(async (s) => {
      const demo = await demoCompany(s);
      const admin = await platformAdmin(s);
      await s.as(admin);
      await s.query("select public.platform_demo_set_plan($1, 'professional')", [demo]);
      const pro = await layout(s, demo);
      expect(Object.keys(pro).sort()).toEqual(["MAIN", "NORTH", "SOUTH"]);
      expect(Object.values(pro).every((b) => b.active)).toBe(true);
      expect(pro.MAIN.trucks + pro.NORTH.trucks + pro.SOUTH.trucks).toBe(12); // nothing duplicated or lost
      expect(pro.NORTH.trucks + pro.SOUTH.trucks).toBeGreaterThan(0);

      // Running it again moves nothing.
      await s.as(admin);
      const again = (await s.query<{ r: { spread: number; moved_back: number } }>("select public.platform_demo_set_plan($1, 'professional') r", [demo])).rows[0].r;
      expect(again).toMatchObject({ spread: 0, moved_back: 0 });
      expect(await layout(s, demo)).toEqual(pro);

      // Growth: South is deactivated and its trucks return to Main.
      await s.as(admin);
      await s.query("select public.platform_demo_set_plan($1, 'growth')", [demo]);
      const growth = await layout(s, demo);
      expect(growth.SOUTH).toEqual({ active: false, trucks: 0 });
      expect(growth.MAIN.trucks).toBe(pro.MAIN.trucks + pro.SOUTH.trucks);
      expect(growth.NORTH.trucks).toBe(pro.NORTH.trucks);

      // Essential: one active base holding everything; the audit log has each switch.
      await s.as(admin);
      await s.query("select public.platform_demo_set_plan($1, 'essential')", [demo]);
      const ess = await layout(s, demo);
      expect(ess.MAIN).toEqual({ active: true, trucks: 12 });
      expect(ess.NORTH.active).toBe(false);
      await s.asAdmin();
      expect(Number((await s.query<{ n: string }>("select count(*) n from private.platform_audit where action = 'demo_plan_set' and target_id = $1", [demo])).rows[0].n)).toBe(4);
      expect((await s.query<{ demo_plan: string }>("select demo_plan from public.companies where id = $1", [demo])).rows[0].demo_plan).toBe("essential");
    });
  });
});
