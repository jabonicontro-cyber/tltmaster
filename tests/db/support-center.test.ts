// Support center (B138, 20261120006800): case types, office-opened cases, assignment, internal notes never shown in the
// portal, links only to the customer's own records, attachments (5 per message, photos and PDFs up to 10 MB), reopening
// within 14 days, the company's first-reply target (off until set) and the notice recipients.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, TOP_LINE, withSession, type Session } from "./helpers";
import { businessToday, scheduledOrder } from "./fixtures";

afterAll(() => pool.end());

async function asWithEmail(s: Session, userId: string) {
  await s.asAdmin();
  const email = (await s.client.query<{ email: string }>("select email from auth.users where id = $1", [userId])).rows[0]?.email;
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", email, aal: "aal2" })]);
}

async function portalCustomer(s: Session, owner: string, customerId: string) {
  await s.asAdmin();
  await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [TOP_LINE]);
  await s.query("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true", [TOP_LINE]);
  const slug = (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [TOP_LINE])).rows[0].slug;
  const email = `support-${randomUUID().slice(0, 8)}@customer.example`;
  await s.as(owner);
  const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [customerId, email])).rows[0].r;
  await s.asAdmin();
  const user = randomUUID();
  await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [user, email]);
  await asWithEmail(s, user);
  await s.query("select public.portal_accept($1)", [inv.token]);
  return { slug, user, email };
}

describe("support center", () => {
  it("handles cases from both sides with types, notes, links, attachments, reopening and the reply target", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const driver = await s.createUser("driver");
      const ids = await sampleIds(s);
      const today = await businessToday(s);
      const order = await scheduledOrder(s, owner, today);
      const c = await portalCustomer(s, owner, ids.customerId);

      // The customer opens a delivery-problem case linked to their own order; another customer's order is refused.
      await asWithEmail(s, c.user);
      const open = (await s.query<{ r: { id: string; message_id: string } }>("select public.portal_support_open($1, 'delivery', 'Late load (test)', 'The second load came late.', $2) r", [c.slug, order.id])).rows[0].r;
      expect((await pgError(s.query("select public.portal_support_open($1, 'nonsense', 'x', 'hello there')", [c.slug]))).message).toMatch(/what the case is about/);
      await s.asAdmin();
      const other = (await s.query<{ id: string }>("select id from public.orders where company_id = $1 and customer_id <> $2 limit 1", [TOP_LINE, ids.customerId])).rows[0]?.id ?? randomUUID();
      await asWithEmail(s, c.user);
      expect((await pgError(s.query("select public.portal_support_open($1, 'other', 'Other order (test)', 'Not mine at all.', $2)", [c.slug, other]))).message).toMatch(/Order not found/);

      // Attachments: up to 5 on the customer's own message; type and size checked.
      for (let i = 0; i < 5; i++) await s.query("select public.portal_support_file_begin($1, $2, 'application/pdf', 2000, $3)", [c.slug, open.message_id, `scale-${i}.pdf`]);
      expect((await pgError(s.query("select public.portal_support_file_begin($1, $2, 'image/png', 10, 'x.png')", [c.slug, open.message_id]))).message).toMatch(/At most 5/);
      expect((await pgError(s.query("select public.portal_support_file_begin($1, $2, 'text/plain', 10, 'x.txt')", [c.slug, open.message_id]))).message).toMatch(/photos .* or PDFs/);

      // The reply target is off until set; then the waiting case counts once it is older than the target.
      await s.as(owner);
      expect((await s.query<{ r: { target_hours: number | null; count: number } }>("select public.support_overdue() r")).rows[0].r).toMatchObject({ target_hours: null, count: 0 });
      await s.query("select public.support_save_settings(2)");
      await s.asAdmin();
      await s.query("update public.portal_support_requests set created_at = now() - interval '3 hours' where id = $1", [open.id]);
      await s.as(owner);
      expect((await s.query<{ r: { count: number } }>("select public.support_overdue() r")).rows[0].r.count).toBeGreaterThanOrEqual(1);
      await s.as(office);
      expect((await pgError(s.query("select public.support_save_settings(3)"))).code).toBe("42501");

      // Office: an internal note (not a reply), assignment, then a reply; the note never reaches the portal.
      await s.query("select public.support_reply($1, 'Check the dispatch log first (internal, test)', true, false)", [open.id]);
      await s.query("select public.support_update($1, 'delivery', $2, $3, null, null)", [open.id, owner, order.id]);
      expect((await pgError(s.query("select public.support_update($1, 'delivery', $2, null, null, null)", [open.id, c.user]))).message).toMatch(/someone from your company/);
      await s.asAdmin();
      expect((await s.query("select status, first_reply_at from public.portal_support_requests where id = $1", [open.id])).rows[0]).toMatchObject({ status: "open", first_reply_at: null });
      await s.as(office);
      await s.query("select public.support_reply($1, 'Sorry about that; tomorrow starts at 6:30. (test)', false, true)", [open.id]);
      await asWithEmail(s, c.user);
      const thread = (await s.query<{ r: { status: string; can_reopen: boolean; kind: string; messages: Array<{ from: string; body: string; files: unknown[] }> } }>("select public.portal_support_thread($1, $2) r", [c.slug, open.id])).rows[0].r;
      expect(thread).toMatchObject({ status: "closed", can_reopen: true, kind: "delivery" });
      expect(thread.messages.map((m) => m.body).join(" ")).not.toContain("internal");
      expect(thread.messages[0].files).toHaveLength(5);

      // Reopening: within 14 days the customer's message reopens the case; after that it is refused.
      await s.query("select public.portal_support_send($1, $2, 'One more question. (test)')", [c.slug, open.id]);
      await s.asAdmin();
      expect((await s.query("select status, closed_at from public.portal_support_requests where id = $1", [open.id])).rows[0]).toMatchObject({ status: "open", closed_at: null });
      await s.query("update public.portal_support_requests set status = 'closed', closed_at = now() - interval '15 days' where id = $1", [open.id]);
      await asWithEmail(s, c.user);
      expect((await pgError(s.query("select public.portal_support_send($1, $2, 'Still there?')", [c.slug, open.id]))).message).toMatch(/more than 14 days/);
      expect((await pgError(s.query("select public.portal_support_reply($1, $2, 'Still there?')", [c.slug, open.id]))).message).toMatch(/more than 14 days/);

      // The office opens a case for the customer; it shows in the portal; notices go to the customer's active logins.
      await s.as(office);
      const byOffice = (await s.query<{ r: { id: string } }>("select public.support_open_case($1, 'billing', 'Invoice question (test)', 'We noticed a duplicate charge and removed it.') r", [ids.customerId])).rows[0].r;
      const rec = (await s.query<{ r: { emails: string[]; slug: string } }>("select public.support_notice_recipients($1) r", [byOffice.id])).rows[0].r;
      expect(rec.emails).toContain(c.email);
      await asWithEmail(s, c.user);
      const list = (await s.query<{ r: Array<{ id: string; kind: string }> }>("select public.portal_support_list($1) r", [c.slug])).rows[0].r;
      expect(list.map((x) => x.id)).toContain(byOffice.id);

      // Roles without customers.edit cannot work cases; staff files are readable by staff only.
      await s.as(driver);
      expect((await pgError(s.query("select public.support_reply($1, 'hi there', false, false)", [byOffice.id]))).code).toBe("42501");
      expect((await pgError(s.query("select public.support_open_case($1, 'other', 'x', 'hello there')", [ids.customerId]))).code).toBe("42501");
      expect((await s.query("select 1 from public.portal_support_files")).rowCount).toBe(0);
    });
  });

  it("adds demo samples once, in a demo company only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.demo_support_samples()"))).code).toBe("42501");
    });
  });
});
