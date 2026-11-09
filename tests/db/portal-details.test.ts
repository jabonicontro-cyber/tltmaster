// Customer portal details (migration 20261120011500), read only through portal_* functions: the support form's ticket
// options carry each ticket's delivered time, quantity and unit; portal_sites lists each site's notes still waiting for
// the office (fields, photo count, when sent). Another customer of the same company sees none of it. Fictional data,
// rolled back.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { TOP_LINE, pool, sampleIds, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function portalUser(s: Session, owner: string, customerId: string) {
  const email = `details-${randomUUID().slice(0, 8)}@customer.example`;
  await s.as(owner);
  const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [customerId, email])).rows[0].r;
  await s.asAdmin();
  const user = randomUUID();
  await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [user, email]);
  const as = async () => {
    await s.as(user);
    await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", email, aal: "aal2" })]);
  };
  await as();
  await s.query("select public.portal_accept($1)", [inv.token]);
  return as;
}

type TicketOption = { id: string; label: string; delivered_at: string | null; quantity: number | null; unit: string };
type Site = { id: string; pending: number; pending_notes: Array<{ id: string; gate_code: string; drop_spot: string; contact_name: string; contact_phone: string; notes: string; photos: number; created_at: string }> };

describe("portal ticket and site details", () => {
  it("shows the customer's own tickets with date and quantity, and their waiting site notes", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const ids = await sampleIds(s);
      const today = await businessToday(s);
      const yesterday = addDays(today, -1);
      const f = await fleet(s, office, yesterday);
      const order = await scheduledOrder(s, office, addDays(today, -2), today, addDays(today, -2));
      const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);
      await s.as(office);
      const ticket = (await s.query<{ r: { ticket_id: string; ticket_number: string } }>("select public.submit_delivery_ticket($1::jsonb) r", [JSON.stringify({
        load_id: load.load_id, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30", quantity: "14.1", unit_code: "ton",
        external_reference: `SC-${randomUUID().slice(0, 8)}`,
      })])).rows[0].r;

      await s.asAdmin();
      await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [TOP_LINE]);
      await s.query("insert into public.portal_settings (company_id, enabled, feature_orders, feature_support) values ($1, true, true, true) on conflict (company_id) do update set enabled = true, feature_orders = true, feature_support = true", [TOP_LINE]);
      const slug = (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [TOP_LINE])).rows[0].slug;
      let siteId = (await s.query<{ site_id: string | null }>("select site_id from public.orders where id = $1", [order.id])).rows[0].site_id;
      if (!siteId) {
        siteId = (await s.query<{ id: string }>("insert into public.customer_sites (company_id, customer_id, label, line1) values ($1, $2, 'Details site', '1 Test Rd') returning id", [TOP_LINE, ids.customerId])).rows[0].id;
      }
      const otherCustomer = (await s.query<{ id: string }>("insert into public.customers (company_id, name) values ($1, 'Other customer (details test)') returning id", [TOP_LINE])).rows[0].id;
      await s.query("insert into public.customer_sites (company_id, customer_id, label, line1) values ($1, $2, 'Other site', '2 Other Rd')", [TOP_LINE, otherCustomer]);

      // The customer: the ticket option has its delivery time, quantity and unit.
      const mine = await portalUser(s, owner, ids.customerId);
      const options = (await s.query<{ r: { tickets: TicketOption[] } }>("select public.portal_support_link_options($1) r", [slug])).rows[0].r;
      const opt = options.tickets.find((t) => t.id === ticket.ticket_id)!;
      expect(opt).toMatchObject({ label: ticket.ticket_number });
      expect(Number(opt.quantity)).toBe(14.1);
      expect(opt.unit.length).toBeGreaterThan(0);
      expect(opt.delivered_at).not.toBeNull();

      // A note sent with two photos is listed as waiting, with its fields, after a reload.
      const note = (await s.query<{ r: string }>("select public.portal_site_info_submit($1, $2, '1234#', 'Back lot', 'Sam', '555-0100', 'Gate closes at 4') r", [slug, siteId])).rows[0].r;
      await s.query("select public.portal_site_photo_begin($1, $2, 'image/jpeg', 1000)", [slug, note]);
      await s.query("select public.portal_site_photo_begin($1, $2, 'image/png', 1000)", [slug, note]);
      const sites = (await s.query<{ r: Site[] }>("select public.portal_sites($1) r", [slug])).rows[0].r;
      const site = sites.find((x) => x.id === siteId)!;
      expect(site.pending).toBe(1);
      expect(site.pending_notes).toHaveLength(1);
      expect(site.pending_notes[0]).toMatchObject({ id: note, gate_code: "1234#", drop_spot: "Back lot", contact_name: "Sam", contact_phone: "555-0100", notes: "Gate closes at 4", photos: 2 });
      expect(site.pending_notes[0].created_at).toBeTruthy();

      // Once the office decides, the note is no longer waiting.
      await s.asAdmin();
      await s.query("update public.site_info_submissions set status = 'declined', reviewed_at = now() where id = $1", [note]);
      await mine();
      expect((await s.query<{ r: Site[] }>("select public.portal_sites($1) r", [slug])).rows[0].r.find((x) => x.id === siteId)!.pending_notes).toEqual([]);
      await s.asAdmin();
      await s.query("update public.site_info_submissions set status = 'pending', reviewed_at = null where id = $1", [note]);

      // Another customer of the same company: none of the first customer's tickets, sites or notes.
      const theirs = await portalUser(s, owner, otherCustomer);
      await theirs();
      const other = (await s.query<{ r: { tickets: TicketOption[] } }>("select public.portal_support_link_options($1) r", [slug])).rows[0].r;
      expect(other.tickets.map((t) => t.id)).not.toContain(ticket.ticket_id);
      const otherSites = (await s.query<{ r: Site[] }>("select public.portal_sites($1) r", [slug])).rows[0].r;
      expect(otherSites.map((x) => x.id)).not.toContain(siteId);
      expect(otherSites.flatMap((x) => x.pending_notes.map((n) => n.id))).not.toContain(note);
    });
  });
});
