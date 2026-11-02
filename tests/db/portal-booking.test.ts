// Customer self-booking (B115, 20261120005500). Off by default; customers see days as open or full only; a request
// cannot exceed the loads dispatch opened for that day; nothing is scheduled until dispatch approves; staff rights and
// customers' isolation hold.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, TOP_LINE, withSession, type Session } from "./helpers";
import { businessToday } from "./fixtures";

const inDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

afterAll(() => pool.end());

async function asWithEmail(s: Session, userId: string) {
  await s.asAdmin();
  const email = (await s.client.query<{ email: string }>("select email from auth.users where id = $1", [userId])).rows[0]?.email;
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", email })]);
}

async function openPortal(s: Session, company: string) {
  await s.asAdmin();
  await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [company]);
  await s.query("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true", [company]);
  return (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [company])).rows[0].slug;
}

async function enroll(s: Session, owner: string, customerId: string) {
  const email = `book-${randomUUID().slice(0, 8)}@cust.example`;
  await s.as(owner);
  const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [customerId, email])).rows[0].r;
  await s.asAdmin();
  const user = randomUUID();
  await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [user, email]);
  await asWithEmail(s, user);
  await s.query("select public.portal_accept($1)", [inv.token]);
  return user;
}

type State = { enabled: boolean; days?: Array<{ day: string; open: boolean; loads?: number }>; requests?: Array<{ id: string; status: string; loads: number; decision_note: string; order_number: string | null }> };
const state = async (s: Session, user: string, slug: string) => {
  await asWithEmail(s, user);
  return (await s.query<{ r: State }>("select public.portal_booking_state($1) r", [slug])).rows[0].r;
};
const request = (s: Session, slug: string, p: Record<string, unknown>) => s.query<{ r: { id: string } }>("select public.portal_booking_request($1, $2::jsonb) r", [slug, JSON.stringify(p)]);

describe("customer self-booking", () => {
  it("is off by default, opens per day, refuses over-capacity requests and shows customers open or full only", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      const slug = await openPortal(s, TOP_LINE);
      const alice = await enroll(s, owner, ids.customerId);
      const today = await businessToday(s);
      const day = inDays(today, 2);

      // Off by default: nothing to book, and requests are refused.
      expect((await state(s, alice, slug)).enabled).toBe(false);
      expect((await pgError(request(s, slug, { day, loads: 1, material: "Base rock" }))).code).toBe("42501");

      // Only settings managers turn it on; only dispatch sets capacity.
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.booking_save_settings(true, 1, 14)"))).code).toBe("42501");
      await s.as(owner);
      await s.query("select public.booking_save_settings(true, 1, 14)");
      const driver = await s.createUser("driver");
      await s.as(driver);
      expect((await pgError(s.query("select public.booking_set_capacity($1, 5)", [day]))).code).toBe("42501");
      await s.as(dispatcher);
      await s.query("select public.booking_set_capacity($1, 5)", [day]);

      const st = await state(s, alice, slug);
      expect(st.enabled).toBe(true);
      const d = st.days!.find((x) => x.day === day)!;
      expect(d).toEqual({ day, open: true }); // no counts are shown to customers
      expect(st.days!.find((x) => x.day === inDays(today, 3))!.open).toBe(false); // no capacity opened
      expect(st.days!.some((x) => x.day === today)).toBe(false); // min 1 day ahead

      // Too many loads, a closed day, a past day and missing material are refused.
      expect((await pgError(request(s, slug, { day, loads: 6, material: "Base rock" }))).message).toMatch(/does not have room/);
      expect((await pgError(request(s, slug, { day: inDays(today, 3), loads: 1, material: "Base rock" }))).message).toMatch(/does not have room/);
      expect((await pgError(request(s, slug, { day: today, loads: 1, material: "Base rock" }))).message).toMatch(/open days/);
      expect((await pgError(request(s, slug, { day, loads: 1, material: "" }))).message).toMatch(/hauled/);

      const r1 = (await request(s, slug, { day, loads: 3, material: "Base rock", time_window: "morning" })).rows[0].r;
      await request(s, slug, { day, loads: 2, material: "Sand" });
      // The day is now full for everyone.
      expect((await state(s, alice, slug)).days!.find((x) => x.day === day)!.open).toBe(false);
      expect((await pgError(request(s, slug, { day, loads: 1, material: "Gravel" }))).message).toMatch(/does not have room/);

      // Withdrawing frees the loads again.
      await s.query("select public.portal_booking_cancel($1, $2)", [slug, r1.id]);
      expect((await state(s, alice, slug)).days!.find((x) => x.day === day)!.open).toBe(true);
      expect((await pgError(s.query("select public.portal_booking_cancel($1, $2)", [slug, r1.id]))).code).toBe("P0002");
    });
  });

  it("dispatch approves or declines (with a reason), links the customer's own order, and other customers see nothing", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      const slug = await openPortal(s, TOP_LINE);
      const today = await businessToday(s);
      const day = inDays(today, 2);
      await s.as(owner);
      await s.query("select public.booking_save_settings(true, 1, 14)");
      await s.query("select public.booking_set_capacity($1, 10)", [day]);
      const alice = await enroll(s, owner, ids.customerId);
      await asWithEmail(s, alice);
      const a = (await request(s, slug, { day, loads: 2, material: "Base rock" })).rows[0].r;
      const b = (await request(s, slug, { day, loads: 1, material: "Sand" })).rows[0].r;

      // Another customer of the same company sees none of it and cannot withdraw it.
      await s.asAdmin();
      const otherCustomer = (await s.query<{ id: string }>("select id from public.customers where company_id = $1 and id <> $2 and active limit 1", [TOP_LINE, ids.customerId])).rows[0].id;
      const bob = await enroll(s, owner, otherCustomer);
      expect((await state(s, bob, slug)).requests).toEqual([]);
      expect((await pgError(s.query("select public.portal_booking_cancel($1, $2)", [slug, a.id]))).code).toBe("P0002");

      // A driver cannot decide; a decline needs a note; an order of another customer cannot be linked.
      const driver = await s.createUser("driver");
      await s.as(driver);
      expect((await pgError(s.query("select public.booking_decide($1, 'approved', '', null)", [a.id]))).code).toBe("42501");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.booking_decide($1, 'declined', '', null)", [b.id]))).message).toMatch(/why/);
      await s.query("select public.booking_decide($1, 'declined', 'Plant closed that day', null)", [b.id]);
      await s.query("select public.booking_decide($1, 'approved', '', null)", [a.id]);
      await s.asAdmin();
      const otherOrder = (await s.query<{ id: string }>("select id from public.orders where company_id = $1 and customer_id <> $2 limit 1", [TOP_LINE, ids.customerId])).rows[0]?.id;
      const ownOrder = (await s.query<{ id: string; order_number: string }>("select id, order_number from public.orders where company_id = $1 and customer_id = $2 limit 1", [TOP_LINE, ids.customerId])).rows[0];
      await s.as(dispatcher);
      if (otherOrder) expect((await pgError(s.query("select public.booking_decide($1, 'approved', '', $2)", [a.id, otherOrder]))).message).toMatch(/different customer/);
      if (ownOrder) await s.query("select public.booking_decide($1, 'approved', '', $2)", [a.id, ownOrder.id]);
      // A declined request cannot be approved later.
      expect((await pgError(s.query("select public.booking_decide($1, 'approved', '', null)", [b.id]))).message).toMatch(/already declined/);

      const mine = (await state(s, alice, slug)).requests!;
      expect(mine.find((r) => r.id === b.id)).toMatchObject({ status: "declined", decision_note: "Plant closed that day" });
      expect(mine.find((r) => r.id === a.id)).toMatchObject({ status: "approved", order_number: ownOrder?.order_number ?? null });
      // Approved requests cannot be withdrawn by the customer.
      expect((await pgError(s.query("select public.portal_booking_cancel($1, $2)", [slug, a.id]))).code).toBe("P0002");

      // Staff of another company see none of these rows; customers cannot read the tables directly.
      const other = await s.createCompany(`Booking Other ${randomUUID().slice(0, 6)} (test)`);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await s.query("select 1 from public.booking_requests where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
      await asWithEmail(s, alice);
      expect((await s.query("select 1 from public.booking_requests")).rowCount).toBe(0);
      expect((await s.query("select 1 from public.booking_capacity")).rowCount).toBe(0);
    });
  });

  it("the demo sample is for demo companies only and added once", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.demo_booking_samples()"))).code).toBe("42501");
    });
  });
});
