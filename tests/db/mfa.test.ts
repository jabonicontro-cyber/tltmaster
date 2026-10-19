// Two-step verification (20261120000900): platform functions need an aal2 session; recovery codes are hashed, single
// use, replaced on regeneration and rate limited; the company policy needs settings.manage and an aal2 session.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function asAal(s: Session, userId: string, aal: "aal1" | "aal2") {
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal })]);
}

async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  return id;
}

describe("two-step verification", () => {
  it("platform functions refuse a session without a verified second factor", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await asAal(s, admin, "aal1");
      expect((await pgError(s.query("select public.platform_testing_checks()"))).code).toBe("42501");
      const policy = (await s.query<{ r: { platform: boolean; aal2: boolean } }>("select public.mfa_policy() r")).rows[0].r;
      expect(policy).toMatchObject({ platform: true, aal2: false });
      await asAal(s, admin, "aal2");
      await s.query("select public.platform_testing_checks()");
      // The database owner's emergency switch (SQL only) lifts the requirement.
      await s.asAdmin();
      await s.query("insert into private.platform_settings (key, value) values ('platform_mfa_enforced', 'false') on conflict (key) do update set value = excluded.value");
      await asAal(s, admin, "aal1");
      await s.query("select public.platform_testing_checks()");
    });
  });

  it("recovery codes: shown once, stored hashed, single use, replaced on regeneration, rate limited", async () => {
    await withSession(async (s) => {
      const user = await s.createUser("dispatcher");
      await asAal(s, user, "aal1");
      expect((await pgError(s.query("select public.mfa_recovery_generate()"))).code).toBe("42501");
      await asAal(s, user, "aal2");
      const codes = (await s.query<{ c: string[] }>("select public.mfa_recovery_generate() c")).rows[0].c;
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const c of codes) expect(c).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
      await s.asAdmin();
      const stored = (await s.query<{ code_hash: string }>("select code_hash from private.mfa_recovery_codes where user_id = $1", [user])).rows.map((r) => r.code_hash);
      expect(stored).toHaveLength(10);
      expect(stored).not.toContain(codes[0]);
      // Redeem at aal1 (signed in with the password only): once.
      await asAal(s, user, "aal1");
      expect((await s.query<{ ok: boolean }>("select public.mfa_recovery_redeem($1) ok", [codes[0].toUpperCase()])).rows[0].ok).toBe(true);
      expect((await s.query<{ ok: boolean }>("select public.mfa_recovery_redeem($1) ok", [codes[0]])).rows[0].ok).toBe(false);
      // Regenerating cancels the old codes.
      await asAal(s, user, "aal2");
      await s.query("select public.mfa_recovery_generate()");
      await asAal(s, user, "aal1");
      expect((await s.query<{ ok: boolean }>("select public.mfa_recovery_redeem($1) ok", [codes[1]])).rows[0].ok).toBe(false);
      // Five failures in 15 minutes lock recovery.
      for (let i = 0; i < 3; i++) await s.query("select public.mfa_recovery_redeem('00000-00000')");
      expect((await pgError(s.query("select public.mfa_recovery_redeem('00000-00000')"))).code).toBe("54000");
      // Events are recorded for the person; only known names are accepted.
      await s.asAdmin();
      const events = (await s.query<{ event: string }>("select event from private.security_events where user_id = $1", [user])).rows.map((r) => r.event);
      expect(events).toEqual(expect.arrayContaining(["mfa.recovery_generated", "mfa.recovery_used", "mfa.recovery_failed"]));
      await asAal(s, user, "aal1");
      expect((await pgError(s.query("select public.mfa_record_event('mfa.disabled_everything')"))).code).toBe("42501");
    });
  });

  it("company policy: settings.manage only, and only from a verified session", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`MFA Policy ${randomUUID().slice(0, 6)} (test)`);
      const owner = await s.createUser("owner", { companyId: c });
      const driver = await s.createUser("driver", { companyId: c });
      await asAal(s, driver, "aal2");
      expect((await pgError(s.query("select public.set_company_mfa_policy(true)"))).code).not.toBe("");
      await asAal(s, owner, "aal1");
      expect((await pgError(s.query("select public.set_company_mfa_policy(true)"))).code).toBe("42501");
      await asAal(s, owner, "aal2");
      await s.query("select public.set_company_mfa_policy(true)");
      await asAal(s, driver, "aal1");
      const policy = (await s.query<{ r: { current_company: boolean; companies: string[] } }>("select public.mfa_policy() r")).rows[0].r;
      expect(policy.current_company).toBe(true);
      expect(policy.companies).toHaveLength(1);
      // Other companies are unaffected.
      const other = await s.createUser("dispatcher", { companyId: TOP_LINE });
      await asAal(s, other, "aal1");
      expect((await s.query<{ r: { current_company: boolean } }>("select public.mfa_policy() r")).rows[0].r.current_company).toBe(false);
    });
  });
});
