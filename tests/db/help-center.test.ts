// Help Center storage (20261120000400): people record their own feedback, searches and support requests in their own
// company; nobody reads other people's rows; searches are write-only; only the platform team sees totals and requests.
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

describe("help center storage", () => {
  it("feedback and support requests are private to the person; searches are write-only", async () => {
    await withSession(async (s) => {
      const a = await s.createUser("office");
      const b = await s.createUser("dispatcher");
      await s.as(a);
      await s.query("insert into public.help_feedback (article_id, helpful, note) values ('customers', false, 'Missing the export step')");
      await s.query("insert into public.help_feedback (article_id, helpful) values ('customers', true) on conflict (company_id, user_id, article_id) do update set helpful = excluded.helpful");
      await s.query("insert into public.help_searches (query, results) values ('export customers', 1)");
      await s.query("insert into public.help_support_requests (page, message) values ('/customers', 'How do I export only prospects?')");
      expect((await s.query("select helpful from public.help_feedback")).rows).toEqual([{ helpful: true }]);
      expect((await s.query("select 1 from public.help_support_requests")).rowCount).toBe(1);
      expect((await s.query("select * from public.help_searches")).rowCount).toBe(0); // write-only: no select policy
      // Status cannot be set by the person, and a message must say something.
      expect((await pgError(s.query("insert into public.help_support_requests (message, status) values ('Please close this one', 'closed')"))).code).toBe("42501");
      expect((await pgError(s.query("insert into public.help_support_requests (message) values ('short')"))).code).toBe("23514");
      await s.as(b);
      expect((await s.query("select 1 from public.help_feedback")).rowCount).toBe(0);
      expect((await s.query("select 1 from public.help_support_requests")).rowCount).toBe(0);
    });
  });

  it("another company cannot write into this company, and only the platform team reads the overview", async () => {
    await withSession(async (s) => {
      const other = await s.createCompany("Help Other (test)");
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await pgError(s.query("insert into public.help_support_requests (company_id, message) values ('00000000-0000-4000-8000-000000000001', 'Writing into another company')"))).code).toBe("42501");
      // Refused outright for anyone but the platform team (20261120001100: through require_platform_admin, with MFA).
      expect((await pgError(s.query("select public.platform_help_overview()"))).code).toBe("42501");
      await s.query("insert into public.help_searches (query, results) values ('zzz nothing here', 0)");
      const admin = await platformAdmin(s);
      await s.as(admin);
      const r = (await s.query<{ r: { searches: number; no_results: Array<{ query: string }> } }>("select public.platform_help_overview() r")).rows[0].r;
      expect(r.searches).toBeGreaterThan(0);
      expect(r.no_results.map((x) => x.query)).toContain("zzz nothing here");
    });
  });
});
