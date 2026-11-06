// Truck-day jobs (UX11, migration 20261120008600): an order runs as N trucks for the day; each truck is a load slot
// assigned like any load; dispatch, the slot's own driver or the customer's site contact (portal) releases it; truck-hours
// are computed from the company's setting (off until set) with an optional minimum and shortfall rule.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { assign, businessToday, fleet, scheduledOrder } from "./fixtures";
import { pgError, pool, sampleIds, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function asWithEmail(s: Session, userId: string) {
  await s.asAdmin();
  const email = (await s.client.query<{ email: string }>("select email from auth.users where id = $1", [userId])).rows[0]?.email;
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", email })]);
}

async function portalCustomer(s: Session, owner: string, customerId: string) {
  await s.asAdmin();
  await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [TOP_LINE]);
  await s.query("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true", [TOP_LINE]);
  const email = `site-${randomUUID().slice(0, 6)}@cust.example`;
  const id = randomUUID();
  await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, email]);
  await s.as(owner);
  const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [customerId, email])).rows[0].r;
  await asWithEmail(s, id);
  await s.query("select public.portal_accept($1)", [inv.token]);
  return id;
}

type Hours = { basis: string | null; trucks: Array<{ load_id: string; hours: number | null; billable: number | null; short: boolean; missing: string | null; release_source: string | null; trips: number }> };

describe("truck-day jobs", () => {
  it("plans trucks for a day, releases them by driver, dispatch or site contact, and computes truck-hours from the setting", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const today = await businessToday(s);
      const order = await scheduledOrder(s, owner, today);
      const f = await fleet(s, owner, today);

      // Off by default: a loads order cannot plan truck-day slots; loads + hours is refused.
      await s.as(owner);
      expect((await pgError(s.query("select public.truck_day_plan($1, $2, 2, '00:00', '23:59')", [order.id, today]))).message).toMatch(/set number of loads/);
      expect((await pgError(s.query("select public.set_order_job_type($1, 'loads', 'hours')", [order.id]))).code).toBe("22023");
      await s.query("select public.set_order_job_type($1, 'truck_day', 'hours')", [order.id]);
      // A dispatcher cannot change how an order runs (orders.edit) but plans the trucks.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.set_order_job_type($1, 'loads', 'tickets')", [order.id]))).code).toBe("42501");
      const plan = (await s.query<{ r: { load_ids: string[]; count: number } }>("select public.truck_day_plan($1, $2, 2, '00:00', '23:59', 'Bring the tri-axles') r", [order.id, today])).rows[0].r;
      expect(plan.count).toBe(2);
      const [slot1, slot2] = plan.load_ids;
      await s.asAdmin();
      expect((await s.query("select 1 from public.order_loads where id = any($1::uuid[]) and planned_quantity is null", [plan.load_ids])).rowCount).toBe(2);

      await s.as(owner);
      await assign(s, slot1, f.t1, null, f.d1);
      await assign(s, slot2, f.t2, null, f.d2);
      const driverUser = await s.createUser("driver");
      const otherDriver = await s.createUser("driver");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d3, otherDriver]);

      // Another driver cannot release this truck; its own driver can, once; the assignment ends now (truck freed).
      await s.as(otherDriver);
      expect((await pgError(s.query("select public.truck_day_release($1, '')", [slot1]))).code).toBe("42501");
      await s.as(driverUser);
      const before = (await s.query<{ r: Array<{ load_id: string; released_at: string | null; started: boolean }> }>("select public.driver_truck_days() r")).rows[0].r;
      expect(before).toEqual([expect.objectContaining({ load_id: slot1, released_at: null, started: true })]);
      await s.query("select public.truck_day_release($1, 'Pit closed early')", [slot1]);
      expect((await s.query<{ r: Array<{ released_at: string | null }> }>("select public.driver_truck_days() r")).rows[0].r[0].released_at).not.toBeNull();
      expect((await pgError(s.query("select public.truck_day_release($1, '')", [slot1]))).message).toMatch(/already released/);
      await s.asAdmin();
      const asg = (await s.query<{ ended: boolean; source: string }>(
        "select a.ends_at <= now() as ended, l.release_source as source from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id where a.load_id = $1 and a.status = 'active'", [slot1])).rows[0];
      expect(asg).toEqual({ ended: true, source: "driver" });

      // The customer's site contact sees today's trucks (unit only) and releases the other; another customer cannot.
      const site = await portalCustomer(s, owner, ids.customerId);
      const stranger = await portalCustomer(s, owner, ids.contractCustomerId);
      await s.asAdmin();
      const slug = (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [TOP_LINE])).rows[0].slug;
      await asWithEmail(s, stranger);
      expect((await pgError(s.query("select public.portal_truck_release($1, $2)", [slug, slot2]))).code).toBe("P0002");
      await asWithEmail(s, site);
      const trucks = (await s.query<{ r: Array<Record<string, unknown>> }>("select public.portal_order_trucks($1, $2) r", [slug, order.id])).rows[0].r;
      expect(trucks).toHaveLength(2);
      expect(JSON.stringify(trucks)).not.toContain("Driver");
      await s.query("select public.portal_truck_release($1, $2)", [slug, slot2]);

      // Truck-hours: off until the company sets which hours count.
      await s.as(owner);
      let h = (await s.query<{ r: Hours }>("select public.truck_day_hours($1) r", [order.id])).rows[0].r;
      expect(h.basis).toBeNull();
      expect(h.trucks.map((t) => t.missing)).toEqual(["off", "off"]);
      expect(h.trucks.map((t) => t.release_source).sort()).toEqual(["driver", "site"]);
      // Only billing.manage sets it; a minimum of 24 h with "bill the minimum" bills 24 for a shorter day.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.save_truck_hours_settings('scheduled', 8, 'review')"))).code).toBe("42501");
      await s.as(owner);
      await s.query("select public.save_truck_hours_settings('scheduled', 24, 'bill_minimum')");
      h = (await s.query<{ r: Hours }>("select public.truck_day_hours($1) r", [order.id])).rows[0].r;
      for (const t of h.trucks) {
        expect(t.missing).toBeNull();
        expect(t.hours).toBeGreaterThan(0);
        expect(t).toMatchObject({ short: true, billable: 24 });
      }
      // "Flag for review" bills the hours worked and keeps the shortfall visible.
      await s.query("select public.save_truck_hours_settings('scheduled', 24, 'review')");
      h = (await s.query<{ r: Hours }>("select public.truck_day_hours($1) r", [order.id])).rows[0].r;
      for (const t of h.trucks) expect(t.billable).toBe(t.hours);
      // "Arrived" without a recorded arrival gives no hours (never guessed).
      await s.query("select public.save_truck_hours_settings('arrived', null, 'review')");
      h = (await s.query<{ r: Hours }>("select public.truck_day_hours($1) r", [order.id])).rows[0].r;
      expect(h.trucks.every((t) => t.hours === null && t.missing === "no_arrival")).toBe(true);
    });
  });

  it("a truck-day order with delivery tickets keeps its job type; a truck not yet started cannot be released", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const order = await scheduledOrder(s, owner, today);
      const f = await fleet(s, owner, today);
      await s.as(owner);
      await s.query("select public.set_order_job_type($1, 'truck_day', 'tickets')", [order.id]);
      const slot = (await s.query<{ r: { load_ids: string[] } }>("select public.truck_day_plan($1, $2, 1, '00:00', '23:59') r", [order.id, today])).rows[0].r.load_ids[0];
      await assign(s, slot, f.t1, null, f.d1);
      await s.as(owner);
      // Several tickets (trips) against one truck slot.
      for (const n of [1, 2]) {
        await s.query("select public.submit_delivery_ticket($1::jsonb)", [JSON.stringify({
          load_id: slot, order_line_id: order.materialLine, delivered_date: today, delivered_time: "00:30", quantity: String(20 + n), unit_code: "ton", external_reference: `TD-${randomUUID().slice(0, 8)}`,
        })]);
      }
      expect((await pgError(s.query("select public.set_order_job_type($1, 'loads', 'tickets')", [order.id]))).message).toMatch(/already has delivery tickets/);
      // Billing basis may still change within truck-day.
      await s.query("select public.set_order_job_type($1, 'truck_day', 'hours')", [order.id]);
      const h = (await s.query<{ r: Hours }>("select public.truck_day_hours($1) r", [order.id])).rows[0].r;
      expect(h.trucks[0].trips).toBe(2);
      expect(h.trucks[0].missing).toMatch(/off|not_released/);

      // A slot later today that has not started yet cannot be released.
      const later = (await s.query<{ r: { load_ids: string[] } }>("select public.truck_day_plan($1, $2, 1, '23:58', '23:59') r", [order.id, today])).rows[0].r.load_ids[0];
      await assign(s, later, f.t2, null, f.d2);
      await s.as(owner);
      expect((await pgError(s.query("select public.truck_day_release($1, '')", [later]))).message).toMatch(/has not started yet/);
    });
  });
});
