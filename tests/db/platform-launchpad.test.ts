// Platform owner Launchpad (20261118000100): one live read for the platform team, a company directory detail without
// business records, audited demo refreshes, and no duplicate company per lead or name. Platform admins only.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const service = (s: Session) => s.query("set local role service_role");
async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await service(s);
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  return id;
}
const submit = async (s: Session, email: string) => {
  await service(s);
  const r = (await s.query<{ r: { lead_id: string } }>("select public.lead_submit($1::jsonb, $2) as r", [
    JSON.stringify({ kind: "demo", name: "Pat Example", email, company_name: "Launch Hauling (test)", truck_count: "12", base_count: "1" }), `ip-${randomUUID()}`,
  ])).rows[0].r;
  await s.asAdmin();
  return r.lead_id;
};
type Pad = {
  companies: { total: number; setup_incomplete: number };
  leads: { new: number; overdue: number };
  attention: { items: Array<{ kind: string; ref_id: string; detail: string }>; total: number; by_kind: Record<string, number> };
  activity: Array<{ source: string; action: string }>;
  demos: Array<{ id: string; last_refresh_ok: boolean | null }>;
};
const pad = async (s: Session) => (await s.query<{ r: Pad }>("select public.platform_launchpad() as r")).rows[0].r;

describe("platform launchpad", () => {
  it("is for the platform team only: company owners and anonymous visitors are refused", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      for (const sql of ["select public.platform_launchpad()", `select public.platform_company('${randomUUID()}')`, `select public.platform_record_demo_refresh('${randomUUID()}', true, 'x')`]) {
        expect((await pgError(s.query(sql))).code, sql).toBe("42501");
      }
      await s.query("set local role anon");
      expect((await pgError(s.query("select public.platform_launchpad()"))).code).toBe("42501");
    });
  });

  it("lists one attention item per lead (overdue wins over new), new companies with their missing setup, and lead activity", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      const lead = await submit(s, `pad-${randomUUID().slice(0, 8)}@example.com`);
      await s.as(admin);
      let p = await pad(s);
      expect(p.attention.items.filter((a) => a.ref_id === lead).map((a) => a.kind)).toEqual(["lead_new"]);
      expect(p.activity.some((a) => a.source === "lead" && a.action === "submitted")).toBe(true);
      // An overdue follow-up on the same lead replaces the "new" item instead of adding a second one.
      await s.query("select public.platform_lead_update($1, 'new', null, current_date - 2, false, '')", [lead]);
      p = await pad(s);
      expect(p.attention.items.filter((a) => a.ref_id === lead).map((a) => a.kind)).toEqual(["lead_overdue"]);
      expect(p.leads.overdue).toBeGreaterThanOrEqual(1);

      const before = { incomplete: p.companies.setup_incomplete, items: p.attention.by_kind.company_setup ?? 0, leads: p.attention.by_kind.lead_overdue ?? 0 };
      const company = (await s.query<{ id: string }>("select public.platform_create_company($1, 'America/Chicago', $2) as id", [`Launch Hauling ${randomUUID().slice(0, 6)} (test)`, lead])).rows[0].id;
      p = await pad(s);
      expect(p.companies.setup_incomplete).toBe(before.incomplete + 1);
      expect(p.attention.by_kind.company_setup).toBe(before.items + 1);
      expect(p.attention.by_kind.lead_overdue ?? 0).toBe(before.leads - 1); // converted: no longer an open lead
      expect(p.attention.items.length).toBe(Math.min(p.attention.total, 30));
      // The newest incomplete company comes first among setup items.
      const item = p.attention.items.find((a) => a.kind === "company_setup");
      if (item) expect(item).toMatchObject({ ref_id: company, detail: "Missing owner login, customers, trucks, drivers" });
    });
  });

  it("refuses a second company for the same lead or with an active company's name", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      const lead = await submit(s, `dup-${randomUUID().slice(0, 8)}@example.com`);
      const name = `Dup Hauling ${randomUUID().slice(0, 6)} (test)`;
      await s.as(admin);
      await s.query("select public.platform_create_company($1, 'America/Chicago', $2)", [name, lead]);
      expect((await pgError(s.query("select public.platform_create_company('Another name (test)', 'America/Chicago', $1)", [lead]))).message).toMatch(/already has a company/);
      expect((await pgError(s.query("select public.platform_create_company($1, 'America/Chicago', null)", [name.toUpperCase()]))).message).toMatch(/already exists/);
    });
  });

  it("shows one company's setup, members and imports — and nothing from its business records", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin);
      const company = (await s.query<{ id: string }>("select public.platform_create_company($1, 'America/Chicago', null) as id", [`Detail Hauling ${randomUUID().slice(0, 6)} (test)`])).rows[0].id;
      const c = (await s.query<{ r: Record<string, unknown> }>("select public.platform_company($1) as r", [company])).rows[0].r;
      expect(c).toMatchObject({ id: company, active: true, missing: ["owner login", "customers", "trucks", "drivers"], members: [], imports: [] });
      expect(Object.keys(c).sort()).toEqual(["active", "audit", "created_at", "demo_kind", "id", "imports", "is_demo", "lead", "members", "missing", "name", "setup", "slug", "timezone"]);
      expect((c.audit as Array<{ action: string }>).map((a) => a.action)).toContain("company_created");
      expect((await pgError(s.query("select public.platform_company($1)", [randomUUID()]))).code).toBe("P0002");
    });
  });

  it("records demo refreshes (success and failure) for demo companies only, and flags a failed last refresh", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.asAdmin();
      const demo = (await s.query<{ id: string }>("insert into public.companies (name, slug, is_demo, demo_kind) values ($1, $2, true, 'prospect') returning id", [`Refresh Demo (test)`, `refresh-demo-${randomUUID().slice(0, 8)}`])).rows[0].id;
      const real = (await s.query<{ id: string }>("insert into public.companies (name, slug) values ('Real Co (test)', $1) returning id", [`real-${randomUUID().slice(0, 8)}`])).rows[0].id;
      await s.as(admin);
      await s.query("select public.platform_record_demo_refresh($1, false, 'Seed step failed (test)')", [demo]);
      let p = await pad(s);
      expect(p.demos.find((d) => d.id === demo)?.last_refresh_ok).toBe(false);
      expect(p.attention.items.find((a) => a.ref_id === demo)).toMatchObject({ kind: "demo_refresh_failed", detail: "Seed step failed (test)" });
      await s.query("select public.platform_record_demo_refresh($1, true, '3 loads added')", [demo]);
      p = await pad(s);
      expect(p.demos.find((d) => d.id === demo)?.last_refresh_ok).toBe(true);
      expect(p.attention.items.some((a) => a.ref_id === demo)).toBe(false);
      expect((await pgError(s.query("select public.platform_record_demo_refresh($1, true, 'x')", [real]))).code).toBe("P0002");
    });
  });
});
