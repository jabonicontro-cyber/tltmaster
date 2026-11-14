// Simple mode for new Starter companies (owner decision 2026-11-14, master plan SF1; migration 20261120022200): a new
// company whose first plan is Starter starts with the optional areas hidden except Maintenance; existing companies,
// companies on other plans, a later plan change and an owner's own menu are never changed.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const STARTER_HIDDEN = ["/quotes", "/support", "/customer-portal", "/order-to-cash", "/payroll", "/schedule", "/time-off", "/reports"];

async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  return id;
}

async function planId(s: Session, key: string) {
  await s.asAdmin();
  return (await s.query<{ id: string }>("select id from private.platform_plan_versions where plan_key = $1 order by version desc limit 1", [key])).rows[0].id;
}

const hidden = async (s: Session, company: string) => {
  await s.asAdmin();
  return (await s.query<{ h: string[] }>("select hidden_areas h from public.company_settings where company_id = $1", [company])).rows[0].h;
};

describe("Starter companies start with the essentials in the menu", () => {
  it("hides the optional areas except Maintenance when a new company's first plan is Starter", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      const starter = await planId(s, "starter");
      const essential = await planId(s, "essential");
      const company = await s.createCompany(`Starter Haul ${randomUUID().slice(0, 6)} (test)`);
      expect(await hidden(s, company)).toEqual([]);

      await s.as(admin);
      await s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [company, JSON.stringify({ plan_version_id: starter, terms: "monthly", offer: "standard" })]);
      const h = await hidden(s, company);
      expect([...h].sort()).toEqual([...STARTER_HIDDEN].sort());
      expect(h).not.toContain("/maintenance");
      // Logged to platform activity.
      expect((await s.query("select 1 from private.platform_audit where action = 'starter_menu_defaults' and target_id = $1", [company])).rowCount).toBe(1);

      // The owner turns areas back on; a later save of the same plan, or a plan change, never hides them again.
      const owner = await s.createUser("owner", { companyId: company });
      await s.as(owner);
      await s.query("update public.company_settings set hidden_areas = array['/payroll'] where company_id = $1", [company]);
      await s.as(admin);
      await s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [company, JSON.stringify({ plan_version_id: starter, terms: "monthly", offer: "standard" })]);
      await s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [company, JSON.stringify({ plan_version_id: essential, terms: "monthly", offer: "standard" })]);
      await s.as(admin);
      await s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [company, JSON.stringify({ plan_version_id: starter, terms: "monthly", offer: "standard" })]);
      expect(await hidden(s, company)).toEqual(["/payroll"]);
    });
  });

  it("never changes another plan, an existing company, a live company or a menu the owner already set", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      const starter = await planId(s, "starter");
      const essential = await planId(s, "essential");
      const terms = (plan: string) => JSON.stringify({ plan_version_id: plan, terms: "monthly", offer: "standard" });

      // First plan Essential: nothing hidden; switching to Starter later changes nothing either.
      const growing = await s.createCompany(`Essential Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.as(admin);
      await s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [growing, terms(essential)]);
      await s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [growing, terms(starter)]);
      expect(await hidden(s, growing)).toEqual([]);

      // A company created before the decision (Top Line and every existing customer): unchanged.
      const older = await s.createCompany(`Older Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.query("update public.companies set created_at = timestamptz '2026-10-01 12:00:00+00' where id = $1", [older]);
      await s.as(admin);
      await s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [older, terms(starter)]);
      expect(await hidden(s, older)).toEqual([]);

      // A company that already went live: unchanged.
      const live = await s.createCompany(`Live Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [live]);
      await s.as(admin);
      await s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [live, terms(starter)]);
      expect(await hidden(s, live)).toEqual([]);

      // The owner chose a menu before the plan was set: kept as it is.
      const chosen = await s.createCompany(`Chosen Haul ${randomUUID().slice(0, 6)} (test)`);
      const owner = await s.createUser("owner", { companyId: chosen });
      await s.as(owner);
      await s.query("update public.company_settings set hidden_areas = array['/quotes'] where company_id = $1", [chosen]);
      await s.as(admin);
      await s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [chosen, terms(starter)]);
      expect(await hidden(s, chosen)).toEqual(["/quotes"]);

      // Demo companies have no plan at all (the lifecycle refuses them), so their menus never change here.
      const demo = await s.createCompany(`Demo Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      await s.as(admin);
      expect((await pgError(s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [demo, terms(starter)]))).code).toBe("P0002");
      expect(await hidden(s, demo)).toEqual([]);

      // Top Line was created before the decision, so the rule can never reach it.
      await s.asAdmin();
      const tl = (await s.query<{ old: boolean }>("select created_at < timestamptz '2026-11-14 00:00:00+00' old from public.companies where id = $1", [TOP_LINE])).rows[0];
      expect(tl.old).toBe(true);
    });
  });
});
