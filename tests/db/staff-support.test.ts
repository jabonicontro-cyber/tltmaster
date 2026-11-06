// Taviron staff and support access (SA1, migration 20261120008900): two staff levels, invites that need a fresh
// password and code, customer grants of 1/3/7 days, and support visits that act with owner permissions without ever
// becoming a membership (not listed, not counted, ended with the grant, by the owner, or when staff are removed).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function staff(s: Session, level: "admin" | "support" = "admin") {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  await s.query("update private.platform_admins set level = $2 where user_id = $1", [id, level]);
  return id;
}

/** The person entered their password and authenticator code again just now. */
async function freshReauth(s: Session, user: string) {
  await s.asAdmin();
  const factor = randomUUID();
  await s.query("update auth.users set last_sign_in_at = now() where id = $1", [user]);
  await s.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, $3, 'totp', 'verified', now(), now())", [factor, user, `app ${factor.slice(0, 6)}`]);
  await s.query("insert into auth.mfa_challenges (id, factor_id, created_at, verified_at, ip_address) values (gen_random_uuid(), $1, now(), now(), '127.0.0.1')", [factor]);
}

/** A live customer company with an owner and a dispatcher. */
async function liveCompany(s: Session) {
  const company = await s.createCompany(`Support Haul ${randomUUID().slice(0, 6)} (test)`);
  await s.asAdmin();
  await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [company]);
  const owner = await s.createUser("owner", { companyId: company });
  const dispatcher = await s.createUser("dispatcher", { companyId: company });
  return { company, owner, dispatcher };
}

const current = async (s: Session) => (await s.query<{ a: { company_id: string | null } }>("select public.my_access() a")).rows[0].a.company_id;

describe("staff levels", () => {
  it("support staff reach the support desk but none of the admin console; both levels need two-step verification", async () => {
    await withSession(async (s) => {
      const sup = await staff(s, "support");
      const adm = await staff(s, "admin");
      await s.as(sup);
      expect((await s.query<{ l: string }>("select public.platform_staff_whoami() l")).rows[0].l).toBe("support");
      expect((await s.query<{ r: boolean }>("select public.platform_whoami() r")).rows[0].r).toBe(false);
      expect((await pgError(s.query("select * from public.platform_team()"))).code).toBe("42501");
      expect((await pgError(s.query("select * from public.platform_staff_list()"))).code).toBe("42501");
      await s.query("select * from public.platform_support_companies()");
      expect((await s.query<{ p: { platform: boolean } }>("select public.mfa_policy() p")).rows[0].p.platform).toBe(true);
      await s.as(adm);
      expect((await s.query<{ r: boolean }>("select public.platform_whoami() r")).rows[0].r).toBe(true);
      await s.query("select * from public.platform_support_companies()");
      // A company person is neither.
      const person = await s.createUser("owner");
      await s.as(person);
      expect((await s.query<{ l: string | null }>("select public.platform_staff_whoami() l")).rows[0].l).toBeNull();
      expect((await pgError(s.query("select * from public.platform_support_companies()"))).code).toBe("42501");
    });
  });
});

describe("support visits", () => {
  it("a live company needs its owner's grant; staff then act as an owner without being a member, and the owner ends it", async () => {
    await withSession(async (s) => {
      const { company, owner, dispatcher } = await liveCompany(s);
      const sup = await staff(s, "support");

      await s.as(sup);
      expect((await pgError(s.query("select public.platform_support_enter($1, 'Fix a rate')", [company]))).message).toMatch(/has not given Taviron support access/);

      // Only a real owner gives access; a dispatcher cannot.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.support_access_grant(3)"))).code).toBe("42501");
      await s.as(owner);
      expect((await pgError(s.query("select public.support_access_grant(2)"))).code).toBe("22023");
      const ends = (await s.query<{ e: Date }>("select public.support_access_grant(3) e")).rows[0].e;
      expect(ends.getTime() - Date.now()).toBeGreaterThan(71 * 3600_000);

      await s.as(sup);
      const visitEnd = (await s.query<{ e: Date }>("select public.platform_support_enter($1, 'Fix a rate') e", [company])).rows[0].e;
      expect(visitEnd.getTime()).toBe(ends.getTime());
      expect(await current(s)).toBe(company);
      expect((await s.query<{ a: { permissions: string[] } }>("select public.my_access() a")).rows[0].a.permissions.includes("settings.manage")).toBe(true);
      expect((await s.query("select id from public.companies where id = $1", [company])).rowCount).toBe(1);
      const me = (await s.query<{ a: { role: string; company_id: string; support: { ends_at: string } | null; permissions: string[] } }>("select public.my_access() a")).rows[0].a;
      expect(me).toMatchObject({ role: "owner", company_id: company });
      expect(me.support).not.toBeNull();
      expect(me.permissions).toContain("users.manage");
      // Staff can make changes (a customer), recorded under the company with the staff member as actor.
      await s.query("insert into public.customers (company_id, name) values ($1, 'Visit Test Customer')", [company]);
      // Never a member: not in memberships, the staff directory or owner counts.
      expect((await s.query("select 1 from public.company_memberships where user_id = $1", [sup])).rowCount).toBe(0);
      expect((await s.query<{ id: string }>("select id from public.user_directory()")).rows.map((r) => r.id)).not.toContain(sup);
      // Staff cannot grant or end access for the company themselves.
      expect((await pgError(s.query("select public.support_access_grant(7)"))).code).toBe("42501");
      expect((await pgError(s.query("select public.support_access_end()"))).code).toBe("42501");

      // The owner sees the visit (banner flag and status) and the history name.
      await s.as(owner);
      expect((await s.query<{ a: { support_inside: boolean } }>("select public.my_access() a")).rows[0].a.support_inside).toBe(true);
      const st = (await s.query<{ r: { needs_grant: boolean; grant: { days: number } | null; inside: Array<{ name: string }>; visits: Array<{ reason: string }> } }>("select public.support_access_status() r")).rows[0].r;
      expect(st).toMatchObject({ needs_grant: true, grant: { days: 3 } });
      expect(st.inside).toHaveLength(1);
      expect(st.visits[0].reason).toBe("Fix a rate");
      const names = (await s.query<{ user_id: string; name: string }>("select * from public.support_actor_names()")).rows;
      expect(names).toEqual([{ user_id: sup, name: "Test pending (Taviron support)" }]);
      const audit = (await s.query<{ action: string }>("select action from public.audit_events where company_id = $1 and action like 'support%' order by occurred_at", [company])).rows.map((r) => r.action);
      expect(audit).toEqual(expect.arrayContaining(["support_access.granted", "support.entered"]));
      // The dispatcher (not an owner) cannot read grants.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.support_access_status()"))).code).toBe("42501");
      expect((await s.query<{ a: { support_inside: boolean } }>("select public.my_access() a")).rows[0].a.support_inside).toBe(false);

      // The owner ends access: staff are out at once.
      await s.as(owner);
      await s.query("select public.support_access_end()");
      await s.as(sup);
      expect(await current(s)).toBeNull();
      expect((await s.query<{ a: { permissions: string[] } }>("select public.my_access() a")).rows[0].a.permissions.includes("settings.manage")).toBe(false);
      expect((await s.query("select id from public.companies where id = $1", [company])).rowCount).toBe(0);
    });
  });

  it("an expired grant ends the visit; a new grant extends visits under the old one", async () => {
    await withSession(async (s) => {
      const { company, owner } = await liveCompany(s);
      const sup = await staff(s, "support");
      await s.as(owner);
      await s.query("select public.support_access_grant(1)");
      await s.as(sup);
      await s.query("select public.platform_support_enter($1, '')", [company]);
      await s.as(owner);
      const longer = (await s.query<{ e: Date }>("select public.support_access_grant(7) e")).rows[0].e;
      await s.as(sup);
      expect(await current(s)).toBe(company);
      expect(new Date((await s.query<{ a: { support: { ends_at: string } } }>("select public.my_access() a")).rows[0].a.support.ends_at).getTime()).toBe(longer.getTime());
      await s.asAdmin();
      await s.query("update public.support_access_grants set starts_at = now() - interval '8 days', ends_at = now() - interval '1 minute' where company_id = $1 and ended_at is null", [company]);
      await s.as(sup);
      expect(await current(s)).toBeNull();
    });
  });

  it("onboarding and demo companies need no grant (8 hours); going live ends a visit made without one", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany(`Onboard Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.asAdmin();
      await s.query("insert into private.company_lifecycle (company_id, stage) values ($1, 'onboarding')", [company]);
      await s.createUser("owner", { companyId: company });
      const sup = await staff(s, "support");
      await s.as(sup);
      const list = (await s.query<{ id: string; needs_grant: boolean; can_enter: boolean }>("select * from public.platform_support_companies()")).rows.find((r) => r.id === company)!;
      expect(list).toMatchObject({ needs_grant: false, can_enter: true });
      const end = (await s.query<{ e: Date }>("select public.platform_support_enter($1, 'Import trucks') e", [company])).rows[0].e;
      expect(Math.round((end.getTime() - Date.now()) / 3600_000)).toBe(8);
      expect(await current(s)).toBe(company);
      await s.asAdmin();
      await s.query("update private.company_lifecycle set stage = 'live', live_at = now() where company_id = $1", [company]);
      await s.as(sup);
      expect(await current(s)).toBeNull();

      // A company the console just created (no lifecycle, no owner yet) is still being set up.
      const fresh = await s.createCompany(`Fresh Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.as(sup);
      await s.query("select public.platform_support_enter($1, '')", [fresh]);
      expect(await current(s)).toBe(fresh);
      // Leaving ends it; entering another company ends the previous visit.
      await s.query("select public.platform_support_leave()");
      expect(await current(s)).toBeNull();
    });
  });

  it("visits need two-step verification and end when the staff member is removed", async () => {
    await withSession(async (s) => {
      const { company, owner } = await liveCompany(s);
      const sup = await staff(s, "support");
      const adm = await staff(s, "admin");
      await s.as(owner);
      await s.query("select public.support_access_grant(3)");
      await s.as(sup);
      await s.query("select public.platform_support_enter($1, '')", [company]);
      // Same visit, a session below aal2: no company.
      await s.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: sup, role: "authenticated", aal: "aal1" })]);
      expect(await current(s)).toBeNull();
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_staff_remove($1, '')", [adm]))).message).toMatch(/cannot remove yourself/);
      await s.query("select public.platform_staff_remove($1, 'Left Taviron')", [sup]);
      await s.as(sup);
      expect(await current(s)).toBeNull();
      expect((await s.query<{ l: string | null }>("select public.platform_staff_whoami() l")).rows[0].l).toBeNull();
    });
  });
});

describe("a visit cannot outlast itself (security review 2026-11-06)", () => {
  it("H1: during a visit, people, roles, permissions, sign-ins and the two-step rule cannot be changed; nothing remains after", async () => {
    await withSession(async (s) => {
      const { company, owner, dispatcher } = await liveCompany(s);
      const sup = await staff(s, "support");
      const supEmail = (await s.query<{ email: string }>("select email from auth.users where id = $1", [sup])).rows[0].email;
      await s.as(owner);
      await s.query("select public.support_access_grant(3)");
      await s.as(sup);
      await s.query("select public.platform_support_enter($1, '')", [company]);
      const refused = async (sql: string, params: unknown[] = []) => expect((await pgError(s.query(sql, params))).code).toBe("42501");
      await refused("select public.add_existing_member($1, 'owner', 'Sneaky')", [supEmail]);
      await refused("select public.set_user_access($1, 'owner', true, 'Dana Dispatch')", [dispatcher]);
      await refused("update public.company_memberships set role = 'owner' where user_id = $1", [dispatcher]);
      await refused("update public.role_permissions set role = role where company_id = $1", [company]);
      await refused("select public.set_company_mfa_policy(false)");
      // Ordinary owner work still goes through.
      await s.query("insert into public.customers (company_id, name) values ($1, 'Visit Work Customer')", [company]);
      await s.query("select public.platform_support_leave()");
      await s.asAdmin();
      expect((await s.query("select 1 from public.company_memberships where user_id = $1", [sup])).rowCount).toBe(0);
      expect((await s.query<{ active: boolean; role: string }>("select active, role::text from public.company_memberships where user_id = $1", [owner])).rows[0]).toEqual({ active: true, role: "owner" });
    });
  });

  it("M2: a company in use keeps needing a grant when a subscription record is made for it later", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany(`In Use Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.createUser("owner", { companyId: company });
      const sup = await staff(s, "support");
      await s.asAdmin();
      // The record is made after the owner joined (here: a minute later), at the default stage fee_due.
      await s.query("insert into private.company_lifecycle (company_id, created_at) values ($1, now() + interval '1 minute')", [company]);
      await s.as(sup);
      expect((await pgError(s.query("select public.platform_support_enter($1, '')", [company]))).message).toMatch(/has not given Taviron support access/);
    });
  });
});

describe("staff invites", () => {
  it("an admin with a fresh password and code invites; the invitee accepts once, signed in as that email with an authenticator app", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      const sup = await staff(s, "support");
      const email = `new-${randomUUID().slice(0, 8)}@test.example`;

      await s.as(sup);
      expect((await pgError(s.query("select public.platform_staff_invite($1, 'Sam Rivera', 'support')", [email]))).code).toBe("42501");
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_staff_invite($1, 'Sam Rivera', 'support')", [email]))).message).toMatch(/password and authenticator code again/);
      await freshReauth(s, adm);
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_staff_invite('not-an-email', 'Sam Rivera', 'support')"))).code).toBe("22023");
      const inv = (await s.query<{ r: { token: string; id: string } }>("select public.platform_staff_invite($1, 'Sam Rivera', 'support') r", [email])).rows[0].r;
      expect(inv.token).toMatch(/^[0-9a-f]{64}$/);
      // Only the hash is stored.
      await s.asAdmin();
      expect((await s.query("select 1 from private.platform_staff_invites where token_hash = $1", [inv.token])).rowCount).toBe(0);

      // The link holder (signed out) sees who it is for.
      await s.as(null);
      expect((await s.query<{ r: { status: string; has_account: boolean; level: string } }>("select public.staff_invite_peek($1) r", [inv.token])).rows[0].r).toMatchObject({ status: "open", has_account: false, level: "support" });
      expect((await s.query<{ r: { status: string } }>("select public.staff_invite_peek('nope') r")).rows[0].r.status).toBe("invalid");

      // Someone else cannot accept it.
      const other = await s.createUser(null, { membership: false });
      await s.as(other);
      expect((await pgError(s.query("select public.platform_staff_accept($1)", [inv.token]))).message).toMatch(/This invitation is for/);

      // The invitee: account made, no authenticator yet, then with one.
      await s.asAdmin();
      const invitee = randomUUID();
      await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [invitee, email]);
      await s.as(invitee);
      expect((await pgError(s.query("select public.platform_staff_accept($1)", [inv.token]))).message).toMatch(/authenticator app/);
      await s.asAdmin();
      await s.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'app', 'totp', 'verified', now(), now())", [invitee]);
      await s.as(invitee);
      expect((await s.query<{ l: string }>("select public.platform_staff_accept($1) l", [inv.token])).rows[0].l).toBe("support");
      expect((await s.query<{ l: string }>("select public.platform_staff_whoami() l")).rows[0].l).toBe("support");
      expect((await s.query<{ n: string }>("select full_name n from public.profiles where id = $1", [invitee])).rows[0].n).toBe("Sam Rivera");
      expect((await pgError(s.query("select public.platform_staff_accept($1)", [inv.token]))).code).toBe("P0002");
      await s.as(null);
      expect((await s.query<{ r: { status: string } }>("select public.staff_invite_peek($1) r", [inv.token])).rows[0].r.status).toBe("used");

      // Admins see the team and the audit trail; inviting someone already on the team is refused.
      await s.as(adm);
      expect((await s.query<{ user_id: string; level: string }>("select * from public.platform_staff_list()")).rows).toEqual(expect.arrayContaining([expect.objectContaining({ user_id: invitee, level: "support" })]));
      expect((await pgError(s.query("select public.platform_staff_invite($1, 'Sam Rivera', 'admin')", [email]))).message).toMatch(/already on the Taviron team/);
      await s.asAdmin();
      const log = (await s.query<{ action: string }>("select action from private.platform_audit where target_id in ($1, $2)", [inv.id, invitee])).rows.map((r) => r.action);
      expect(log).toEqual(expect.arrayContaining(["staff_invited", "staff_joined"]));
    });
  });

  it("raising to Admin needs a fresh sign-in; the team always keeps an Admin; a new invite replaces the open one", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      const sup = await staff(s, "support");
      await s.asAdmin();
      await s.query("update private.platform_admins set revoked_at = now() where level = 'admin' and user_id <> $1", [adm]);
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_staff_set_level($1, 'admin')", [sup]))).code).toBe("42501");
      expect((await pgError(s.query("select public.platform_staff_set_level($1, 'support')", [adm]))).message).toMatch(/at least one Admin/);
      await freshReauth(s, adm);
      await s.as(adm);
      await s.query("select public.platform_staff_set_level($1, 'admin')", [sup]);
      await s.query("select public.platform_staff_set_level($1, 'support')", [adm]);
      await s.as(sup);
      expect((await s.query<{ l: string }>("select public.platform_staff_whoami() l")).rows[0].l).toBe("admin");

      await freshReauth(s, sup);
      await s.as(sup);
      const email = `twice-${randomUUID().slice(0, 8)}@test.example`;
      const first = (await s.query<{ r: { token: string; id: string } }>("select public.platform_staff_invite($1, 'Pat Lee', 'support') r", [email])).rows[0].r;
      const second = (await s.query<{ r: { token: string; id: string } }>("select public.platform_staff_invite($1, 'Pat Lee', 'support') r", [email])).rows[0].r;
      await s.as(null);
      expect((await s.query<{ r: { status: string } }>("select public.staff_invite_peek($1) r", [first.token])).rows[0].r.status).toBe("withdrawn");
      await s.as(sup);
      await s.query("select public.platform_staff_invite_revoke($1)", [second.id]);
      expect((await pgError(s.query("select public.platform_staff_invite_revoke($1)", [second.id]))).code).toBe("P0002");
      const rows = (await s.query<{ status: string }>("select status from public.platform_staff_invites() where email = $1", [email])).rows;
      expect(rows.map((r) => r.status)).toEqual(["withdrawn", "withdrawn"]);
    });
  });
});
