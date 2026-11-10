// Driver sign-in without typing (DS1, migration 20261120017000): one-time QR codes are made only by people who manage
// sign-ins, only for this company's active driver username sign-ins, work once for 10 minutes, are redeemed only by the
// server (service role), are refused for every other kind of sign-in, in demo companies and during support visits, are
// rate limited, and every step is audited without the token or its hash. Passkey removal follows the same rules.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { isMoneyPermission, PERMISSIONS } from "../../src/lib/permissions";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const token = () => randomBytes(32).toString("base64url");
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** A driver's username sign-in in a company with its driver record (what the phone sign-in wizard makes). */
async function driverSignIn(s: Session, company = TOP_LINE, role = "driver", email?: string) {
  await s.asAdmin();
  const user = randomUUID();
  await s.query("insert into auth.users (id, email, aud, role, encrypted_password) values ($1, $2, 'authenticated', 'authenticated', 'pw-hash')",
    [user, email ?? `qr-${user.slice(0, 8)}@users.mytaviron.com`]);
  await s.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, $3, true)", [company, user, role]);
  const driver = (await s.query<{ id: string }>("insert into public.drivers (company_id, name, user_id) values ($1, 'Quinn Roadway (test)', $2) returning id", [company, user])).rows[0].id;
  return { user, driver };
}

async function issue(s: Session, staff: string, driver: string, t = token()) {
  await s.as(staff);
  const r = (await s.query<{ r: { id: string; expires_at: string } }>("select public.signin_qr_issue($1, $2) r", [driver, hash(t)])).rows[0].r;
  return { ...r, token: t };
}

async function redeem(s: Session, t: string) {
  await s.asAdmin();
  await s.query("set local role service_role");
  return (await s.query<{ r: { ok: boolean; reason?: string; user_id?: string; email?: string } }>("select public.signin_qr_redeem($1) r", [hash(t)])).rows[0].r;
}

async function events(s: Session, user: string) {
  await s.asAdmin();
  return (await s.query<{ action: string; details: string }>("select action, details::text from public.audit_events where entity_id = $1 order by occurred_at, action", [user])).rows;
}

describe("driver QR sign-in", () => {
  it("works once for the driver it was made for; reuse is refused; audit holds no token or hash", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const { user, driver } = await driverSignIn(s);
      const code = await issue(s, owner, driver);
      const minutes = (new Date(code.expires_at).getTime() - Date.now()) / 60000;
      expect(minutes).toBeGreaterThan(9);
      expect(minutes).toBeLessThanOrEqual(10.1);
      await s.asAdmin();
      const stored = (await s.query<{ token_hash: string; company_id: string; user_id: string }>("select token_hash, company_id, user_id from private.signin_qr_codes where id = $1", [code.id])).rows[0];
      expect(stored).toEqual({ token_hash: hash(code.token), company_id: TOP_LINE, user_id: user });

      const first = await redeem(s, code.token);
      expect(first).toMatchObject({ ok: true, user_id: user });
      expect(first.email).toMatch(/@users\.mytaviron\.com$/);
      expect(await redeem(s, code.token)).toEqual({ ok: false, reason: "used" });
      expect(await redeem(s, token())).toEqual({ ok: false, reason: "invalid" });

      await s.as(owner);
      expect((await s.query<{ s: string }>("select public.signin_qr_status($1) s", [code.id])).rows[0].s).toBe("used");
      const audit = await events(s, user);
      expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(["account.qr_issued", "account.qr_used", "account.qr_refused"]));
      for (const e of audit) {
        expect(e.details).not.toContain(code.token);
        expect(e.details).not.toContain(hash(code.token));
      }
      await s.asAdmin();
      const sec = (await s.query<{ n: number }>("select count(*)::int n from private.security_events where user_id = $1 and event like 'account.qr_%'", [user])).rows[0].n;
      expect(sec).toBeGreaterThanOrEqual(3);
    });
  });

  it("an expired code is refused and recorded; a new code replaces the earlier one; a cancelled code stops", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const { user, driver } = await driverSignIn(s);
      const old = await issue(s, owner, driver);
      await s.asAdmin();
      await s.query("update private.signin_qr_codes set expires_at = now() - interval '1 second' where id = $1", [old.id]);
      await s.as(owner);
      expect((await s.query<{ s: string }>("select public.signin_qr_status($1) s", [old.id])).rows[0].s).toBe("expired");
      expect(await redeem(s, old.token)).toEqual({ ok: false, reason: "expired" });
      expect((await events(s, user)).map((e) => e.action)).toContain("account.qr_expired");

      const a = await issue(s, owner, driver);
      const b = await issue(s, owner, driver);
      expect(await redeem(s, a.token)).toEqual({ ok: false, reason: "replaced" });
      await s.as(owner);
      await s.query("select public.signin_qr_cancel($1)", [b.id]);
      expect((await s.query<{ s: string }>("select public.signin_qr_status($1) s", [b.id])).rows[0].s).toBe("cancelled");
      expect(await redeem(s, b.token)).toEqual({ ok: false, reason: "replaced" });
    });
  });

  it("is checked again when used: a sign-in turned off or no longer a driver is refused", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const { user, driver } = await driverSignIn(s);
      const code = await issue(s, owner, driver);
      await s.asAdmin();
      await s.query("update public.company_memberships set active = false where user_id = $1", [user]);
      expect(await redeem(s, code.token)).toEqual({ ok: false, reason: "not_allowed" });
      expect((await events(s, user)).map((e) => e.action)).toContain("account.qr_refused");

      const other = await driverSignIn(s);
      const c2 = await issue(s, owner, other.driver);
      await s.asAdmin();
      await s.query("update auth.users set banned_until = now() + interval '100 years' where id = $1", [other.user]);
      expect(await redeem(s, c2.token)).toEqual({ ok: false, reason: "not_allowed" });
    });
  });

  it("only people who manage sign-ins in the same company can make one", async () => {
    await withSession(async (s) => {
      const { driver } = await driverSignIn(s);
      for (const role of ["dispatcher", "office", "mechanic", "driver"] as const) {
        const person = await s.createUser(role);
        await s.as(person);
        const has = (await s.query<{ h: boolean }>("select private.has_permission('users.manage') h")).rows[0].h;
        if (has) continue; // a company that gave this role users.manage may show codes
        expect((await pgError(s.query("select public.signin_qr_issue($1, $2)", [driver, hash(token())]))).code, role).toBe("42501");
      }
      // Another company's owner: the driver is not theirs.
      const other = await s.createCompany("Brookside Aggregates (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await pgError(s.query("select public.signin_qr_issue($1, $2)", [driver, hash(token())]))).code).toBe("P0002");
      // A code cannot be read, cancelled or checked from another company either.
      const owner = await s.createUser("owner");
      const code = await issue(s, owner, driver);
      await s.as(otherOwner);
      expect((await pgError(s.query("select public.signin_qr_status($1)", [code.id]))).code).toBe("P0002");
      await s.query("select public.signin_qr_cancel($1)", [code.id]);
      expect((await redeem(s, code.token)).ok).toBe(true);
    });
  });

  it("refuses owners, office staff, email sign-ins, people with other access, platform admins and oneself", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const refused = async (driver: string) => {
        await s.as(owner);
        return pgError(s.query("select public.signin_qr_issue($1, $2)", [driver, hash(token())]));
      };
      expect((await refused((await driverSignIn(s, TOP_LINE, "owner")).driver)).message).toMatch(/only for active driver/);
      expect((await refused((await driverSignIn(s, TOP_LINE, "office")).driver)).message).toMatch(/only for active driver/);
      const emailDriver = await driverSignIn(s, TOP_LINE, "driver", `own-${randomUUID().slice(0, 6)}@example.com`);
      expect((await refused(emailDriver.driver)).code).toBe("42501");
      const elsewhere = await driverSignIn(s);
      const other = await s.createCompany("Elsewhere Haul (test)");
      await s.asAdmin();
      await s.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'driver', true)", [other, elsewhere.user]);
      expect((await refused(elsewhere.driver)).message).toMatch(/used elsewhere/);
      const admin = await driverSignIn(s);
      await s.asAdmin();
      await s.query("insert into private.platform_admins (user_id, note) values ($1, 'test')", [admin.user]);
      expect((await refused(admin.driver)).code).toBe("42501");
      // A driver with no sign-in, and an inactive driver record.
      await s.asAdmin();
      const bare = (await s.query<{ id: string }>("insert into public.drivers (company_id, name) values ($1, 'No Login (test)') returning id", [TOP_LINE])).rows[0].id;
      expect((await refused(bare)).message).toMatch(/no sign-in yet/);
      // One's own driver record (a driver who also manages sign-ins).
      const self = await driverSignIn(s);
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'driver', 'users.manage') on conflict do nothing", [TOP_LINE]);
      await s.as(self.user);
      expect((await pgError(s.query("select public.signin_qr_issue($1, $2)", [self.driver, hash(token())]))).code).toBe("42501");
    });
  });

  it("never in a demo company, and never during a Taviron support visit", async () => {
    await withSession(async (s) => {
      const demo = await s.createCompany("Demo Haul (test)");
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      const demoOwner = await s.createUser("owner", { companyId: demo });
      const demoDriver = await driverSignIn(s, demo);
      await s.as(demoOwner);
      expect((await pgError(s.query("select public.signin_qr_issue($1, $2)", [demoDriver.driver, hash(token())]))).message).toMatch(/Demo companies never sign a phone in/);

      // A live company that granted Taviron support access; a support person visits.
      const company = await s.createCompany(`QR Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.asAdmin();
      await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [company]);
      const owner = await s.createUser("owner", { companyId: company });
      const { user, driver } = await driverSignIn(s, company);
      const sup = await s.createUser(null, { membership: false });
      await s.asAdmin();
      await s.query("insert into private.platform_admins (user_id, note, level) values ($1, 'test', 'support')", [sup]);
      await s.as(owner);
      await s.query("select public.support_access_grant(3)");
      await s.as(sup);
      await s.query("select public.platform_support_enter($1, '')", [company]);
      expect((await pgError(s.query("select public.signin_qr_issue($1, $2)", [driver, hash(token())]))).message).toMatch(/Taviron support cannot change who can sign in/);
      expect((await pgError(s.query("select public.signin_passkey_check($1)", [user]))).code).toBe("42501");
      expect((await pgError(s.query("select public.signin_passkeys_removed($1, 1)", [user]))).code).toBe("42501");
      // The table refuses a visit's writes whatever the path (trigger).
      await s.asAdmin();
      const code = await issue(s, owner, driver);
      await s.as(sup);
      await s.query("select public.signin_qr_cancel($1)", [code.id]).catch(() => undefined);
      await s.asAdmin();
      expect((await s.query<{ outcome: string }>("select outcome from private.signin_qr_codes where id = $1", [code.id])).rows[0].outcome).toBe("");
    });
  });

  it("is rate limited per driver", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const { driver } = await driverSignIn(s);
      for (let i = 0; i < 5; i++) await issue(s, owner, driver);
      await s.as(owner);
      expect((await pgError(s.query("select public.signin_qr_issue($1, $2)", [driver, hash(token())]))).message).toMatch(/Too many codes for this driver/);
    });
  });

  it("app users cannot redeem a code or read the codes table", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const { driver } = await driverSignIn(s);
      const code = await issue(s, owner, driver);
      for (const who of [owner, null]) {
        await s.as(who);
        expect((await pgError(s.query("select public.signin_qr_redeem($1)", [hash(code.token)]))).code).toBe("42501");
        expect((await pgError(s.query("select public.signin_qr_failed($1)", [code.id]))).code).toBe("42501");
        expect((await pgError(s.query("select * from private.signin_qr_codes"))).code).toBe("42501");
      }
      await s.as(null);
      expect((await pgError(s.query("select public.signin_qr_issue($1, $2)", [driver, hash(token())]))).code).toBe("42501");
      // The server records a session it could not make.
      expect((await redeem(s, code.token)).ok).toBe(true);
      await s.query("select public.signin_qr_failed($1)", [code.id]);
      await s.asAdmin();
      expect((await s.query<{ outcome: string }>("select outcome from private.signin_qr_codes where id = $1", [code.id])).rows[0].outcome).toBe("failed");
    });
  });
});

describe("face or fingerprint sign-in (passkeys): company checks and audit", () => {
  it("only people who manage sign-ins remove a driver's passkeys; removal and setup are audited", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const { user } = await driverSignIn(s);
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.signin_passkey_check($1)", [user]))).code).toBe("42501");
      await s.as(owner);
      await s.query("select public.signin_passkey_check($1)", [user]);
      await s.query("select public.signin_passkeys_removed($1, 2)", [user]);
      await s.as(user);
      await s.query("select public.my_passkey_added()");
      const audit = await events(s, user);
      expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(["account.passkeys_removed", "account.passkey_added"]));
      expect(audit.find((e) => e.action === "account.passkeys_removed")?.details).toContain('"count": 2');
      // Another company's owner cannot.
      const other = await s.createCompany("Passkey Elsewhere (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await pgError(s.query("select public.signin_passkey_check($1)", [user]))).code).toBe("P0002");
      await s.as(null);
      expect((await pgError(s.query("select public.my_passkey_added()"))).code).toBe("42501");
    });
  });
});

// SEC4 (owner 2026-11-09, migration 20261120017100): two-step verification will be required for anyone with money
// access, so QR codes and face or fingerprint sign-in are only for driver sign-ins that hold no money permission.
const MONEY_SAMPLES = ["billing.view", "billing.manage", "pricing.edit", "pricing.override", "payroll.manage", "employees.compensation", "accounting.view", "maintenance.costs", "audit.view", "settings.manage", "users.manage"];

describe("money permissions (SEC4): no QR code or face or fingerprint sign-in", () => {
  it("the database and the app agree on which permissions are about money", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const rows = (await s.query<{ p: string; m: boolean }>("select p, private.is_money_permission(p) m from unnest($1::text[]) p", [[...PERMISSIONS, "billing.future", "pricing.future"]])).rows;
      for (const r of rows) expect(r.m, r.p).toBe(isMoneyPermission(r.p));
      expect(rows.filter((r) => r.m).map((r) => r.p).sort()).toEqual([...MONEY_SAMPLES, "billing.future", "pricing.future"].sort());
    });
  });

  it("refuses to show a code for a driver whose role holds a money permission, and refuses a code used after one was given", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany(`Money Rule Haul ${randomUUID().slice(0, 6)} (test)`);
      const owner = await s.createUser("owner", { companyId: company });
      const { user, driver } = await driverSignIn(s, company);
      for (const permission of MONEY_SAMPLES) {
        await s.asAdmin();
        await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'driver', $2) on conflict do nothing", [company, permission]);
        await s.as(owner);
        const e = await pgError(s.query("select public.signin_qr_issue($1, $2)", [driver, hash(token())]));
        expect(e.code, permission).toBe("42501");
        expect(e.message, permission).toMatch(/can see or change money/);
        await s.asAdmin();
        await s.query("delete from public.role_permissions where company_id = $1 and role = 'driver' and permission = $2", [company, permission]);
      }
      // Without money permissions a code is shown; the owner then gives drivers billing.view; the code is refused when used.
      const code = await issue(s, owner, driver);
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'driver', 'billing.view') on conflict do nothing", [company]);
      expect(await redeem(s, code.token)).toEqual({ ok: false, reason: "not_allowed" });
      const refused = (await events(s, user)).filter((e) => e.action === "account.qr_refused");
      expect(refused.some((e) => e.details.includes('"reason": "money"'))).toBe(true);
      // A non-money permission added to drivers changes nothing.
      await s.asAdmin();
      await s.query("delete from public.role_permissions where company_id = $1 and role = 'driver' and permission = 'billing.view'", [company]);
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'driver', 'fleet.view') on conflict do nothing", [company]);
      const ok = await issue(s, owner, driver);
      expect((await redeem(s, ok.token)).ok).toBe(true);
    });
  });

  it("face or fingerprint is only for active driver sign-ins without money, never the Taviron team or a demo", async () => {
    await withSession(async (s) => {
      const refusal = async (who: string) => {
        await s.as(who);
        return (await s.query<{ r: string | null }>("select public.my_passkey_refusal() r")).rows[0].r;
      };
      const company = await s.createCompany(`Passkey Rule Haul ${randomUUID().slice(0, 6)} (test)`);
      const driver = await s.createUser("driver", { companyId: company });
      expect(await refusal(driver)).toBeNull();
      for (const role of ["owner", "office", "dispatcher", "mechanic"] as const) expect(await refusal(await s.createUser(role, { companyId: company })), role).toBe("not_driver");
      const off = await s.createUser("driver", { companyId: company, active: false });
      expect(await refusal(off)).toBe("not_driver");
      // A driver here who is an owner elsewhere.
      const both = await s.createUser("driver", { companyId: company });
      const other = await s.createCompany("Owner Elsewhere (test)");
      await s.asAdmin();
      await s.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [other, both]);
      expect(await refusal(both)).toBe("not_driver");
      // The Taviron team, Admin or Support level.
      for (const level of ["admin", "support"]) {
        const staff = await s.createUser("driver", { companyId: company });
        await s.asAdmin();
        await s.query("insert into private.platform_admins (user_id, note, level) values ($1, 'test', $2)", [staff, level]);
        expect(await refusal(staff), level).toBe("staff");
      }
      // Money permissions on the driver role.
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'driver', 'maintenance.costs') on conflict do nothing", [company]);
      expect(await refusal(driver)).toBe("money");
      // A demo company's driver.
      const demo = await s.createCompany("Passkey Demo (test)");
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      expect(await refusal(await s.createUser("driver", { companyId: demo }))).toBe("demo");
      // Signed out: no access at all.
      await s.as(null);
      expect((await pgError(s.query("select public.my_passkey_refusal()"))).code).toBe("42501");
    });
  });
});
