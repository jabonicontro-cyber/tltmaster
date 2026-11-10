// Money access always needs two-step verification (20261120018000, owner decision 2026-11-09, master plan §12 SEC4):
// anyone holding a money permission in a real company gets no company below aal2, whatever the company setting;
// memberships of demo companies never count; and QuickBooks (20261120018100) cannot be connected, changed or
// disconnected during a Taviron support visit, cannot be repointed without signing in to Intuit, and is in the history.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { MONEY_MFA_REASON, MONEY_PERMISSIONS } from "@/lib/mfa-policy";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Policy = { platform: boolean; money: boolean; current_company: boolean; reason: string | null };

async function asAal(s: Session, userId: string, aal: "aal1" | "aal2") {
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal })]);
}

const policy = async (s: Session) => (await s.query<{ p: Policy }>("select public.mfa_policy() p")).rows[0].p;
const company = async (s: Session) => (await s.query<{ a: { company_id: string | null } }>("select public.my_access() a")).rows[0].a.company_id;
const customers = async (s: Session) => (await s.query("select 1 from public.customers limit 1")).rowCount;

async function demoCompany(s: Session) {
  const id = await s.createCompany(`Money Demo ${randomUUID().slice(0, 6)}`);
  await s.asAdmin();
  await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [id]);
  await s.query("insert into public.customers (company_id, name) values ($1, 'Fictional Customer')", [id]);
  return id;
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

describe("money access needs two-step verification", () => {
  it("the database list matches the app's and names real permissions", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const db = (await s.query<{ p: string[] }>("select private.money_permissions() p")).rows[0].p;
      expect([...db].sort()).toEqual([...MONEY_PERMISSIONS].sort());
      const known = (await s.query<{ code: string }>("select code from public.permissions where code = any($1)", [db])).rows.map((r) => r.code);
      expect(known.sort()).toEqual([...db].sort());
      // Not callable by app users.
      await s.as(await s.createUser("owner"));
      expect((await pgError(s.query("select private.money_mfa_required()"))).code).toBe("42501");
    });
  });

  it("owners, office staff and accountants get no company below aal2; dispatchers, drivers and mechanics are unaffected", async () => {
    await withSession(async (s) => {
      for (const role of ["owner", "office"] as const) {
        const person = await s.createUser(role);
        await asAal(s, person, "aal1");
        expect(await policy(s), role).toMatchObject({ money: true, platform: false, reason: MONEY_MFA_REASON });
        expect(await company(s), role).toBeNull();
        expect(await customers(s), role).toBe(0);
        // Database functions refuse too, not just the pages.
        expect((await pgError(s.query("select public.accounting_save_connection(null, 'sandbox', 'x-aal1', 'x')"))).code, role).toBe("42501");
        await asAal(s, person, "aal2");
        expect(await company(s), role).toBe(TOP_LINE);
        expect(await customers(s), role).toBe(1);
      }
      // An outside accountant (accounting.view, billing.view).
      await s.asAdmin();
      const acct = await s.createUser(null, { membership: false });
      await s.query("insert into public.company_memberships (company_id, user_id, role, active, access_ends_at) values ($1, $2, 'accountant', true, now() + interval '7 days')", [TOP_LINE, acct]);
      await asAal(s, acct, "aal1");
      expect((await policy(s)).money).toBe(true);
      expect(await company(s)).toBeNull();
      // Once the access has ended it no longer counts.
      await s.asAdmin();
      await s.query("update public.company_memberships set access_ends_at = now() - interval '1 minute' where user_id = $1", [acct]);
      await asAal(s, acct, "aal1");
      expect((await policy(s)).money).toBe(false);

      for (const role of ["dispatcher", "driver", "mechanic"] as const) {
        const person = await s.createUser(role);
        await asAal(s, person, "aal1");
        expect(await policy(s), role).toMatchObject({ money: false, reason: null });
        expect(await company(s), role).toBe(TOP_LINE);
      }
    });
  });

  it("the company setting cannot turn it off, and a role given a money permission is covered", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`Money Policy ${randomUUID().slice(0, 6)} (test)`);
      const owner = await s.createUser("owner", { companyId: c });
      const dispatcher = await s.createUser("dispatcher", { companyId: c });
      await s.asAdmin();
      await s.query("update public.company_settings set require_mfa = false where company_id = $1", [c]);
      await asAal(s, owner, "aal1");
      expect(await policy(s)).toMatchObject({ money: true, current_company: false, reason: MONEY_MFA_REASON });
      expect(await company(s)).toBeNull();
      // With the company rule on, the money reason is still the one shown to the owner; the dispatcher gets the company's.
      await s.asAdmin();
      await s.query("update public.company_settings set require_mfa = true where company_id = $1", [c]);
      await asAal(s, owner, "aal1");
      expect((await policy(s)).reason).toBe(MONEY_MFA_REASON);
      await asAal(s, dispatcher, "aal1");
      expect(await policy(s)).toMatchObject({ money: false, current_company: true, reason: "Your company requires two-step verification." });
      // Back off, and the dispatcher's role is given billing.view: now always required.
      await s.asAdmin();
      await s.query("update public.company_settings set require_mfa = false where company_id = $1", [c]);
      await asAal(s, dispatcher, "aal1");
      expect(await company(s)).toBe(c);
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'dispatcher', 'billing.view')", [c]);
      await asAal(s, dispatcher, "aal1");
      expect((await policy(s)).money).toBe(true);
      expect(await company(s)).toBeNull();
      // An inactive membership or company does not count.
      await s.asAdmin();
      await s.query("update public.company_memberships set active = false where user_id = $1", [dispatcher]);
      await asAal(s, dispatcher, "aal1");
      expect((await policy(s)).money).toBe(false);
      await s.asAdmin();
      await s.query("update public.companies set active = false where id = $1", [c]);
      await asAal(s, owner, "aal1");
      expect((await policy(s)).money).toBe(false);
    });
  });

  it("demo companies: a demo-only owner is exempt; one who also has money access in a real company is not", async () => {
    await withSession(async (s) => {
      const demo = await demoCompany(s);
      const owner = await s.createUser("owner", { companyId: demo });
      await s.asAdmin();
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [demo, owner]);
      await asAal(s, owner, "aal1");
      expect(await policy(s)).toMatchObject({ money: false, reason: null });
      expect(await company(s)).toBe(demo);
      expect(await customers(s)).toBe(1);
      // Also office staff in a real company: required, in the demo company too.
      await s.asAdmin();
      await s.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'office', true)", [TOP_LINE, owner]);
      await asAal(s, owner, "aal1");
      expect((await policy(s)).money).toBe(true);
      expect(await company(s)).toBeNull();
      await asAal(s, owner, "aal2");
      expect(await company(s)).toBe(demo);
      // A driver in the real company (no money there) stays exempt.
      await s.asAdmin();
      await s.query("update public.company_memberships set role = 'driver' where company_id = $1 and user_id = $2", [TOP_LINE, owner]);
      await asAal(s, owner, "aal1");
      expect((await policy(s)).money).toBe(false);
      expect(await company(s)).toBe(demo);
    });
  });

  it("a history entry made below the second factor is kept with the person's company", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await asAal(s, owner, "aal1");
      expect(await company(s)).toBeNull();
      await s.asAdmin();
      await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner, role: "authenticated", aal: "aal1" })]);
      const id = randomUUID();
      await s.query("select private.log_event('test.below_aal2', 'user', $1, 'Test entry')", [id]);
      await s.client.query("select set_config('request.jwt.claims', '', true)");
      expect((await s.query<{ company_id: string }>("select company_id from public.audit_events where entity_id = $1", [id])).rows[0].company_id).toBe(TOP_LINE);
    });
  });
});

describe("recovery codes are required for money access (owner 2026-11-10)", () => {
  type Ready = { recovery_codes: number; recovery_ready: boolean };
  const ready = async (s: Session) => (await s.query<{ p: Ready }>("select public.mfa_policy() p")).rows[0].p;

  it("ready only with unused codes confirmed as saved after the newest set; confirming needs aal2 and codes", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await asAal(s, office, "aal2");
      expect(await ready(s)).toMatchObject({ recovery_codes: 0, recovery_ready: false });
      expect((await pgError(s.query("select public.mfa_recovery_confirm()"))).message).toBe("Create recovery codes first.");
      const codes = (await s.query<{ c: string[] }>("select public.mfa_recovery_generate() c")).rows[0].c;
      // Codes alone are not enough: the person has to confirm they saved them.
      expect(await ready(s)).toMatchObject({ recovery_codes: 10, recovery_ready: false });
      await asAal(s, office, "aal1");
      expect((await pgError(s.query("select public.mfa_recovery_confirm()"))).code).toBe("42501");
      await asAal(s, office, "aal2");
      await s.query("select public.mfa_recovery_confirm()");
      expect((await ready(s)).recovery_ready).toBe(true);
      // A new set (My profile, or after a lost phone) needs a new confirmation. (One transaction: the earlier
      // set and its confirmation are moved back in time so the new set is newer than them.)
      await s.asAdmin();
      await s.query("update private.mfa_recovery_codes set created_at = now() - interval '2 minutes' where user_id = $1", [office]);
      await s.query("update private.mfa_recovery_confirmations set confirmed_at = now() - interval '1 minute' where user_id = $1", [office]);
      await asAal(s, office, "aal2");
      expect((await ready(s)).recovery_ready).toBe(true);
      await s.query("select public.mfa_recovery_generate()");
      expect((await ready(s)).recovery_ready).toBe(false);
      await s.query("select public.mfa_recovery_confirm()");
      expect((await ready(s)).recovery_ready).toBe(true);
      // Every code used up: not ready until a new set is made and confirmed.
      await s.asAdmin();
      await s.query("update private.mfa_recovery_codes set used_at = now() where user_id = $1", [office]);
      await asAal(s, office, "aal2");
      expect(await ready(s)).toMatchObject({ recovery_codes: 0, recovery_ready: false });
      expect(codes).toHaveLength(10);
      // Recorded for the person.
      await s.asAdmin();
      expect((await s.query("select 1 from private.security_events where user_id = $1 and event = 'mfa.recovery_confirmed'", [office])).rowCount).toBe(2);
      // Only about the caller: no other person's confirmation is touched, and app users cannot read the table.
      await s.as(office);
      expect((await pgError(s.query("select * from private.mfa_recovery_confirmations"))).code).toBe("42501");
    });
  });
});

describe("support visits always need two-step verification in real companies (owner 2026-11-10)", () => {
  it("even with the emergency switch off, a visit below aal2 gives no real company; a demo is still lifted by the switch", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`Visit Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.asAdmin();
      await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [c]);
      const owner = await s.createUser("owner", { companyId: c });
      const demo = await demoCompany(s);
      const sup = await staff(s);
      await s.as(owner);
      await s.query("select public.support_access_grant(3)");
      await s.as(sup);
      await s.query("select public.platform_support_enter($1, '')", [c]);
      expect(await company(s)).toBe(c);
      // The database owner's emergency switch off: the platform console works below aal2, a real company does not.
      await s.asAdmin();
      await s.query("insert into private.platform_settings (key, value) values ('platform_mfa_enforced', 'false') on conflict (key) do update set value = excluded.value");
      await asAal(s, sup, "aal1");
      expect(await company(s)).toBeNull();
      expect(await customers(s)).toBe(0);
      await asAal(s, sup, "aal2");
      expect(await company(s)).toBe(c);
      // A demo company (fictional money): the switch still lets a visit in below aal2.
      await s.query("select public.platform_support_leave()");
      await s.query("select public.platform_support_enter($1, '')", [demo]);
      await asAal(s, sup, "aal1");
      expect(await company(s)).toBe(demo);
      // With the switch on, neither below aal2 (as before).
      await s.asAdmin();
      await s.query("update private.platform_settings set value = 'true' where key = 'platform_mfa_enforced'");
      await asAal(s, sup, "aal1");
      expect(await company(s)).toBeNull();
    });
  });
});

describe("QuickBooks and support visits (L3)", () => {
  it("a visit cannot connect, change or disconnect QuickBooks; owners can, and each step is in the history", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`QBO Visit ${randomUUID().slice(0, 6)} (test)`);
      await s.asAdmin();
      await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [c]);
      const owner = await s.createUser("owner", { companyId: c });
      await s.as(owner);
      const conn = (await s.query<{ id: string }>("select public.accounting_save_connection(null, 'sandbox', 'realm-1', '') id")).rows[0].id;
      await s.query("select public.accounting_save_connection(null, 'sandbox', 'realm-1', 'Haul Co Books')");
      await s.query("select public.accounting_set_item($1, '1', 'Services')", [conn]);

      const sup = await staff(s);
      await s.as(owner);
      await s.query("select public.support_access_grant(3)");
      await s.as(sup);
      await s.query("select public.platform_support_enter($1, '')", [c]);
      expect(await company(s)).toBe(c);
      const refused = async (sql: string, params: unknown[] = []) => {
        const e = await pgError(s.query(sql, params));
        expect(e.code).toBe("42501");
        expect(e.message).toBe("Taviron support cannot connect, change or disconnect QuickBooks. Ask an owner of the company.");
      };
      await refused("select public.accounting_save_connection(null, 'sandbox', 'realm-1', 'Renamed')");
      await refused("select public.accounting_set_item($1, '2', 'Other')", [conn]);
      await refused("select public.accounting_set_status($1, 'needs_reconnect')", [conn]);
      await refused("select public.accounting_disconnect($1)", [conn]);
      // Ordinary owner work in the visit still goes through.
      await s.query("insert into public.customers (company_id, name) values ($1, 'Visit Work Customer')", [c]);
      await s.query("select public.platform_support_leave()");

      // The owner disconnects: recorded.
      await s.as(owner);
      await s.query("select public.accounting_disconnect($1)", [conn]);
      await s.asAdmin();
      const history = (await s.query<{ action: string; summary: string; actor_id: string }>(
        "select action, summary, actor_id from public.audit_events where company_id = $1 and action like 'accounting.%'", [c])).rows;
      // (One transaction: the entries share a time, so they are compared without order.)
      expect(history.map((h) => h.action).sort()).toEqual(["accounting.connected", "accounting.disconnected", "accounting.named"]);
      expect(history.find((h) => h.action === "accounting.named")?.summary).toBe("QuickBooks company recorded: Haul Co Books");
      expect(history.find((h) => h.action === "accounting.disconnected")?.summary).toBe("QuickBooks disconnected: Haul Co Books");
      expect(new Set(history.map((h) => h.actor_id))).toEqual(new Set([owner]));
    });
  });

  it("a connected business cannot be pointed at another QuickBooks company; the same one connects again", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`QBO Realm ${randomUUID().slice(0, 6)} (test)`);
      const owner = await s.createUser("owner", { companyId: c });
      await s.as(owner);
      const conn = (await s.query<{ id: string }>("select public.accounting_save_connection(null, 'production', 'realm-a', 'Books A') id")).rows[0].id;
      await s.query("select public.accounting_set_item($1, '7', 'Hauling')", [conn]);
      await s.query("select public.accounting_set_status($1, 'needs_reconnect')", [conn]);
      for (const [env, realm] of [["production", "realm-b"], ["sandbox", "realm-a"]]) {
        const e = await pgError(s.query("select public.accounting_save_connection(null, $1, $2, 'Books B')", [env, realm]));
        expect(e.code).toBe("22023");
        expect(e.message).toMatch(/already connected to another QuickBooks company\. Disconnect it first/);
      }
      expect((await s.query("select realm_id, status, item_id from public.accounting_connections where id = $1", [conn])).rows[0])
        .toEqual({ realm_id: "realm-a", status: "needs_reconnect", item_id: "7" });
      // Connecting the same company again keeps the item choice and is recorded.
      expect((await s.query<{ id: string }>("select public.accounting_save_connection(null, 'production', 'realm-a', '') id")).rows[0].id).toBe(conn);
      expect((await s.query("select status, item_id from public.accounting_connections where id = $1", [conn])).rows[0]).toEqual({ status: "connected", item_id: "7" });
      await s.asAdmin();
      expect((await s.query<{ action: string }>("select action from public.audit_events where company_id = $1 and action like 'accounting.%'", [c])).rows.map((r) => r.action).sort())
        .toEqual(["accounting.connected", "accounting.reconnected"]);
    });
  });
});
