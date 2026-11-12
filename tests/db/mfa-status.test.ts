// Settings → Security: who has set up two-step verification (20261120019900, owner 2026-11-12, master plan §12 SEC4b).
// public.company_mfa_status() lists each active member of the caller's own company with whether they must use it for
// money access here, whether a verified second factor exists and, for money access only, whether their recovery codes
// are saved and confirmed. Only for users.manage; a Taviron support visit sees what the owner sees and no more; in a
// demo company money access never counts.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = { user_id: string; money: boolean; set_up: boolean; recovery_ready: boolean | null };
const status = async (s: Session) => (await s.query<Row>("select * from public.company_mfa_status()")).rows;
const byUser = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.user_id, r]));

async function verifiedFactor(s: Session, user: string) {
  await s.asAdmin();
  await s.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'app', 'totp', 'verified', now(), now())", [user]);
}

async function staff(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  await s.query("update private.platform_admins set level = 'support' where user_id = $1", [id]);
  return id;
}

describe("who has set up two-step verification", () => {
  it("lists the company's people with money access, set-up and recovery codes; only for users.manage", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`MFA Status ${randomUUID().slice(0, 6)} (test)`);
      const owner = await s.createUser("owner", { companyId: c });
      const office = await s.createUser("office", { companyId: c });
      const driver = await s.createUser("driver", { companyId: c });
      const gone = await s.createUser("dispatcher", { companyId: c, active: false });

      await s.as(owner);
      let rows = byUser(await status(s));
      // Active members only; the one who left is not listed.
      expect(Object.keys(rows).sort()).toEqual([owner, office, driver].sort());
      expect(rows[gone]).toBeUndefined();
      expect(rows[owner]).toEqual({ user_id: owner, money: true, set_up: false, recovery_ready: false });
      expect(rows[office]).toMatchObject({ money: true, set_up: false, recovery_ready: false });
      // No money access: not required, and nothing said about recovery codes.
      expect(rows[driver]).toEqual({ user_id: driver, money: false, set_up: false, recovery_ready: null });
      // Only these four columns: no factor ids, names, types, phone numbers or emails.
      const cols = (await s.query("select * from public.company_mfa_status() limit 1")).fields.map((f) => f.name);
      expect(cols).toEqual(["user_id", "money", "set_up", "recovery_ready"]);

      // A verified authenticator: set up. Recovery codes count only once saved and confirmed.
      await verifiedFactor(s, office);
      await verifiedFactor(s, driver);
      await s.as(office);
      await s.query("select public.mfa_recovery_generate()");
      await s.as(owner);
      rows = byUser(await status(s));
      expect(rows[office]).toMatchObject({ set_up: true, recovery_ready: false });
      expect(rows[driver]).toMatchObject({ money: false, set_up: true, recovery_ready: null });
      await s.as(office);
      await s.query("select public.mfa_recovery_confirm()");
      await s.as(owner);
      expect(byUser(await status(s))[office]).toMatchObject({ set_up: true, recovery_ready: true });
      // A factor not verified yet does not count.
      await s.asAdmin();
      await s.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'new', 'totp', 'unverified', now(), now())", [owner]);
      await s.as(owner);
      expect(byUser(await status(s))[owner].set_up).toBe(false);

      // A role given a money permission is covered; the company rule (require_mfa) is not this function's business.
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'driver', 'billing.view')", [c]);
      await s.as(owner);
      expect(byUser(await status(s))[driver]).toMatchObject({ money: true, recovery_ready: false });

      // Without users.manage: refused (the office role here has none by default; the driver neither).
      for (const who of [driver, office]) {
        await s.asAdmin();
        const has = (await s.query("select 1 from public.role_permissions rp join public.company_memberships m on m.role = rp.role and m.company_id = rp.company_id where m.user_id = $1 and rp.company_id = $2 and rp.permission = 'users.manage'", [who, c])).rowCount;
        if (has) continue;
        await s.as(who);
        expect((await pgError(status(s))).code).toBe("42501");
      }
      await s.asAdmin();
      await s.query("delete from public.role_permissions where company_id = $1 and role = 'owner' and permission = 'users.manage'", [c]);
      await s.as(owner);
      expect((await pgError(status(s))).code).toBe("42501");
      // Anonymous callers cannot run it at all.
      await s.as(null);
      expect((await pgError(status(s))).code).toBe("42501");
    });
  });

  it("only the caller's own company: never another company's people", async () => {
    await withSession(async (s) => {
      const a = await s.createCompany(`MFA A ${randomUUID().slice(0, 6)} (test)`);
      const b = await s.createCompany(`MFA B ${randomUUID().slice(0, 6)} (test)`);
      const ownerA = await s.createUser("owner", { companyId: a });
      const ownerB = await s.createUser("owner", { companyId: b });
      const officeB = await s.createUser("office", { companyId: b });
      await s.as(ownerA);
      const ids = (await status(s)).map((r) => r.user_id);
      expect(ids).toEqual([ownerA]);
      expect(ids).not.toContain(ownerB);
      expect(ids).not.toContain(officeB);
      // Below aal2 the owner (money access) has no company, so nothing is returned.
      await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ownerA, role: "authenticated", aal: "aal1" })]);
      expect((await pgError(status(s))).code).toBe("42501");
    });
  });

  it("a demo company: money access never counts, so nobody must use it for that reason", async () => {
    await withSession(async (s) => {
      const demo = await s.createCompany(`MFA Demo ${randomUUID().slice(0, 6)}`);
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      const owner = await s.createUser("owner", { companyId: demo });
      const office = await s.createUser("office", { companyId: demo });
      await s.as(owner);
      const rows = byUser(await status(s));
      expect(rows[owner]).toEqual({ user_id: owner, money: false, set_up: false, recovery_ready: null });
      expect(rows[office]).toMatchObject({ money: false, recovery_ready: null });
    });
  });

  it("a Taviron support visit sees what the owner sees and nothing more; without a visit staff see nothing", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`MFA Visit ${randomUUID().slice(0, 6)} (test)`);
      await s.asAdmin();
      await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [c]);
      const owner = await s.createUser("owner", { companyId: c });
      await s.createUser("office", { companyId: c });
      const sup = await staff(s);
      await verifiedFactor(s, sup);
      // No visit: staff are not members of any company.
      await s.as(sup);
      expect((await pgError(status(s))).code).toBe("42501");
      await s.as(owner);
      const ownerView = await status(s);
      await s.query("select public.support_access_grant(3)");
      await s.as(sup);
      await s.query("select public.platform_support_enter($1, '')", [c]);
      const visitView = await status(s);
      expect(visitView).toEqual(ownerView);
      // The visitor is not a member: never listed (their own two-step state stays private).
      expect(visitView.map((r) => r.user_id)).not.toContain(sup);
      // Once the visit ends, staff see nothing again.
      await s.query("select public.platform_support_leave()");
      expect((await pgError(status(s))).code).toBe("42501");
    });
  });
});
