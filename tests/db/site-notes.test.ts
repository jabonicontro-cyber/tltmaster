// Job-site notes from customers (B94, migration 20261120004100): a customer writes only about their own sites; nothing
// reaches drivers until someone with customers.edit applies it; applying writes the site's directions (unverified) and
// turns the photos into site photos a driver on that site's load can open.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function asWithEmail(s: Session, userId: string) {
  await s.asAdmin();
  const email = (await s.client.query<{ email: string }>("select email from auth.users where id = $1", [userId])).rows[0]?.email;
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", email })]);
}

describe("site notes from customers", () => {
  it("goes from the customer's portal through office review to the driver", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const order = await scheduledOrder(s, owner, today);
      await s.asAdmin();
      const o = (await s.query<{ company_id: string; customer_id: string; site_id: string | null }>("select company_id, customer_id, site_id from public.orders where id = $1", [order.id])).rows[0];
      let siteId = o.site_id;
      if (!siteId) {
        siteId = (await s.query<{ id: string }>("insert into public.customer_sites (company_id, customer_id, label, line1) values ($1, $2, 'Test site', '1 Test Rd') returning id", [o.company_id, o.customer_id])).rows[0].id;
        await s.query("update public.orders set site_id = $2 where id = $1", [order.id, siteId]);
      }
      await s.query("update public.customer_sites set directions = 'Old directions' where id = $1", [siteId]);
      const otherCustomer = (await s.query<{ id: string }>("insert into public.customers (company_id, name) values ($1, 'Other customer (test)') returning id", [o.company_id])).rows[0].id;
      const otherSite = (await s.query<{ id: string }>("insert into public.customer_sites (company_id, customer_id, label, line1) values ($1, $2, 'Not yours', '2 Other Rd') returning id", [o.company_id, otherCustomer])).rows[0].id;
      await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [o.company_id]);
      await s.query("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true", [o.company_id]);
      const slug = (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [o.company_id])).rows[0].slug;

      await s.as(owner);
      const email = `site-${randomUUID().slice(0, 8)}@customer.example`;
      const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [o.customer_id, email])).rows[0].r;
      await s.asAdmin();
      const customer = randomUUID();
      await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [customer, email]);
      await asWithEmail(s, customer);
      await s.query("select public.portal_accept($1)", [inv.token]);

      const sites = (await s.query<{ r: Array<{ id: string }> }>("select public.portal_sites($1) r", [slug])).rows[0].r;
      expect(sites.map((x) => x.id)).toContain(siteId);
      expect(sites.map((x) => x.id)).not.toContain(otherSite);
      const submit = (site: string) => s.query<{ r: string }>("select public.portal_site_info_submit($1, $2, '1234#', 'Back lot', 'Sam', '555-0100', 'Gate closes at 4') r", [slug, site]);
      expect((await pgError(submit(otherSite))).message).toMatch(/Site not found/);
      expect((await pgError(s.query("select public.portal_site_info_submit($1, $2, '', '', '', '', '')", [slug, siteId]))).message).toMatch(/at least one detail/);
      const note = (await submit(siteId!)).rows[0].r;
      const path = (await s.query<{ r: string }>("select public.portal_site_photo_begin($1, $2, 'image/jpeg', 1000) r", [slug, note])).rows[0].r;
      expect(path).toMatch(new RegExp(`^${o.company_id}/site-photos/`));
      await s.query("select public.portal_site_photo_begin($1, $2, 'image/jpeg', 1000)", [slug, note]);
      await s.query("select public.portal_site_photo_begin($1, $2, 'image/png', 1000)", [slug, note]);
      expect((await pgError(s.query("select public.portal_site_photo_begin($1, $2, 'image/jpeg', 1000)", [slug, note]))).message).toMatch(/At most 3/);
      expect((await pgError(s.query("select public.portal_site_photo_begin($1, $2, 'application/pdf', 1000)", [slug, note]))).message).toMatch(/JPEG, PNG or WebP/);

      // A driver on this site's load sees nothing yet.
      const f = await fleet(s, owner, today);
      const load = await planLoad(s, order.id, today, "08:00", "10:00");
      await s.as(owner);
      await assign(s, load.load_id, f.t1, null, f.d1);
      const driverUser = await s.createUser("driver");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);
      const photoId = (await s.query<{ id: string }>("select id from public.site_photos where submission_id = $1 limit 1", [note])).rows[0].id;
      await s.as(driverUser);
      expect((await s.query<{ r: Record<string, string[]> }>("select public.driver_site_photos() r")).rows[0].r).toEqual({});
      expect((await s.query<{ r: string | null }>("select public.site_photo_path($1) r", [photoId])).rows[0].r).toBeNull();
      expect((await pgError(s.query("select public.site_info_review($1, true, 'x')", [note]))).message).toMatch(/permission/);

      // The office applies it: directions change (unverified) and the photos become the site's.
      await s.as(owner);
      expect((await s.query<{ r: string }>("select public.site_info_review($1, true, $2) r", [note, "Old directions\n\nGate code: 1234#"])).rows[0].r).toBe("applied");
      expect((await pgError(s.query("select public.site_info_review($1, false, '')", [note]))).message).toMatch(/already reviewed/);
      const site = (await s.query<{ directions: string; directions_verified_at: string | null }>("select directions, directions_verified_at from public.customer_sites where id = $1", [siteId])).rows[0];
      expect(site).toEqual({ directions: "Old directions\n\nGate code: 1234#", directions_verified_at: null });
      await s.as(driverUser);
      expect((await s.query<{ r: Record<string, string[]> }>("select public.driver_site_photos() r")).rows[0].r[load.load_id]).toHaveLength(3);
      expect((await s.query<{ r: string | null }>("select public.site_photo_path($1) r", [photoId])).rows[0].r).toMatch(new RegExp(`^${o.company_id}/site-photos/`));

      // Another company sees none of it; a real company cannot add the demo note.
      const other = await s.createCompany("Other Co (site notes)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select id from public.site_info_submissions where id = $1", [note])).rows).toHaveLength(0);
      expect((await s.query<{ r: string | null }>("select public.site_photo_path($1) r", [photoId])).rows[0].r).toBeNull();
      await s.as(owner);
      expect((await pgError(s.query("select public.demo_site_note()"))).message).toMatch(/only added to a demo company/);
    });
  });
});
