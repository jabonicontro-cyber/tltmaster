// Company classification, archive and safe deletion (20261120000500). Nothing is classified automatically; only an
// archived practice company can be deleted, with its exact name; the deletion leaves no rows behind, is recorded in
// the platform audit first, and reports as done when repeated. Practice and archived companies leave the KPIs.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  return id;
}

describe("company classification and practice-company deletion", () => {
  it("only the platform team; new companies are production; demos cannot be classified or deleted", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`Class Test ${randomUUID().slice(0, 6)} (test)`);
      await s.asAdmin();
      expect((await s.query("select classification from public.companies where id = $1", [c])).rows[0].classification).toBe("production");
      const owner = await s.createUser("owner", { companyId: c });
      await s.as(owner);
      expect((await pgError(s.query("select public.platform_company_classify($1, 'practice')", [c]))).code).toBe("42501");
      expect((await pgError(s.query("select public.platform_company_archive($1, 'x')", [c]))).code).toBe("42501");
      const admin = await platformAdmin(s);
      await s.asAdmin();
      const demo = await s.createCompany(`Class Demo ${randomUUID().slice(0, 6)} (test)`);
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      await s.as(admin);
      expect((await pgError(s.query("select public.platform_company_classify($1, 'practice')", [demo]))).code).toBe("22023");
      // A production company, even archived, cannot be deleted.
      await s.query("select public.platform_company_archive($1, 'Testing archive')", [c]);
      expect((await pgError(s.query("select public.platform_company_delete($1, (select name from public.companies where id = $1))", [c]))).code).toBe("42501");
      // Archive is reversible and restores the previous state.
      await s.query("select public.platform_company_restore($1)", [c]);
      await s.asAdmin();
      expect((await s.query("select active, archived_at from public.companies where id = $1", [c])).rows[0]).toEqual({ active: true, archived_at: null });
    });
  });

  it("an archived practice company is deleted completely, recorded first, and a repeat reports it as done", async () => {
    await withSession(async (s) => {
      const name = `Practice Haul ${randomUUID().slice(0, 6)} (test)`;
      const c = await s.createCompany(name);
      const owner = await s.createUser("owner", { companyId: c });
      await s.as(owner);
      const cust = (await s.query<{ id: string }>("insert into public.customers (name) values ('Practice Customer') returning id")).rows[0].id;
      await s.query("insert into public.trucks (unit_number, truck_type) values ('P-1', 'tri_axle_dump')");
      await s.query("insert into public.customer_activities (customer_id, kind, subject) values ($1, 'call', 'Append-only record')", [cust]);
      const admin = await platformAdmin(s);
      await s.as(admin);
      // Before classification the preview explains why it cannot be deleted.
      const early = (await s.query<{ r: { eligible: boolean; blockers: string[] } }>("select public.platform_company_delete_preview($1) r", [c])).rows[0].r;
      expect(early.eligible).toBe(false);
      expect(early.blockers).toEqual(["It is not classified as Practice / test.", "Archive it first."]);
      await s.query("select public.platform_company_classify($1, 'practice')", [c]);
      // Not archived yet: refused.
      expect((await pgError(s.query("select public.platform_company_delete($1, $2)", [c, name]))).code).toBe("42501");
      await s.query("select public.platform_company_archive($1, 'Onboarding practice')", [c]);
      const preview = (await s.query<{ r: { eligible: boolean; counts: Record<string, number> } }>("select public.platform_company_delete_preview($1) r", [c])).rows[0].r;
      expect(preview.eligible).toBe(true);
      expect((preview as unknown as { delete_enabled: boolean }).delete_enabled).toBe(false);
      expect(preview.counts.customers).toBe(1);
      expect(preview.counts.trucks).toBe(1);
      // Permanent delete stays off until the platform owner turns it on with SQL.
      expect((await pgError(s.query("select public.platform_company_delete($1, $2)", [c, name]))).code).toBe("42501");
      await s.asAdmin();
      await s.query("insert into private.platform_settings (key, value) values ('company_delete_enabled', 'true') on conflict (key) do update set value = 'true'");
      await s.as(admin);
      expect((await pgError(s.query("select public.platform_company_delete($1, 'wrong name')", [c]))).code).toBe("22023");
      const r = (await s.query<{ r: { deleted: boolean } }>("select public.platform_company_delete($1, $2) r", [c, name])).rows[0].r;
      expect(r.deleted).toBe(true);
      await s.asAdmin();
      expect((await s.query("select 1 from public.companies where id = $1", [c])).rowCount).toBe(0);
      for (const t of ["customers", "trucks", "customer_activities", "company_memberships", "dispatch_bases", "audit_events"]) {
        expect((await s.query(`select count(*)::int n from public.${t} where company_id = $1`, [c])).rows[0].n, t).toBe(0);
      }
      expect((await s.query("select 1 from auth.users where id = $1", [owner])).rowCount).toBe(1); // sign-in kept
      expect((await s.query("select detail from private.platform_audit where action = 'company_deleted' and target_id = $1", [c])).rows[0].detail.counts.customers).toBe(1);
      await s.as(admin);
      expect((await s.query<{ r: unknown }>("select public.platform_company_delete($1, $2) r", [c, name])).rows[0].r).toEqual({ already_deleted: true });
    });
  });

  it("practice and archived companies leave the customer KPIs", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin);
      const before = (await s.query<{ r: { customers: { total: number } } }>("select public.platform_console() r")).rows[0].r.customers.total;
      await s.asAdmin();
      const c = await s.createCompany(`KPI Practice ${randomUUID().slice(0, 6)} (test)`);
      await s.as(admin);
      expect((await s.query<{ r: { customers: { total: number } } }>("select public.platform_console() r")).rows[0].r.customers.total).toBe(before + 1);
      await s.query("select public.platform_company_classify($1, 'practice')", [c]);
      expect((await s.query<{ r: { customers: { total: number } } }>("select public.platform_console() r")).rows[0].r.customers.total).toBe(before);
    });
  });
});
