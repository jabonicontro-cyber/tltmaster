// Workflow modules (MOD1, migration 20261120023000, docs/MODULES.md): per company, changed only by people who manage
// settings (and a Taviron Admin's starting preset before go-live), dependencies kept, every change recorded, nothing
// deleted, and SF1's menu carried over.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const off = async (s: Session, company: string) => {
  await s.asAdmin();
  return (await s.query<{ m: string[]; h: string[] }>("select modules_off m, hidden_areas h from public.company_settings where company_id = $1", [company])).rows[0];
};

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

describe("workflow modules", () => {
  it("keeps the same keys and presets as the app", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const keys = (await s.query<{ k: string[] }>("select private.module_keys() k")).rows[0].k;
      const { MODULE_KEYS, PRESETS } = await import("@/lib/modules");
      expect(keys).toEqual([...MODULE_KEYS]);
      for (const p of ["full", "tickets_to_billing", "quotes_only"] as const) {
        const db = (await s.query<{ k: string[] }>("select private.module_preset($1) k", [p])).rows[0].k;
        expect([...db].sort(), p).toEqual([...PRESETS[p].off].sort());
      }
    });
  });

  it("is changed by people who manage settings, for their own company only, and every change is recorded", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const other = await s.createCompany(`Modules Other ${randomUUID().slice(0, 6)} (test)`);
      await s.as(owner);
      const r = await s.query<{ r: { modules_off: string[] } }>("select public.set_company_modules(array['quotes', 'dispatch']) r");
      expect(r.rows[0].r.modules_off).toEqual(["dispatch", "quotes"]);
      expect((await off(s, TOP_LINE)).m).toEqual(["dispatch", "quotes"]);
      // The SF1 menu column follows (the previous app version reads it).
      expect((await off(s, TOP_LINE)).h).toEqual(["/quotes"]);
      expect((await off(s, other)).m).toEqual([]);

      await s.asAdmin();
      const audit = await s.query<{ actor_id: string; summary: string; details: { switched_off: string[] } }>(
        "select actor_id, summary, details from public.audit_events where company_id = $1 and action = 'settings.modules_changed' order by occurred_at desc limit 1", [TOP_LINE]);
      expect(audit.rows[0].actor_id).toBe(owner);
      expect(audit.rows[0].summary).toContain("Dispatch");
      expect([...audit.rows[0].details.switched_off].sort()).toEqual(["dispatch", "quotes"]);

      // A dispatcher (no settings.manage) is refused, and the direct column is not writable.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.set_company_modules('{}')"))).code).toBe("42501");
      expect((await s.query("update public.company_settings set hidden_areas = '{}' where company_id = $1 returning 1", [TOP_LINE])).rowCount).toBe(0);
      await s.as(owner);
      expect((await pgError(s.query("update public.company_settings set modules_off = '{}' where company_id = $1", [TOP_LINE]))).code).toBe("42501");

      // Switching back on restores the list; nothing else changed.
      await s.query("select public.set_company_modules('{}')");
      expect((await off(s, TOP_LINE)).m).toEqual([]);
    });
  });

  it("refuses unknown modules, safety areas and broken dependencies", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.set_company_modules(array['safety'])"))).code).toBe("22023");
      expect((await pgError(s.query("select public.set_company_modules(array['communications'])"))).code).toBe("22023");
      const e1 = await pgError(s.query("select public.set_company_modules(array['orders'])"));
      expect(e1.message).toMatch(/Dispatch needs Orders and jobs/);
      const e2 = await pgError(s.query("select public.set_company_modules(array['tickets'])"));
      expect(e2.message).toMatch(/Billing needs Delivery tickets/);
      const e3 = await pgError(s.query("select public.set_company_modules(array['tickets', 'billing', 'order_to_cash'])"));
      expect(e3.message).toMatch(/Payroll needs Delivery tickets/);
      // Each preset is consistent.
      for (const p of ["tickets_to_billing", "quotes_only", "full"]) {
        await s.query("select public.set_company_modules(private.module_preset($1))", [p]);
      }
      expect((await off(s, TOP_LINE)).m).toEqual([]);
    });
  });

  it("carries a menu saved by the previous app version into the modules", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      await s.query("select public.set_company_modules(array['dispatch'])");
      await s.query("update public.company_settings set hidden_areas = array['/payroll', '/reports'] where company_id = $1", [TOP_LINE]);
      const r = await off(s, TOP_LINE);
      expect(r.m).toEqual(["dispatch", "payroll", "reports"]);
      expect(r.h).toEqual(["/payroll", "/reports"]);
    });
  });

  it("lets a Taviron Admin pick a starting preset only while a company is set up, or for a demo", async () => {
    await withSession(async (s) => {
      const admin = await staff(s, "admin");
      const support = await staff(s, "support");
      const fresh = await s.createCompany(`Modules New ${randomUUID().slice(0, 6)} (test)`);
      const older = await s.createCompany(`Modules Older ${randomUUID().slice(0, 6)} (test)`);
      await s.query("update public.companies set created_at = timestamptz '2026-10-01 12:00:00+00' where id = $1", [older]);

      await s.as(support);
      expect((await pgError(s.query("select public.platform_set_company_modules($1, 'quotes_only')", [fresh]))).code).toBe("42501");

      await s.as(admin);
      await s.query("select public.platform_set_company_modules($1, 'tickets_to_billing')", [fresh]);
      expect([...(await off(s, fresh)).m].sort()).toEqual(["customer_portal", "dispatch", "order_to_cash", "payroll", "quotes", "schedule", "support", "time_off"]);
      await s.asAdmin();
      expect((await s.query("select 1 from private.platform_audit where action = 'company.modules_preset' and target_id = $1", [fresh])).rowCount).toBe(1);
      expect((await s.query("select 1 from public.audit_events where company_id = $1 and action = 'settings.modules_changed' and actor_id = $2", [fresh, admin])).rowCount).toBe(1);

      await s.as(admin);
      const state = (await s.query<{ r: { can_set: boolean } }>("select public.platform_company_modules($1) r", [older])).rows[0].r;
      expect(state.can_set).toBe(false);
      expect((await pgError(s.query("select public.platform_set_company_modules($1, 'quotes_only')", [older]))).message).toMatch(/live|owner chooses/);
      expect((await pgError(s.query("select public.platform_set_company_modules($1, 'everything')", [fresh]))).code).toBe("22023");
      // A demo (any age) can show a preset and go back to Full operations.
      const demo = await s.createCompany(`Modules Demo ${randomUUID().slice(0, 6)} (test)`);
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect', created_at = timestamptz '2026-10-01 12:00:00+00' where id = $1", [demo]);
      await s.as(admin);
      await s.query("select public.platform_set_company_modules($1, 'quotes_only')", [demo]);
      expect((await off(s, demo)).m).toContain("orders");
      await s.as(admin);
      await s.query("select public.platform_set_company_modules($1, 'full')", [demo]);
      expect((await off(s, demo)).m).toEqual([]);
      await s.as(admin);
      // Top Line (an existing customer) is never changed from the console.
      expect((await pgError(s.query("select public.platform_set_company_modules($1, 'quotes_only')", [TOP_LINE]))).code).toBe("42501");

      // A company person cannot use the console function.
      const owner = await s.createUser("owner", { companyId: fresh });
      await s.as(owner);
      expect((await pgError(s.query("select public.platform_set_company_modules($1, 'full')", [fresh]))).code).toBe("42501");
    });
  });
});
