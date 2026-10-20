// Customer Onboarding Kit (20261120001500; docs/ONBOARDING.md §5): forms are saved with versions and never silently
// overwritten; secrets are refused; the company cannot record Taviron's results; critical acceptance items must pass;
// sign-off needs the owner and Taviron on the same version and is voided by later changes; activation waits for the
// acceptance when the company has an onboarding checklist; other companies see nothing.
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

const PASS_ALL = {
  items: Object.fromEntries(["commercial_scope", "tenant_permissions", "data_validation", "dispatch_testing", "safety_procedures", "integrations",
    "core_workflows", "training", "support_escalation", "fallback", "open_defects", "launch_plan"].map((k) => [k, { status: "passed", note: "checked" }])),
};

async function company(s: Session) {
  const c = await s.createCompany(`Kit ${randomUUID().slice(0, 6)}`);
  const owner = await s.createUser("owner", { companyId: c });
  return { c, owner };
}

describe("onboarding kit", () => {
  it("the company saves its questionnaire with versions; conflicts and secrets are refused; Taviron-only forms are closed to it", async () => {
    await withSession(async (s) => {
      const { owner } = await company(s);
      await s.as(owner);
      const v1 = (await s.query<{ r: { version: number } }>("select public.onboarding_form_save('questionnaire', $1, 0) r", [{ legal_name: "Kit Hauling LLC" }])).rows[0].r.version;
      expect(v1).toBe(1);
      const v2 = (await s.query<{ r: { version: number } }>("select public.onboarding_form_save('questionnaire', $1, 1) r", [{ legal_name: "Kit Hauling LLC", truck_count: 12 }])).rows[0].r.version;
      expect(v2).toBe(2);
      // Someone saved meanwhile: the stale version is refused, nothing overwritten.
      expect((await pgError(s.query("select public.onboarding_form_save('questionnaire', $1, 1)", [{ legal_name: "Stale" }]))).code).toBe("40001");
      expect((await pgError(s.query("select public.onboarding_form_save('questionnaire', $1, 2)", [{ password: "x" }]))).code).toBe("22023");
      expect((await pgError(s.query("select public.onboarding_form_save('go_live', $1, 0)", [PASS_ALL]))).code).toBe("42501");
      expect((await pgError(s.query("select public.onboarding_form_save('integration_checks', $1, 0)", [{ items: {} }]))).code).toBe("42501");
      const kit = (await s.query<{ r: { forms: { questionnaire: { data: { truck_count: number }; version: number } } } }>("select public.onboarding_kit() r")).rows[0].r;
      expect(kit.forms.questionnaire).toMatchObject({ version: 2, data: { truck_count: 12 } });
      await s.asAdmin();
      expect((await s.query<{ n: number }>("select count(*)::int n from public.onboarding_form_versions where form = 'questionnaire' and company_id = (select company_id from public.onboarding_forms where form = 'questionnaire' and data ->> 'legal_name' = 'Kit Hauling LLC')")).rows[0].n).toBe(2);
    });
  });

  it("people without settings.manage and other companies see nothing", async () => {
    await withSession(async (s) => {
      const { c, owner } = await company(s);
      await s.as(owner);
      await s.query("select public.onboarding_form_save('testing', $1, 0)", [{ issues: [] }]);
      const driver = await s.createUser("driver", { companyId: c });
      await s.as(driver);
      expect((await pgError(s.query("select public.onboarding_kit()"))).code).toBe("42501");
      expect((await s.query("select * from public.onboarding_forms")).rowCount).toBe(0);
      const other = await company(s);
      await s.as(other.owner);
      expect((await s.query("select * from public.onboarding_forms where company_id = $1", [c])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.platform_onboarding_kit($1)", [c]))).code).toBe("42501");
    });
  });

  it("critical items cannot be waived; open critical issues and unfinished items block sign-off; both parties sign one version", async () => {
    await withSession(async (s) => {
      const { c, owner } = await company(s);
      const admin = await platformAdmin(s);
      await s.as(admin);
      const waived = { items: { ...PASS_ALL.items, dispatch_testing: { status: "not_applicable", note: "not needed" } } };
      expect((await pgError(s.query("select public.platform_onboarding_form_save($1, 'go_live', $2, 0)", [c, waived]))).code).toBe("22023");
      const partial = { items: { ...PASS_ALL.items, training: { status: "in_progress" } } };
      await s.query("select public.platform_onboarding_form_save($1, 'go_live', $2, 0)", [c, partial]);
      expect((await pgError(s.query("select public.platform_onboarding_go_live_sign($1, 'Tara Taviron', 'Onboarding lead', 1)", [c]))).code).toBe("P0001");
      // An exception needs a reason; with one it is accepted and listed in the sign-off.
      await s.query("select public.platform_onboarding_form_save($1, 'go_live', $2, 1)", [c, { items: { ...PASS_ALL.items, training: { status: "exception", note: "Night drivers trained in week one" } } }]);
      await s.as(owner);
      await s.query("select public.onboarding_form_save('testing', $1, 0)", [{ issues: [{ title: "Ticket photo upload fails", critical: true, status: "open" }] }]);
      expect((await pgError(s.query("select public.onboarding_go_live_sign('Olive Owner', 'Owner', 2)"))).code).toBe("P0001");
      await s.query("select public.onboarding_form_save('testing', $1, 1)", [{ issues: [{ title: "Ticket photo upload fails", critical: true, status: "resolved" }] }]);
      // Resolved: the owner signs.
      await s.query("select public.onboarding_go_live_sign('Olive Owner', 'Owner', 2)");
      await s.as(admin);
      const kit = (await s.query<{ r: { accepted: boolean; signoffs: Array<{ party: string; exceptions: unknown[] }> } }>(
        "select public.platform_onboarding_go_live_sign($1, 'Tara Taviron', 'Onboarding lead', 2) r", [c])).rows[0].r;
      expect(kit.accepted).toBe(true);
      expect(kit.signoffs.find((x) => x.party === "company")!.exceptions).toHaveLength(1);
      // A later change voids both sign-offs (kept in history).
      await s.query("select public.platform_onboarding_form_save($1, 'go_live', $2, 2)", [c, PASS_ALL]);
      const after = (await s.query<{ r: { accepted: boolean; signoffs: Array<{ current: boolean }> } }>("select public.platform_onboarding_kit($1) r", [c])).rows[0].r;
      expect(after.accepted).toBe(false);
      expect(after.signoffs).toHaveLength(2);
      expect(after.signoffs.every((x) => !x.current)).toBe(true);
      await s.asAdmin();
      expect((await pgError(s.query("delete from public.onboarding_signoffs where company_id = $1", [c]))).code).toBe("42501");
    });
  });

  it("only an owner signs for the company", async () => {
    await withSession(async (s) => {
      const { c } = await company(s);
      const admin = await platformAdmin(s);
      await s.as(admin);
      await s.query("select public.platform_onboarding_form_save($1, 'go_live', $2, 0)", [c, PASS_ALL]);
      await s.asAdmin();
      const office = await s.createUser("office", { companyId: c });
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'office', 'settings.manage') on conflict do nothing", [c]).catch(() => undefined);
      await s.as(office);
      const e = await pgError(s.query("select public.onboarding_go_live_sign('Otto Office', '', 1)"));
      expect(e.code).toBe("42501");
    });
  });

  it("activation waits for the signed acceptance when the company has an onboarding checklist", async () => {
    await withSession(async (s) => {
      const { c, owner } = await company(s);
      await s.asAdmin();
      await s.query("select private.onboarding_generate($1, '{\"routing\": false, \"ai\": false}'::jsonb)", [c]);
      await s.query("insert into private.company_lifecycle (company_id, stage, onboarding_fee_status, go_live_on) values ($1, 'onboarding', 'waived', private.company_today($1))", [c]);
      await s.query("select private.lifecycle_activate_due()");
      expect((await s.query<{ stage: string }>("select stage from private.company_lifecycle where company_id = $1", [c])).rows[0].stage).toBe("onboarding");
      const admin = await platformAdmin(s);
      await s.query("update auth.users set last_sign_in_at = now() where id = $1", [admin]);
      await s.as(admin);
      expect((await pgError(s.query("select public.platform_lifecycle_go_live_now($1)", [c]))).message).toMatch(/go-live acceptance/);
      await s.query("select public.platform_onboarding_form_save($1, 'go_live', $2, 0)", [c, PASS_ALL]);
      await s.query("select public.platform_onboarding_go_live_sign($1, 'Tara Taviron', '', 1)", [c]);
      await s.as(owner);
      await s.query("select public.onboarding_go_live_sign('Olive Owner', 'Owner', 1)");
      await s.asAdmin();
      await s.query("select private.lifecycle_activate_due()");
      const l = (await s.query<{ stage: string; live_at: string | null }>("select stage, live_at from private.company_lifecycle where company_id = $1", [c])).rows[0];
      expect(l.stage).toBe("live");
      expect(l.live_at).not.toBeNull();
    });
  });
});
