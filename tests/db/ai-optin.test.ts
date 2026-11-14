// Ask Taviron's company opt-in and first-use notice (master plan §11a, migration 20261120022000): off by default; only
// settings.manage changes it, only for its own company, never during a Taviron support visit, audited; the notice is
// recorded per person and company, never for someone else and never for a support visitor.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const allowed = async (s: Session, company: string) =>
  (await s.query<{ a: boolean }>("select ai_assistant_allowed a from public.company_settings where company_id = $1", [company])).rows[0]?.a;

async function supportStaff(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  await s.query("update private.platform_admins set level = 'support' where user_id = $1", [id]);
  return id;
}

describe("Ask Taviron company opt-in", () => {
  it("starts off, and only someone with settings.manage turns it on or off for their own company, audited", async () => {
    await withSession(async (s) => {
      const other = await s.createCompany(`Opt-in Other Hauling ${randomUUID().slice(0, 6)} (test)`);
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.asAdmin();
      // Every company starts off (a new company here; Top Line is reset inside this test's transaction).
      expect(await allowed(s, other)).toBe(false);
      await s.query("update public.company_settings set ai_assistant_allowed = false where company_id = $1", [TOP_LINE]);

      // A dispatcher (no settings.manage) is refused, and cannot write the column directly either.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.set_ai_assistant_allowed(true)"))).code).toBe("42501");
      expect((await pgError(s.query("update public.company_settings set ai_assistant_allowed = true where company_id = $1", [TOP_LINE]))).code).toBe("42501");
      // Neither can an owner write the column around the function.
      await s.as(owner);
      expect((await pgError(s.query("update public.company_settings set ai_assistant_allowed = true where company_id = $1", [TOP_LINE]))).code).toBe("42501");
      expect((await pgError(s.query("select public.set_ai_assistant_allowed(null)"))).code).toBe("22023");

      // The owner turns it on for their own company only.
      expect((await s.query<{ r: boolean }>("select public.set_ai_assistant_allowed(true) r")).rows[0].r).toBe(true);
      const row = (await s.query<{ a: boolean; by: string; at: Date | null }>("select ai_assistant_allowed a, ai_assistant_changed_by by, ai_assistant_changed_at at from public.company_settings where company_id = $1", [TOP_LINE])).rows[0];
      expect(row).toMatchObject({ a: true, by: owner });
      expect(row.at).not.toBeNull();
      await s.asAdmin();
      expect(await allowed(s, other)).toBe(false);
      // Audited (the company_settings audit trigger records the change in the company's own log).
      const audit = await s.query("select 1 from public.audit_events where company_id = $1 and entity_type = 'company_settings' and actor_id = $2 and details::text like '%ai_assistant_allowed%'", [TOP_LINE, owner]);
      expect(audit.rowCount).toBeGreaterThan(0);

      // The other company's owner changes only their own.
      await s.as(otherOwner);
      expect(await allowed(s, TOP_LINE)).toBeUndefined(); // another company's settings are not even readable
      await s.query("select public.set_ai_assistant_allowed(true)");
      await s.query("select public.set_ai_assistant_allowed(false)");
      await s.asAdmin();
      expect(await allowed(s, TOP_LINE)).toBe(true);
      expect(await allowed(s, other)).toBe(false);

      // Turned off again by the owner.
      await s.as(owner);
      await s.query("select public.set_ai_assistant_allowed(false)");
      expect(await allowed(s, TOP_LINE)).toBe(false);

      // Signed out: refused.
      await s.as(null);
      expect((await pgError(s.query("select public.set_ai_assistant_allowed(true)"))).code).toBe("42501");
    });
  });

  it("a Taviron support visit cannot turn it on and cannot accept the notice", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany(`Opt-in Visit Hauling ${randomUUID().slice(0, 6)} (test)`);
      const owner = await s.createUser("owner", { companyId: company });
      const sup = await supportStaff(s);
      await s.as(owner);
      await s.query("select public.support_access_grant(3)");
      await s.as(sup);
      await s.query("select public.platform_support_enter($1, 'Set up the menu')", [company]);
      // The visit holds owner permissions, so settings.manage alone would pass: the function refuses the visit itself.
      expect((await s.query<{ a: { company_id: string | null } }>("select public.my_access() a")).rows[0].a.company_id).toBe(company);
      const e = await pgError(s.query("select public.set_ai_assistant_allowed(true)"));
      expect(e.code).toBe("42501");
      expect(e.message).toMatch(/not a Taviron support visit/);
      expect((await pgError(s.query("select public.acknowledge_ai_notice(1)"))).code).toBe("42501");
      await s.asAdmin();
      expect(await allowed(s, company)).toBe(false);
    });
  });
});

describe("Ask Taviron first-use notice", () => {
  it("is recorded for the caller in the current company only, keeps the newest version and is refused to non-members", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      const read = async () => (await s.query<{ value: { version: number; acknowledged_at: string } }>("select value from public.user_preferences where key = 'ai_notice'")).rows;

      await s.as(office);
      expect(await read()).toHaveLength(0);
      await s.query("select public.acknowledge_ai_notice(1)");
      const first = await read();
      expect(first).toHaveLength(1);
      expect(first[0].value.version).toBe(1);
      // A repeat, or an older version, changes nothing; a newer notice version replaces it.
      await s.query("select public.acknowledge_ai_notice(1)");
      expect((await read())[0].value.acknowledged_at).toBe(first[0].value.acknowledged_at);
      await s.query("select public.acknowledge_ai_notice(2)");
      await s.query("select public.acknowledge_ai_notice(1)");
      expect((await read())[0].value.version).toBe(2);
      expect((await pgError(s.query("select public.acknowledge_ai_notice(0)"))).code).toBe("22023");

      // Another person has their own record; nobody writes it for someone else.
      await s.as(dispatcher);
      expect(await read()).toHaveLength(0);
      expect((await pgError(s.query("insert into public.user_preferences (company_id, user_id, key, value) values ($1, $2, 'ai_notice', '{\"version\": 9}')", [TOP_LINE, office]))).code).toBe("42501");
      expect((await pgError(s.query("update public.user_preferences set value = '{\"version\": 9}' where key = 'ai_notice'"))).code).toBe("42501");

      // No company, or signed out: refused.
      const outsider = await s.createUser(null, { membership: false });
      await s.as(outsider);
      expect((await pgError(s.query("select public.acknowledge_ai_notice(1)"))).code).toBe("42501");
      await s.as(null);
      expect((await pgError(s.query("select public.acknowledge_ai_notice(1)"))).code).toBe("42501");
    });
  });
});
