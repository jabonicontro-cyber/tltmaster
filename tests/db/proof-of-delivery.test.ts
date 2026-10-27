// Proof of delivery (B98, migration 20261120004000): the ticket's own driver records where it was sent, once, within
// 15 minutes; the office reads it with the ticket; the customer's portal shows it only for their own confirmed tickets;
// the demo sample function refuses real companies.
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

describe("proof of delivery", () => {
  it("records the position once from the ticket's driver, and the customer sees it on their confirmed ticket only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const order = await scheduledOrder(s, owner, today);
      const load = await planLoad(s, order.id, today, "08:00", "10:00", { planned_quantity: "20", unit_code: "ton" });
      const f = await fleet(s, owner, today);
      await s.as(owner);
      const a = await assign(s, load.load_id, f.t1, null, f.d1);
      const driverUser = await s.createUser("driver");
      const otherDriver = await s.createUser("driver");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);
      const company = (await s.query<{ c: string }>("select company_id c from public.orders where id = $1", [order.id])).rows[0].c;
      const ticket = async (createdBy: string, ageMinutes: number, status = "submitted") =>
        (await s.query<{ id: string }>(
          `insert into public.delivery_tickets (company_id, ticket_number, status, order_id, load_id, assignment_id, order_line_id, truck_id, driver_id, delivered_at, quantity, unit_code, snapshot, created_by, created_at)
           select $1, 'T-' || substr(md5(random()::text), 1, 6), $7::public.ticket_status, $2, $3, $4, (select id from public.order_lines where order_id = $2 limit 1), $5, $6, now(), 20, 'ton', '{}'::jsonb, $8, now() - make_interval(mins => $9)
           returning id`,
          [company, order.id, load.load_id, a, f.t1, f.d1, status, createdBy, ageMinutes],
        )).rows[0].id;
      const fresh = await ticket(driverUser, 1);
      const old = await ticket(driverUser, 30);

      const record = (t: string) => s.query<{ r: boolean }>("select public.driver_record_ticket_location($1, 41.123456, -87.654321, 9) r", [t]);
      await s.as(otherDriver);
      expect((await pgError(record(fresh))).message).toMatch(/Ticket not found/);
      await s.as(driverUser);
      expect((await record(fresh)).rows[0].r).toBe(true);
      expect((await record(fresh)).rows[0].r).toBe(false); // once
      expect((await pgError(record(old))).message).toMatch(/when the ticket is submitted/);
      expect((await pgError(s.query("select public.driver_record_ticket_location($1, 95, 0, null)", [fresh]))).message).toMatch(/not valid/);

      await s.as(owner);
      expect((await s.query("select latitude::float8 lat from public.ticket_locations where ticket_id = $1", [fresh])).rows).toEqual([{ lat: 41.123456 }]);

      // The customer: proof only for a confirmed ticket of their own.
      await s.asAdmin();
      await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [company]);
      await s.query("insert into public.portal_settings (company_id, enabled, feature_documents) values ($1, true, true) on conflict (company_id) do update set enabled = true, feature_documents = true", [company]);
      const slug = (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [company])).rows[0].slug;
      const customerId = (await s.query<{ c: string }>("select customer_id c from public.orders where id = $1", [order.id])).rows[0].c;
      await s.as(owner);
      const email = `pod-${randomUUID().slice(0, 8)}@customer.example`;
      const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [customerId, email])).rows[0].r;
      await s.asAdmin();
      const customer = randomUUID();
      await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [customer, email]);
      await asWithEmail(s, customer);
      await s.query("select public.portal_accept($1)", [inv.token]);
      const proof = async () => (await s.query<{ r: { location: { lat: number } | null; photos: string[] } }>("select public.portal_ticket_proof($1, $2) r", [slug, fresh])).rows[0].r;
      expect((await proof()).location).toBeNull(); // not confirmed yet
      await s.asAdmin();
      await s.query("update public.delivery_tickets set status = 'accepted', reviewed_at = now() where id = $1", [fresh]);
      await asWithEmail(s, customer);
      expect(Number((await proof()).location?.lat)).toBeCloseTo(41.123456, 5);
      expect((await proof()).photos).toEqual([]);
      expect((await s.query<{ r: string | null }>("select public.portal_ticket_photo($1, $2) r", [slug, randomUUID()])).rows[0].r).toBeNull();

      // A real company's owner cannot add demo positions.
      await s.as(owner);
      expect((await pgError(s.query("select public.demo_ticket_locations()"))).message).toMatch(/only added to a demo company/);
    });
  });
});
