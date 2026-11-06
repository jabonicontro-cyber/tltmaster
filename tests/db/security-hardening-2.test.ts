// Security review 2026-11-06 (SEC2, migration 20261120009000): credit fields need billing.manage however they are
// written; accountant access cannot pull in or rename someone from another company; an unblock only lifts a block this
// company set; failed sign-ins are counted per login and refused after 8 in 15 minutes (server only).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, withSession, TOP_LINE } from "./helpers";

afterAll(() => pool.end());

describe("security hardening 2", () => {
  it("L1: credit hold and limit change only with billing.manage, even through a direct update", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.asAdmin();
      // A custom role setup: customers.edit without billing.manage.
      await s.query("delete from public.role_permissions where company_id = $1 and role = 'office' and permission = 'billing.manage'", [TOP_LINE]);
      await s.as(office);
      expect((await pgError(s.query("update public.customers set credit_hold = true where id = $1", [ids.customerId]))).code).toBe("42501");
      expect((await pgError(s.query("update public.customers set credit_limit_cents = 1 where id = $1", [ids.customerId]))).code).toBe("42501");
      // Other customer fields still save.
      const r = await s.query("update public.customers set notes = 'Gate code 4411' where id = $1", [ids.customerId]);
      expect(r.rowCount).toBe(1);
    });
  });

  it("M1: accountant access only for a sign-in this company made, and never renames someone from another company", async () => {
    await withSession(async (s) => {
      const other = await s.createCompany(`Other Haul ${randomUUID().slice(0, 6)} (test)`);
      const victim = await s.createUser("owner", { companyId: other });
      const owner = await s.createUser("owner");
      await s.as(owner);
      const tomorrow = new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10);
      expect((await pgError(s.query("select public.accountant_grant($1, 'Renamed', $2, false)", [victim, tomorrow]))).code).toBe("P0002");
      await s.asAdmin();
      expect((await s.query<{ n: string }>("select full_name n from public.profiles where id = $1", [victim])).rows[0].n).toBe("Test owner");
      expect((await s.query("select 1 from public.company_memberships where user_id = $1 and company_id = $2", [victim, TOP_LINE])).rowCount).toBe(0);
      // A sign-in this company provisioned works, and is named.
      const acct = await s.createUser(null, { membership: false });
      await s.query("insert into private.account_provisions (request_key, company_id, kind, username, user_id) values (gen_random_uuid(), $1, 'employee', $2, $3)", [TOP_LINE, `acct-${randomUUID().slice(0, 8)}`, acct]);
      await s.as(owner);
      await s.query("select public.accountant_grant($1, 'Avery Accountant', $2, false)", [acct, tomorrow]);
      await s.asAdmin();
      expect((await s.query<{ n: string }>("select full_name n from public.profiles where id = $1", [acct])).rows[0].n).toBe("Avery Accountant");
    });
  });

  it("L3: an unblock is allowed only after this company's own block", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const person = await s.createUser("driver");
      await s.as(owner);
      const allowed = async () => (await s.query<{ ok: boolean }>("select public.account_unblock_allowed($1, 'employee') ok", [person])).rows[0].ok;
      expect(await allowed()).toBe(false);
      await s.query("select public.account_access_record($1, 'employee', 'sessions_blocked')", [person]);
      expect(await allowed()).toBe(true);
      await s.query("select public.account_access_record($1, 'employee', 'sessions_unblocked')", [person]);
      expect(await allowed()).toBe(false);
    });
  });

  it("M3: failed sign-ins are counted per login hash, refused after 8 in 15 minutes, and only the server can do either", async () => {
    await withSession(async (s) => {
      const hash = "a".repeat(63) + "b";
      const person = await s.createUser("owner");
      await s.as(person);
      expect((await pgError(s.query("select public.signin_allowed($1)", [hash]))).code).toBe("42501");
      await s.as(null);
      expect((await pgError(s.query("select public.signin_failed($1)", [hash]))).code).toBe("42501");
      await s.asAdmin();
      await s.query("set local role service_role");
      const allowed = async () => (await s.query<{ ok: boolean }>("select public.signin_allowed($1) ok", [hash])).rows[0].ok;
      for (let i = 0; i < 7; i++) await s.query("select public.signin_failed($1)", [hash]);
      expect(await allowed()).toBe(true);
      await s.query("select public.signin_failed($1)", [hash]);
      expect(await allowed()).toBe(false);
      // Not a hash: ignored.
      await s.query("select public.signin_failed('not-a-hash')");
      await s.asAdmin();
      expect((await s.query("select 1 from private.signin_failures where login_hash = 'not-a-hash'")).rowCount).toBe(0);
      await s.query("update private.signin_failures set at = now() - interval '16 minutes' where login_hash = $1", [hash]);
      await s.query("set local role service_role");
      expect(await allowed()).toBe(true);
    });
  });
});
