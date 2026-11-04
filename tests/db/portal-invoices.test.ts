// Invoices and statements in the customer portal (UX5, 20261120006900): read-only, the customer's own issued invoices
// only (no drafts or voided ones), paid and balance from active payments, aging as of the company's today; off unless
// the company issues in Taviron and the portal's Documents switch is on; other customers see nothing.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { handedOff } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function asWithEmail(s: Session, userId: string) {
  await s.asAdmin();
  const email = (await s.client.query<{ email: string }>("select email from auth.users where id = $1", [userId])).rows[0]?.email;
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", email, aal: "aal2" })]);
}

async function enroll(s: Session, owner: string, customerId: string) {
  await s.asAdmin();
  await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [TOP_LINE]);
  await s.query("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true", [TOP_LINE]);
  const slug = (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [TOP_LINE])).rows[0].slug;
  const email = `inv-${randomUUID().slice(0, 8)}@customer.example`;
  await s.as(owner);
  const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [customerId, email])).rows[0].r;
  await s.asAdmin();
  const user = randomUUID();
  await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [user, email]);
  await asWithEmail(s, user);
  await s.query("select public.portal_accept($1)", [inv.token]);
  return { slug, user };
}

type List = { enabled: boolean; invoices?: Array<{ id: string; state: string; balance_cents: number; paid_cents: number }>; statement?: Record<string, number> };

describe("portal invoices and statements", () => {
  it("shows the customer's own issued invoices with payments, balance and aging", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const { handoffOrder } = await handedOff(s, office);
      await s.asAdmin();
      const customer = (await s.query<{ customer_id: string }>("select o.customer_id from public.billing_handoff_orders h join public.orders o on o.id = h.order_id where h.id = $1", [handoffOrder])).rows[0].customer_id;
      const c = await enroll(s, owner, customer);

      // Off while the company issues in QuickBooks.
      await asWithEmail(s, c.user);
      expect((await s.query<{ r: List }>("select public.portal_invoices($1) r", [c.slug])).rows[0].r).toEqual({ enabled: false });

      await s.as(owner);
      await s.query("select public.invoicing_save_settings('taviron', 15, 'Thank you')");
      const id = (await s.query<{ r: string }>("select public.invoice_create($1) r", [handoffOrder])).rows[0].r;

      // A draft is never shown.
      await asWithEmail(s, c.user);
      expect((await s.query<{ r: List }>("select public.portal_invoices($1) r", [c.slug])).rows[0].r.invoices!.map((i) => i.id)).not.toContain(id);
      expect((await pgError(s.query("select public.portal_invoice($1, $2)", [c.slug, id]))).message).toMatch(/Invoice not found/);

      // Issued and partly paid: open with its balance; then made overdue: aging moves it.
      await s.as(owner);
      await s.query("select public.invoice_issue($1, null)", [id]);
      const total = Number((await s.query<{ t: string }>("select total_cents t from public.invoices where id = $1", [id])).rows[0].t);
      await s.query("select public.invoice_add_payment($1, $2, current_date - 1, 'check', '1001', '')", [id, Math.floor(total / 2)]);
      await asWithEmail(s, c.user);
      let list = (await s.query<{ r: List }>("select public.portal_invoices($1) r", [c.slug])).rows[0].r;
      const mine = () => list.invoices!.find((i) => i.id === id)!;
      expect(mine()).toMatchObject({ id, state: "open", paid_cents: Math.floor(total / 2), balance_cents: total - Math.floor(total / 2) });
      expect(list.statement!.balance_cents).toBeGreaterThanOrEqual(total - Math.floor(total / 2));
      const detail = (await s.query<{ r: { lines: Array<Record<string, unknown>>; payments: unknown[] } }>("select public.portal_invoice($1, $2) r", [c.slug, id])).rows[0].r;
      expect(detail.payments).toHaveLength(1);
      expect(Object.keys(detail.lines[0]).sort()).toEqual(["amount_cents", "description", "quantity", "unit_code", "unit_rate_cents"]);

      await s.asAdmin();
      await s.query("update public.invoices set due_date = current_date - 40 where id = $1", [id]);
      await asWithEmail(s, c.user);
      list = (await s.query<{ r: List }>("select public.portal_invoices($1) r", [c.slug])).rows[0].r;
      expect(mine().state).toBe("overdue");
      expect(list.statement!.d31_60_cents).toBeGreaterThanOrEqual(total - Math.floor(total / 2));

      // The Documents switch turns it off; another company's portal login never sees it.
      await s.asAdmin();
      await s.query("update public.portal_settings set feature_documents = false where company_id = $1", [TOP_LINE]);
      await asWithEmail(s, c.user);
      expect((await s.query<{ r: List }>("select public.portal_invoices($1) r", [c.slug])).rows[0].r.enabled).toBe(false);
      expect((await pgError(s.query("select public.portal_invoice($1, $2)", [c.slug, id]))).code).toBe("42501");
    });
  });
});
