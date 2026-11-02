// Accountant view (B134, 20261120006300): only an owner gives an outside accountant time-limited, read-only access;
// the role cannot be widened; payroll only when the invite includes it; access ends by itself (or now); other
// companies see and change nothing.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

describe("accountant access", () => {
  it("an owner grants read-only, time-limited access; payroll only when included; ending it cuts everything", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const accountant = await s.createUser("driver", { membership: false });
      const grant = (endsOn: string, payroll = false) => s.query("select public.accountant_grant($1, 'Avery Ledger (test)', $2, $3)", [accountant, endsOn, payroll]);

      // Only an owner; a sensible end date; not someone already working in the company.
      await s.as(office);
      expect((await pgError(grant(addDays(today, 30)))).code).toBe("42501");
      await s.as(owner);
      expect((await pgError(grant(addDays(today, -1)))).message).toMatch(/end date/);
      expect((await pgError(grant(addDays(today, 500)))).message).toMatch(/end date/);
      expect((await pgError(s.query("select public.accountant_grant($1, 'x', $2, false)", [office, addDays(today, 30)]))).message).toMatch(/already works in the company/);
      await grant(addDays(today, 30));
      const list = (await s.query<{ r: Array<{ user_id: string; payroll: boolean; current: boolean }> }>("select public.accountant_list() r")).rows[0].r;
      expect(list).toEqual([expect.objectContaining({ user_id: accountant, payroll: false, current: true })]);

      // The accountant reads financials, changes nothing, and never gets more than the two read permissions.
      await s.as(accountant);
      expect((await s.query<{ c: string }>("select private.current_company_id() c")).rows[0].c).not.toBeNull();
      const me = (await s.query<{ r: { role: string; payroll: boolean } }>("select public.accountant_me() r")).rows[0].r;
      expect(me).toMatchObject({ role: "accountant", payroll: false });
      await s.query("select 1 from public.invoices limit 1");
      await s.query("select 1 from public.fuel_purchases limit 1");
      await s.query("select public.accountant_record_visit('overview')");
      for (const p of ["billing.manage", "dispatch.view", "customers.edit", "payroll.manage", "users.manage", "settings.manage"]) {
        expect((await s.query<{ ok: boolean }>("select private.has_permission($1) ok", [p])).rows[0].ok, p).toBe(false);
      }
      expect((await pgError(s.query("select public.payroll_period_create($1, $2)", [today, today]))).code).toBe("42501");
      expect((await pgError(s.query("select public.accountant_payroll_periods()"))).code).toBe("42501");
      expect((await pgError(s.query("select public.accountant_grant($1, 'x', $2, true)", [accountant, addDays(today, 30)]))).code).toBe("42501");

      // The role cannot be widened through the permission editor or directly.
      await s.as(owner);
      expect((await pgError(s.query("select public.set_role_permission('accountant', 'dispatch.view', true)"))).code).toBe("42501");
      await s.asAdmin();
      expect((await pgError(s.query("insert into public.role_permissions (company_id, role, permission) select company_id, 'accountant', 'billing.manage' from public.company_memberships where user_id = $1", [accountant]))).code).toBe("42501");

      // Payroll when the owner includes it: approved periods only.
      await s.as(owner);
      await s.query("select public.accountant_set_access($1, $2, true, false)", [accountant, addDays(today, 60)]);
      await s.as(accountant);
      expect(Array.isArray((await s.query<{ r: unknown[] }>("select public.accountant_payroll_periods() r")).rows[0].r)).toBe(true);

      // Ending it now: no company, nothing readable, nothing callable.
      await s.as(owner);
      await s.query("select public.accountant_set_access($1, null, false, true)", [accountant]);
      expect((await s.query<{ r: Array<{ current: boolean }> }>("select public.accountant_list() r")).rows[0].r[0].current).toBe(false);
      await s.as(accountant);
      expect((await s.query<{ c: string | null }>("select private.current_company_id() c")).rows[0].c).toBeNull();
      expect((await s.query("select 1 from public.invoices")).rowCount).toBe(0);
      expect((await pgError(s.query("select public.accountant_payroll_periods()"))).code).not.toBeUndefined();

      // Every grant, change and visit is in the audit log.
      await s.asAdmin();
      const actions = (await s.query<{ action: string }>("select action from public.audit_events where entity_id = $1 and action like 'accountant.%' order by occurred_at", [accountant])).rows.map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(["accountant.granted", "accountant.visited", "accountant.changed", "accountant.ended"]));

      // Another company's owner cannot see or change this accountant.
      const co = await s.createCompany(`Acct Other ${randomUUID().slice(0, 6)} (test)`);
      const outsider = await s.createUser("owner", { companyId: co });
      await s.as(outsider);
      expect((await s.query<{ r: unknown[] }>("select public.accountant_list() r")).rows[0].r).toEqual([]);
      expect((await pgError(s.query("select public.accountant_set_access($1, $2, false, false)", [accountant, addDays(today, 10)]))).code).toBe("P0002");
    });
  });

  it("an accountant membership always has an end date", async () => {
    await withSession(async (s) => {
      const u = await s.createUser("driver", { membership: false });
      await s.asAdmin();
      expect((await pgError(s.query("insert into public.company_memberships (company_id, user_id, role) select company_id, $1, 'accountant' from public.company_memberships limit 1", [u]))).code).toBe("23514");
    });
  });
});
