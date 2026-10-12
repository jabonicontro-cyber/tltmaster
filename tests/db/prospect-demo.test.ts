// Prospect demo tenants (20261106000100): a standing demo company for one
// prospect is never replaced by the presenter's "Start the demo", only the
// platform team creates one, and owner access is granted only by the service
// role, only to an existing login, and only for a prospect demo company.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const service = (s: Session) => s.query("set local role service_role");
async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await service(s);
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  return id;
}
const create = (s: Session, name = `Prairie Test ${Math.random().toString(36).slice(2, 6)}`) =>
  s.query<{ id: string }>("select public.platform_prospect_demo_create($1, 'Rensselaer', 'in', 'America/Chicago') as id", [name]).then((r) => r.rows[0].id);

describe("prospect demo tenants", () => {
  it("are created only by the platform team and survive the presenter demo being reset", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(create(s))).code).toBe("42501");

      const admin = await platformAdmin(s);
      await s.as(admin);
      const prospect = await create(s);
      await s.asAdmin();
      expect((await s.query("select is_demo, demo_kind, active from public.companies where id = $1", [prospect])).rows[0]).toEqual({ is_demo: true, demo_kind: "prospect", active: true });
      expect((await s.query("select state, timezone from public.company_settings where company_id = $1", [prospect])).rows[0]).toEqual({ state: "IN", timezone: "America/Chicago" });

      await s.as(admin);
      const presenter = (await s.query<{ id: string }>("select public.platform_demo_start('America/Chicago') as id")).rows[0].id;
      await s.query("select public.platform_demo_start('America/Chicago')"); // reset
      expect((await s.query<{ id: string }>("select public.platform_demo_enter() as id")).rows[0].id).not.toBe(prospect);
      await s.asAdmin();
      expect((await s.query("select active from public.companies where id = $1", [prospect])).rows[0].active).toBe(true);
      expect((await s.query("select active from public.companies where id = $1", [presenter])).rows[0].active).toBe(false);
      expect((await s.query("select active from public.company_memberships where company_id = $1 and user_id = $2", [prospect, admin])).rows[0].active).toBe(true);
    });
  });

  it("owner access goes only to an existing login, only for a prospect demo, and only through the service role", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin);
      const prospect = await create(s);
      const presenter = (await s.query<{ id: string }>("select public.platform_demo_start('America/Chicago') as id")).rows[0].id;
      const colby = await s.createUser(null, { membership: false }); // a login the person set up themselves

      // App users (even the platform admin) cannot call it.
      await s.as(admin);
      expect((await pgError(s.query("select public.platform_prospect_demo_add_owner($1, $2)", [prospect, colby]))).code).toBe("42501");

      await service(s);
      expect((await pgError(s.query("select public.platform_prospect_demo_add_owner($1, $2)", [TOP_LINE, colby]))).code).toBe("42501");
      expect((await pgError(s.query("select public.platform_prospect_demo_add_owner($1, $2)", [presenter, colby]))).code).toBe("42501");
      expect((await pgError(s.query("select public.platform_prospect_demo_add_owner($1, gen_random_uuid())", [prospect]))).code).toBe("P0002");
      await s.query("select public.platform_prospect_demo_add_owner($1, $2)", [prospect, colby]);

      await s.asAdmin();
      const memberships = (await s.query<{ company_id: string; role: string }>("select company_id, role from public.company_memberships where user_id = $1 and active", [colby])).rows;
      expect(memberships).toEqual([{ company_id: prospect, role: "owner" }]);
      expect((await s.query("select 1 from private.platform_admins where user_id = $1", [colby])).rowCount).toBe(0);

      // Inside the demo they see only the demo.
      await s.as(colby);
      expect((await s.query<{ r: { company_id: string; role: string } }>("select public.my_access() as r")).rows[0].r).toMatchObject({ company_id: prospect, role: "owner" });
      expect((await s.query("select 1 from public.customers where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.employees where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.platform_overview()"))).code).toBe("42501");
      // Only the platform team retires a prospect demo; real companies and the presenter demo are refused.
      expect((await pgError(s.query("select public.platform_prospect_demo_retire($1)", [prospect]))).code).toBe("42501");
      await s.as(admin);
      expect((await pgError(s.query("select public.platform_prospect_demo_retire($1)", [TOP_LINE]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.platform_prospect_demo_retire($1)", [presenter]))).code).toBe("P0002");
      await s.query("select public.platform_prospect_demo_retire($1)", [prospect]);
      await s.asAdmin();
      expect((await s.query("select active from public.companies where id = $1", [prospect])).rows[0].active).toBe(false);
      expect((await s.query("select count(*)::int as n from public.company_memberships where company_id = $1 and active", [prospect])).rows[0].n).toBe(0);
      // A fresh demo with the same name can be created again.
      await s.as(admin);
      const name = (await s.query<{ name: string }>("select name from public.companies where id = $1", [prospect])).rows[0]?.name;
      if (name) expect(await create(s, name)).not.toBe(prospect);
    });
  });
});
