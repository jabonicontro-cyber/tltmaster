import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

// Site directions verification (20261115000200): who verified a site's directions and when, set only through
// verify_site_directions, cleared when the directions change, and judged against the company's review intervals.

const tag = () => Math.random().toString(36).slice(2, 7);

async function site(s: Session, user: string, row: Record<string, unknown> = {}) {
  await s.as(user);
  const customer = await insert(s, "customers", { name: `Dir Co ${tag()}` });
  return insert(s, "customer_sites", { customer_id: customer, label: "Main gate", line1: "1 Quarry Rd", directions: "Gate code 4411, dump at north pad.", ...row });
}

async function status(s: Session, siteId: string) {
  await s.asAdmin();
  return (await s.query<{ st: string }>("select private.site_directions_status(cs) as st from public.customer_sites cs where id = $1", [siteId])).rows[0].st;
}

async function row(s: Session, siteId: string) {
  await s.asAdmin();
  return (await s.query<{ directions_verified_at: string | null; directions_verified_by: string | null }>(
    "select directions_verified_at, directions_verified_by from public.customer_sites where id = $1", [siteId])).rows[0];
}

describe("site directions verification", () => {
  it("is set only through verify_site_directions, audited, and cleared when the directions change", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const id = await site(s, office);
      expect(await status(s, id)).toBe("unverified");

      // A direct write cannot forge a verification.
      await s.as(office);
      await s.query("update public.customer_sites set directions_verified_at = now(), directions_verified_by = $2 where id = $1", [id, office]);
      expect((await row(s, id)).directions_verified_at).toBeNull();

      await s.as(office);
      await s.query("select public.verify_site_directions($1)", [id]);
      const v = await row(s, id);
      expect(v.directions_verified_by).toBe(office);
      expect(v.directions_verified_at).not.toBeNull();
      expect(await status(s, id)).toBe("verified");
      await s.asAdmin();
      expect((await s.query("select 1 from public.audit_events where entity_id = $1 and action = 'site_directions_verified'", [id])).rowCount).toBe(1);

      // Editing other fields keeps it; changing the directions clears it.
      await s.as(office);
      await s.query("update public.customer_sites set label = 'Main gate (east)' where id = $1", [id]);
      expect((await row(s, id)).directions_verified_by).toBe(office);
      await s.as(office);
      await s.query("update public.customer_sites set directions = 'Gate code changed to 9902.' where id = $1", [id]);
      expect(await row(s, id)).toEqual({ directions_verified_at: null, directions_verified_by: null });
      expect(await status(s, id)).toBe("unverified");
    });
  });

  it("needs customers.edit, the caller's company and some directions", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      const id = await site(s, office);
      const empty = await site(s, office, { directions: "" });
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.verify_site_directions($1)", [id]))).code).toBe("42501");
      await s.as(office);
      expect((await pgError(s.query("select public.verify_site_directions($1)", [empty]))).message).toMatch(/no directions/);
      expect(await status(s, empty)).toBe("none");

      const other = await s.createCompany(`Other ${tag()}`);
      const otherOffice = await s.createUser("office", { companyId: other });
      await s.as(otherOffice);
      expect((await pgError(s.query("select public.verify_site_directions($1)", [id]))).message).toMatch(/Site not found/);
    });
  });

  it("follows the company's review interval per kind; no interval means no due date", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const std = await site(s, office);
      const safety = await site(s, office, { directions_risk: "safety_access" });
      await s.as(office);
      await s.query("select public.verify_site_directions($1)", [std]);
      await s.query("select public.verify_site_directions($1)", [safety]);
      await s.asAdmin();
      // Verified 40 days ago.
      await s.query("set local taviron.site_verify = 'on'");
      await s.query("update public.customer_sites set directions_verified_at = now() - interval '40 days' where id = any($1)", [[std, safety]]);
      await s.query("set local taviron.site_verify = ''");
      const company = (await s.query<{ c: string }>("select company_id as c from public.customer_sites where id = $1", [std])).rows[0].c;

      await s.query("update public.company_settings set site_review_days_standard = null, site_review_days_safety = null where company_id = $1", [company]);
      expect([await status(s, std), await status(s, safety)]).toEqual(["verified", "verified"]); // no interval chosen

      await s.query("update public.company_settings set site_review_days_standard = 90, site_review_days_safety = 30 where company_id = $1", [company]);
      expect([await status(s, std), await status(s, safety)]).toEqual(["verified", "due"]);
      expect((await pgError(s.query("update public.company_settings set site_review_days_safety = 0 where company_id = $1", [company]))).code).toBe("23514");

      // Only settings.manage changes the intervals (the owner through the Settings form; RLS refuses others).
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await s.query("update public.company_settings set site_review_days_standard = 120 where company_id = $1", [company])).rowCount).toBe(1);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await s.query("update public.company_settings set site_review_days_standard = 7 where company_id = $1", [company])).rowCount).toBe(0);
      await s.asAdmin();
      expect((await s.query<{ d: number }>("select site_review_days_standard d from public.company_settings where company_id = $1", [company])).rows[0].d).toBe(120);
    });
  });

  it("shows the driver the status and kind of the site's directions on My Day, never who verified them", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const office = await s.createUser("office");
      const f = await fleet(s, office, today);
      const order = await scheduledOrder(s, office, today, addDays(today, 1));
      const load = await planLoad(s, order.id, today, "07:00", "09:00");
      await assign(s, load.load_id, f.t1, null, f.d1);
      const driver = await s.createUser("driver");
      await s.as(office);
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driver]);
      await s.asAdmin();
      const customer = (await s.query<{ customer_id: string }>("select customer_id from public.orders where id = $1", [order.id])).rows[0].customer_id;
      await s.as(office);
      const siteId = await insert(s, "customer_sites", { customer_id: customer, label: "Pit gate", line1: "2 Pit Rd", directions: "Low wire over the back lot.", directions_risk: "safety_access" });
      await s.asAdmin();
      await s.query("update public.orders set site_id = $2 where id = $1", [order.id, siteId]);

      const mySite = async () => {
        await s.as(driver);
        const h = (await s.query<{ r: { assignments: Array<{ site: Record<string, unknown> }> } }>("select public.driver_portal_home() as r")).rows[0].r;
        return h.assignments[0].site;
      };
      expect(await mySite()).toMatchObject({ directions: "Low wire over the back lot.", directions_status: "unverified", directions_risk: "safety_access", directions_verified_at: null });
      await s.as(office);
      await s.query("select public.verify_site_directions($1)", [siteId]);
      const after = await mySite();
      expect(after).toMatchObject({ directions_status: "verified", directions_risk: "safety_access" });
      expect(after.directions_verified_at).not.toBeNull();
      expect(JSON.stringify(after)).not.toContain(office);
    });
  });
});
