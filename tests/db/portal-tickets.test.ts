// Customer portal ticket list (20261120014000): public.portal_tickets returns the signed-in customer's own live
// delivery tickets across their orders, newest first, filtered by delivery day and their own job site, only while the
// company's Documents switch is on. Another customer of the same company, another company and staff see nothing.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, TOP_LINE, withSession, type Session } from "./helpers";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";

afterAll(() => pool.end());

type Ticket = { id: string; number: string; order_number: string; delivered_on: string; quantity: number; unit: string; material: string | null; site: string; site_id: string | null; confirmed: boolean };
type List = { tickets: Ticket[]; has_more: boolean; limit: number; today: string };

async function asWithEmail(s: Session, userId: string) {
  await s.asAdmin();
  const email = (await s.client.query<{ email: string }>("select email from auth.users where id = $1", [userId])).rows[0]?.email;
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", email })]);
}

async function openPortal(s: Session, company: string) {
  await s.asAdmin();
  await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [company]);
  await s.query("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true, feature_documents = true", [company]);
}

async function slugOf(s: Session, company: string) {
  await s.asAdmin();
  return (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [company])).rows[0].slug;
}

async function enroll(s: Session, owner: string, customerId: string) {
  const email = `tix-${randomUUID().slice(0, 8)}@cust.example`;
  await s.as(owner);
  const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [customerId, email])).rows[0].r;
  await s.asAdmin();
  const user = randomUUID();
  await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [user, email]);
  await asWithEmail(s, user);
  await s.query("select public.portal_accept($1)", [inv.token]);
  return user;
}

/** An order for the sample customer delivered on `day`, with tickets (status, quantity) on its material line. */
async function deliveredOrder(s: Session, owner: string, day: string, tickets: Array<[string, number]>, siteId: string | null = null) {
  const order = await scheduledOrder(s, owner, day);
  const load = await planLoad(s, order.id, day, "08:00", "10:00", { planned_quantity: "20", unit_code: "ton" });
  const f = await fleet(s, owner, day);
  await s.as(owner);
  const a = await assign(s, load.load_id, f.t1, null, f.d1);
  await s.asAdmin();
  if (siteId) await s.query("update public.orders set site_id = $2, site_label = 'Tickets test yard' where id = $1", [order.id, siteId]);
  const ids: string[] = [];
  for (const [status, qty] of tickets) {
    const r = await s.query<{ id: string }>(
      `insert into public.delivery_tickets (company_id, ticket_number, status, order_id, load_id, assignment_id, order_line_id, truck_id, driver_id, delivered_at, quantity, unit_code, snapshot,
                                           voided_at, voided_by, void_reason)
       values ($1, 'TT-' || substr(md5(random()::text), 1, 8), $2::public.ticket_status, $3, $4, $5, $6, $7, $8, ($9::date + time '12:00') at time zone 'America/Chicago', $10, 'ton', '{}'::jsonb,
               case when $2 = 'voided' then now() end, case when $2 = 'voided' then $11::uuid end, case when $2 = 'voided' then 'Entered twice (test)' else '' end) returning id`,
      [TOP_LINE, status, order.id, load.load_id, a, order.materialLine, f.t1, f.d1, day, qty, owner]);
    ids.push(r.rows[0].id);
  }
  return { order, ids };
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

describe("portal ticket list", () => {
  it("lists only the customer's own live tickets, newest first, and filters by day and job site", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      await s.asAdmin();
      await s.query("update public.company_settings set timezone = 'America/Chicago' where company_id = $1", [TOP_LINE]);
      const site = (await s.query<{ id: string }>("insert into public.customer_sites (company_id, customer_id, label, line1) values ($1, $2, 'Tickets test yard', '1 Test Rd') returning id", [TOP_LINE, ids.customerId])).rows[0].id;
      const older = await deliveredOrder(s, owner, addDays(today, -3), [["accepted", 12], ["needs_review", 10]]);
      const newer = await deliveredOrder(s, owner, addDays(today, -1), [["submitted", 8], ["voided", 9]], site);
      await openPortal(s, TOP_LINE);
      const slug = await slugOf(s, TOP_LINE);
      const alice = await enroll(s, owner, ids.customerId);

      await s.as(alice);
      const all = (await s.query<{ r: List }>("select public.portal_tickets($1) r", [slug])).rows[0].r;
      const mine = all.tickets.filter((t) => [...older.ids, ...newer.ids].includes(t.id));
      // Voided tickets are left out; newest delivery first.
      expect(mine).toHaveLength(3);
      expect(mine[0].id).toBe(newer.ids[0]);
      expect(mine.slice(1).map((t) => t.id).sort()).toEqual([...older.ids].sort());
      expect(mine[0]).toMatchObject({ delivered_on: addDays(today, -1), material: "Gravel #53", confirmed: false, site_id: site });
      expect(mine.find((t) => t.id === older.ids[0])).toMatchObject({ confirmed: true, quantity: 12 });
      expect(all.has_more).toBe(false);
      // Never driver, truck or review details.
      for (const k of ["driver", "truck", "review_note", "reviewed_by", "notes", "snapshot"]) expect(JSON.stringify(all)).not.toContain(`"${k}"`);

      // By day: only the newer delivery day.
      const day = (await s.query<{ r: List }>("select public.portal_tickets($1, $2, $2) r", [slug, addDays(today, -1)])).rows[0].r;
      expect(day.tickets.map((t) => t.id)).toContain(newer.ids[0]);
      expect(day.tickets.map((t) => t.id)).not.toContain(older.ids[0]);
      // By site: only the order at the saved site.
      const bySite = (await s.query<{ r: List }>("select public.portal_tickets($1, null, null, $2) r", [slug, site])).rows[0].r;
      expect(bySite.tickets.map((t) => t.id)).toEqual([newer.ids[0]]);
      // A range given backwards is refused with a plain message.
      expect((await pgError(s.query("select public.portal_tickets($1, $2, $3)", [slug, today, addDays(today, -5)]))).code).toBe("22023");
    });
  });

  it("another customer of the same company, another company's site, staff and a company with Documents off see nothing", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      await s.asAdmin();
      const site = (await s.query<{ id: string }>("insert into public.customer_sites (company_id, customer_id, label, line1) values ($1, $2, 'Alice yard', '2 Test Rd') returning id", [TOP_LINE, ids.customerId])).rows[0].id;
      const alicesOrder = await deliveredOrder(s, owner, addDays(today, -2), [["accepted", 14]], site);
      await openPortal(s, TOP_LINE);
      const slug = await slugOf(s, TOP_LINE);
      await enroll(s, owner, ids.customerId);
      const bob = await enroll(s, owner, ids.contractCustomerId);

      // Bob (another customer of the same company): none of Alice's tickets, and her job site is refused as a filter.
      await s.as(bob);
      const bobs = (await s.query<{ r: List }>("select public.portal_tickets($1) r", [slug])).rows[0].r;
      expect(bobs.tickets.map((t) => t.id)).not.toContain(alicesOrder.ids[0]);
      expect((await pgError(s.query("select public.portal_tickets($1, null, null, $2)", [slug, site]))).code).toBe("P0002");

      // Staff of the company are not portal customers.
      await s.as(owner);
      expect((await pgError(s.query("select public.portal_tickets($1)", [slug]))).code).toBe("42501");

      // Another company's portal with Bob's account: refused.
      const other = await s.createCompany(`Tickets Other ${randomUUID().slice(0, 6)} (test)`);
      await openPortal(s, other);
      const otherSlug = await slugOf(s, other);
      await s.as(bob);
      expect((await pgError(s.query("select public.portal_tickets($1)", [otherSlug]))).code).toBe("42501");

      // Documents switched off by the company: the list is refused like the ticket copy.
      await s.asAdmin();
      await s.query("update public.portal_settings set feature_documents = false where company_id = $1", [TOP_LINE]);
      await s.as(bob);
      const off = await pgError(s.query("select public.portal_tickets($1)", [slug]));
      expect(["42501", "P0001"]).toContain(off.code);

      // Signed out: refused.
      await s.as(null);
      expect((await pgError(s.query("select public.portal_tickets($1)", [slug]))).code).toBe("42501");
    });
  });
});
