// Security hardening (20261120001100) after the 2026-10-19 review (docs/SECURITY_REVIEW_2026-10-19.md):
// F1 invitations refused in demos / closed portals; F2 two-step verification enforced by the database; F3 platform help
// overview needs the platform's aal2; F4 a quote answer applies only to the version the customer saw; F5 no duplicate
// from simultaneous identical requests; F6 Testing Lab preview needs aal2; F7 anonymous portal card only with a public page.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, saveQuote, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function asAal(s: Session, userId: string, aal: "aal1" | "aal2", email?: string) {
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal, email })]);
}

async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  return id;
}

async function openPortal(s: Session, company: string, publicPage = false) {
  await s.asAdmin();
  await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [company]);
  await s.query(
    `insert into public.portal_settings (company_id, enabled, public_page, welcome, contact_phone) values ($1, true, $2, 'Hello customers', '555-0100')
     on conflict (company_id) do update set enabled = true, public_page = excluded.public_page, welcome = excluded.welcome, contact_phone = excluded.contact_phone`,
    [company, publicPage],
  );
}

describe("security hardening", () => {
  it("F1: no invitations from demo companies or while the portal is closed; the preview tells the app it is a demo", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      await s.as(owner);
      // Portal not open yet.
      expect((await pgError(s.query("select public.portal_invite($1, null, 'x@cust.example')", [ids.customerId]))).code).toBe("P0001");
      await openPortal(s, TOP_LINE);
      await s.as(owner);
      const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [ids.customerId, `f1-${randomUUID().slice(0, 6)}@cust.example`])).rows[0].r;
      await s.as(null);
      expect((await s.query<{ r: { demo: boolean } }>("select public.portal_invite_peek($1) r", [inv.token])).rows[0].r.demo).toBe(false);
      // A demo company never invites (its portal is previewed from the Testing Lab).
      const demo = await s.createCompany(`F1 Demo ${randomUUID().slice(0, 6)}`);
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      await s.query("insert into public.customers (company_id, name) values ($1, 'Fictional Customer')", [demo]);
      const cust = (await s.query<{ id: string }>("select id from public.customers where company_id = $1", [demo])).rows[0].id;
      await openPortal(s, demo);
      const demoOwner = await s.createUser("owner", { companyId: demo });
      await s.as(demoOwner);
      expect((await pgError(s.query("select public.portal_invite($1, null, 'victim@realcompany.example')", [cust]))).code).toBe("42501");
    });
  });

  it("F2: below aal2 the database gives no company to a person with an authenticator or in a company that requires it", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      // No authenticator, no policy: a password session works as before.
      await asAal(s, owner, "aal1");
      expect((await s.query("select 1 from public.customers limit 1")).rowCount).toBe(1);
      // Company requires two-step verification: nothing at aal1, everything at aal2.
      await s.asAdmin();
      await s.query("update public.company_settings set require_mfa = true where company_id = $1", [TOP_LINE]);
      await asAal(s, owner, "aal1");
      expect((await s.query("select 1 from public.customers limit 1")).rowCount).toBe(0);
      expect((await s.query<{ r: { current_company: boolean } }>("select public.mfa_policy() r")).rows[0].r.current_company).toBe(true);
      // ...and the policy cannot be switched off with a password alone.
      expect((await pgError(s.query("select public.set_company_mfa_policy(false)"))).code).toBe("42501");
      await asAal(s, owner, "aal2");
      expect((await s.query("select 1 from public.customers limit 1")).rowCount).toBe(1);
      await s.query("select public.set_company_mfa_policy(false)");
      // A person who set up an authenticator: aal1 sees nothing even without a company policy.
      const office = await s.createUser("office");
      await s.asAdmin();
      await s.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'phone', 'totp', 'verified', now(), now())", [office]);
      await asAal(s, office, "aal1");
      expect((await s.query("select 1 from public.customers limit 1")).rowCount).toBe(0);
      expect((await s.query<{ r: { enrolled: boolean } }>("select public.mfa_policy() r")).rows[0].r.enrolled).toBe(true);
      await asAal(s, office, "aal2");
      expect((await s.query("select 1 from public.customers limit 1")).rowCount).toBe(1);
    });
  });

  it("F3: the platform help overview refuses a platform admin without a verified second factor", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await asAal(s, admin, "aal1");
      expect((await pgError(s.query("select public.platform_help_overview()"))).code).toBe("42501");
      await asAal(s, admin, "aal2");
      await s.query("select public.platform_help_overview()");
    });
  });

  it("F4 and F5: an answer to an older quote version cannot be confirmed; simultaneous duplicates are refused", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      await openPortal(s, TOP_LINE);
      const slug = (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [TOP_LINE])).rows[0].slug;
      await s.as(owner);
      const q = await saveQuote(s, {
        customer_id: ids.customerId, quote_date: "2026-10-01", valid_until: "2099-12-31", tax_rate_bp: 0,
        lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "20", unit_rate_cents: 1000 }],
      });
      await s.query("select public.mark_quote_sent($1, $2, 'Handed over')", [q.quote_id, q.edit_seq]);
      const email = `f4-${randomUUID().slice(0, 6)}@cust.example`;
      const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [ids.customerId, email])).rows[0].r;
      await s.asAdmin();
      const alice = randomUUID();
      await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [alice, email]);
      await asAal(s, alice, "aal1", email);
      await s.query("select public.portal_accept($1)", [inv.token]);
      await s.query("select public.portal_quote_respond($1, $2, true, 'Alice Buyer', '')", [slug, q.quote_id]);
      // The answer was given on a version that is no longer the current one (as after a revision and re-send).
      await s.asAdmin();
      const other = (await s.query<{ id: string }>("select id from public.quote_versions where company_id = $1 and quote_id <> $2 limit 1", [TOP_LINE, q.quote_id])).rows[0];
      const resp = (await s.query<{ id: string }>("select id from public.portal_quote_responses where quote_id = $1", [q.quote_id])).rows[0].id;
      if (other) {
        await s.query("update public.portal_quote_responses set version_id = $2 where id = $1", [resp, other.id]);
        await s.as(owner);
        expect((await pgError(s.query("select public.portal_quote_response_handle($1, true)", [resp]))).message).toMatch(/revised/);
        await s.query("select public.portal_quote_response_handle($1, false)", [resp]);
      }

      // F5: an insert that slipped past the function's duplicate check (as two simultaneous requests would) is refused.
      await asAal(s, alice, "aal1", email);
      await s.query("select public.portal_request_quote($1, $2::jsonb)", [slug, JSON.stringify({ material: "Rip rap", quantity: "5", unit: "ton" })]);
      await s.asAdmin();
      const acct = (await s.query<{ id: string }>("select id from public.portal_accounts where user_id = $1", [alice])).rows[0].id;
      expect((await pgError(s.query(
        "insert into public.portal_quote_requests (company_id, customer_id, account_id, material, quantity) values ($1, $2, $3, 'RIP RAP', 5)", [TOP_LINE, ids.customerId, acct]))).code).toBe("23505");
    });
  });

  it("F6 and F7: a portal preview needs aal2; anonymous callers get the full company card only with a public page", async () => {
    await withSession(async (s) => {
      await openPortal(s, TOP_LINE, false);
      const slug = (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [TOP_LINE])).rows[0].slug;
      await s.as(null);
      const closed = (await s.query<{ r: Record<string, unknown> }>("select public.portal_public($1) r", [slug])).rows[0].r;
      expect(closed.public_page).toBe(false);
      expect(closed.name).toBeTruthy();
      expect(closed).not.toHaveProperty("welcome");
      expect(closed).not.toHaveProperty("contact_phone");
      expect(closed).not.toHaveProperty("features");
      await openPortal(s, TOP_LINE, true);
      await s.as(null);
      const open = (await s.query<{ r: Record<string, unknown> }>("select public.portal_public($1) r", [slug])).rows[0].r;
      expect(open.welcome).toBe("Hello customers");

      // F6: the preview definition requires aal2 (checked in the function body; a full preview is covered by testing-lab tests).
      await s.asAdmin();
      const def = (await s.query<{ d: string }>("select pg_get_functiondef('private.portal_me(text)'::regprocedure) d")).rows[0].d;
      expect(def).toMatch(/is_platform_admin\(\) and \(private\.aal2\(\) or not private\.platform_mfa_enforced\(\)\)/);
    });
  });
});
