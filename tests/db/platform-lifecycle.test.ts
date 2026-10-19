// Platform owner console: customer lifecycle (20261118000300). Plans are versioned; a company moves fee_due → onboarding
// → live; the go-live date only moves earlier; Go Live Now needs a fresh password sign-in; scheduled activation is
// idempotent; an annual commitment states its cancellation balance; acknowledgements are not resolutions.
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
type Life = { stage: string; agreed_monthly_cents: number | null; onboarding_fee_status: string; onboarding_fee_cents: number | null; go_live_on: string | null; today: string; commitment_months_left: number | null; already_live?: boolean };
const plan = async (s: Session, key: string) =>
  (await s.query<{ r: Array<{ id: string; plan_key: string; current: boolean }> }>("select public.platform_plans() as r")).rows[0].r.find((p) => p.plan_key === key && p.current)!.id;
const company = async (s: Session) =>
  (await s.query<{ id: string }>("select public.platform_create_company($1, 'America/Chicago', null) as id", [`Lifecycle Hauling ${randomUUID().slice(0, 8)} (test)`])).rows[0].id;
const terms = async (s: Session, c: string, p: Record<string, unknown>) =>
  (await s.query<{ r: Life }>("select public.platform_lifecycle_terms($1, $2::jsonb) as r", [c, JSON.stringify(p)])).rows[0].r;
async function signedInNow(s: Session, id: string, ago = "0 minutes") {
  await s.asAdmin();
  await s.query(`update auth.users set last_sign_in_at = now() - interval '${ago}' where id = $1`, [id]);
  await s.as(id);
}

describe("platform customer lifecycle", () => {
  it("is for the platform team only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      for (const sql of ["select public.platform_console()", "select public.platform_plans()", `select public.platform_lifecycle('${randomUUID()}')`,
                         `select public.platform_lifecycle_go_live_now('${randomUUID()}')`, "select public.platform_attention_ack('lead_new:x1', '')"]) {
        expect((await pgError(s.query(sql))).code, sql).toBe("42501");
      }
      expect((await pgError(s.query("select public.lifecycle_activate_due_cron()"))).code).toBe("42501");
    });
  });

  it("prices from the plan version: standard, founding 20% off, annual 10% off, free beta waives the fee; ambiguous combinations need the agreed amount", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin);
      const c = await company(s);
      const essential = await plan(s, "essential");
      expect((await terms(s, c, { plan_version_id: essential })).agreed_monthly_cents).toBe(49900);
      expect((await terms(s, c, { plan_version_id: essential, offer: "founding" })).agreed_monthly_cents).toBe(39920);
      expect((await terms(s, c, { plan_version_id: essential, terms: "annual" })).agreed_monthly_cents).toBe(44910);
      expect((await pgError(terms(s, c, { plan_version_id: essential, terms: "annual", offer: "founding" }))).message).toMatch(/does not guess/);
      expect((await terms(s, c, { plan_version_id: essential, terms: "annual", offer: "founding", agreed_monthly_cents: "35928" })).agreed_monthly_cents).toBe(35928);
      expect((await pgError(terms(s, c, { plan_version_id: await plan(s, "custom") }))).message).toMatch(/does not guess/);
      const beta = await terms(s, c, { plan_version_id: essential, offer: "free_beta" });
      expect([beta.agreed_monthly_cents, beta.onboarding_fee_status, beta.stage]).toEqual([0, "waived", "onboarding"]);
      // Demos have no lifecycle.
      const demo = (await s.query<{ id: string }>("select id from public.companies where is_demo limit 1")).rows[0];
      if (demo) expect((await pgError(terms(s, demo.id, { plan_version_id: essential }))).message).toMatch(/demos do not/);
    });
  });

  it("a new price is a new version from today on; earlier versions and chosen plans keep their price", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin);
      const c = await company(s);
      const v1 = await plan(s, "growth");
      await terms(s, c, { plan_version_id: v1 });
      expect((await pgError(s.query("select public.platform_plan_version_create($1::jsonb)", [JSON.stringify({ plan_key: "growth", monthly_cents: "79900", onboarding_cents: "29900", effective_from: "2020-01-01" })]))).message).toMatch(/past prices/);
      await s.query("select public.platform_plan_version_create($1::jsonb)", [JSON.stringify({ plan_key: "growth", monthly_cents: "79900", onboarding_cents: "29900", effective_from: new Date().toISOString().slice(0, 10) })]);
      const v2 = await plan(s, "growth");
      expect(v2).not.toBe(v1);
      expect((await s.query<{ r: { agreed_monthly_cents: number } }>("select public.platform_lifecycle($1) as r", [c])).rows[0].r.agreed_monthly_cents).toBe(74900);
    });
  });

  it("fee → onboarding → go-live date only earlier → Go Live Now needs a fresh sign-in and is idempotent", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin);
      const c = await company(s);
      await terms(s, c, { plan_version_id: await plan(s, "essential") });
      expect((await pgError(s.query("select public.platform_lifecycle_go_live_on($1, current_date + 30)", [c]))).message).toMatch(/while onboarding/);
      expect((await pgError(s.query("select public.platform_lifecycle_fee($1, 'paid', '')", [c]))).message).toMatch(/reference/);
      await s.query("select public.platform_lifecycle_fee($1, 'paid', 'Check 1042 (test)')", [c]);
      expect((await pgError(s.query("select public.platform_lifecycle_fee($1, 'waived', 'again')", [c]))).message).toMatch(/already recorded/);
      expect((await pgError(s.query("select public.platform_lifecycle_go_live_on($1, current_date - 3)", [c]))).message).toMatch(/past/);
      await s.query("select public.platform_lifecycle_go_live_on($1, current_date + 30)", [c]);
      expect((await pgError(s.query("select public.platform_lifecycle_go_live_on($1, current_date + 31)", [c]))).message).toMatch(/only move earlier/);
      await s.query("select public.platform_lifecycle_go_live_on($1, current_date + 20)", [c]);
      await signedInNow(s, admin, "20 minutes");
      expect((await pgError(s.query("select public.platform_lifecycle_go_live_now($1)", [c]))).code).toBe("42501");
      await signedInNow(s, admin);
      const live = (await s.query<{ r: Life }>("select public.platform_lifecycle_go_live_now($1) as r", [c])).rows[0].r;
      expect(live.stage).toBe("live");
      expect((await s.query<{ r: Life }>("select public.platform_lifecycle_go_live_now($1) as r", [c])).rows[0].r.already_live).toBe(true);
      await s.asAdmin();
      const audit = await s.query<{ n: string }>("select count(*) n from private.platform_audit where action = 'company_went_live' and target_id = $1", [c]);
      expect(Number(audit.rows[0].n)).toBe(1);
    });
  });

  it("scheduled activation makes due companies live once, and the console counts them in MRR", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin);
      const c = await company(s);
      await terms(s, c, { plan_version_id: await plan(s, "professional"), terms: "annual" });
      await s.query("select public.platform_lifecycle_fee($1, 'waived', 'Waived by agreement (test)')", [c]);
      await s.query("select public.platform_lifecycle_go_live_on($1, current_date + 5)", [c]);
      const before = (await s.query<{ r: { mrr: { cents: number }; customers: { live: number } } }>("select public.platform_console() as r")).rows[0].r;
      // The day comes (moved in the data, as the clock would).
      await s.asAdmin();
      await s.query("update private.company_lifecycle set go_live_on = current_date - 1 where company_id = $1", [c]);
      await service(s);
      expect((await s.query<{ n: number }>("select public.lifecycle_activate_due_cron() as n")).rows[0].n).toBeGreaterThanOrEqual(1);
      expect((await s.query<{ n: number }>("select public.lifecycle_activate_due_cron() as n")).rows[0].n).toBe(0);
      await s.as(admin);
      const after = (await s.query<{ r: { mrr: { cents: number }; customers: { live: number } } }>("select public.platform_console() as r")).rows[0].r;
      expect(after.customers.live).toBe(before.customers.live + 1);
      expect(after.mrr.cents).toBe(before.mrr.cents + 89910);
      // Annual commitment: cancelling states the balance; the operator must confirm that exact amount.
      const life = (await s.query<{ r: Life }>("select public.platform_lifecycle($1) as r", [c])).rows[0].r;
      expect(life.commitment_months_left).toBe(11);
      expect((await pgError(s.query("select public.platform_lifecycle_cancel($1, 'Closing the business (test)', 0)", [c]))).message).toMatch(/989010 cents/);
      const canceled = (await s.query<{ r: Life & { cancel_balance_cents: number } }>("select public.platform_lifecycle_cancel($1, 'Closing the business (test)', 989010) as r", [c])).rows[0].r;
      expect([canceled.stage, canceled.cancel_balance_cents]).toEqual(["canceled", 989010]);
    });
  });

  it("acknowledging an attention item records who and when, without resolving it", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin);
      const key = `lead_new:${randomUUID()}`;
      expect((await pgError(s.query("select public.platform_attention_ack('bad key', '')"))).code).toBe("22023");
      await s.query("select public.platform_attention_ack($1, 'Calling tomorrow')", [key]);
      const acks = (await s.query<{ r: { acks: Record<string, { note: string }> } }>("select public.platform_console() as r")).rows[0].r.acks;
      expect(acks[key].note).toBe("Calling tomorrow");
    });
  });
});
