// Customer portal (20261120000700). A portal account is not a membership: it opens no business table. Customers read
// and write only through portal_* functions, which derive company and customer from the signed-in account and refuse
// other customers' records, other companies, revoked accounts and companies whose portal is off or not entitled.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, saveQuote, TOP_LINE, withSession, type Session } from "./helpers";
import { businessToday, scheduledOrder } from "./fixtures";

const inDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

afterAll(() => pool.end());

/** Act as a signed-in person whose JWT carries their email (as GoTrue issues it). */
async function asWithEmail(s: Session, userId: string) {
  await s.asAdmin();
  const email = (await s.client.query<{ email: string }>("select email from auth.users where id = $1", [userId])).rows[0]?.email;
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", email })]);
}

async function customerUser(s: Session, email: string) {
  await s.asAdmin();
  const id = randomUUID();
  await s.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, email]);
  return id;
}

/** Entitle and enable the portal for a company (platform owner + company settings), as the superuser. */
async function openPortal(s: Session, company: string, extra: Record<string, unknown> = {}) {
  await s.asAdmin();
  await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [company]);
  await s.query(
    `insert into public.portal_settings (company_id, enabled, public_page, feature_tracking) values ($1, true, $2, $3)
     on conflict (company_id) do update set enabled = true, public_page = excluded.public_page, feature_tracking = excluded.feature_tracking`,
    [company, Boolean(extra.public_page), Boolean(extra.tracking)],
  );
}

async function slugOf(s: Session, company: string) {
  await s.asAdmin();
  return (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [company])).rows[0].slug;
}

/** Invite as the owner and accept as the customer; returns the customer user id. */
async function enroll(s: Session, owner: string, customerId: string, email: string) {
  await s.as(owner);
  const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [customerId, email])).rows[0].r;
  const user = await customerUser(s, email);
  await asWithEmail(s, user);
  await s.query("select public.portal_accept($1)", [inv.token]);
  return user;
}

describe("customer portal", () => {
  it("is off until entitled and enabled; staff cannot enable it without the entitlement", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const state = (await s.query<{ r: { entitled: boolean; open: boolean } }>("select public.portal_admin_state() r")).rows[0].r;
      expect(state.entitled).toBe(false);
      expect((await pgError(s.query("select public.portal_save_settings('{\"enabled\": true}'::jsonb)"))).code).toBe("42501");
      // A dispatcher cannot change portal settings at all.
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.portal_save_settings('{\"enabled\": false}'::jsonb)"))).code).toBe("42501");
      // Only the platform team sets the entitlement.
      await s.as(owner);
      expect((await pgError(s.query("select public.platform_portal_set_entitlement($1, true, 'x')", [TOP_LINE]))).code).toBe("42501");
    });
  });

  it("an invited customer sees only their own orders; another customer and another company see nothing of them", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      const order = await scheduledOrder(s, owner, inDays(await businessToday(s), 10));
      await openPortal(s, TOP_LINE);
      const slug = await slugOf(s, TOP_LINE);

      const alice = await enroll(s, owner, ids.customerId, `alice-${randomUUID().slice(0, 6)}@cust.example`);
      const bob = await enroll(s, owner, ids.contractCustomerId, `bob-${randomUUID().slice(0, 6)}@cust.example`);

      // A portal account opens no business table (it is not a membership).
      await s.as(alice);
      expect((await s.query("select 1 from public.orders")).rowCount).toBe(0);
      expect((await s.query("select 1 from public.customers")).rowCount).toBe(0);
      expect((await s.query("select 1 from public.portal_accounts")).rowCount).toBe(0);

      const mine = (await s.query<{ r: Array<{ id: string; number: string; status_label: string }> }>("select public.portal_orders($1) r", [slug])).rows[0].r;
      expect(mine.map((o) => o.id)).toContain(order.id);
      const detail = (await s.query<{ r: Record<string, unknown> }>("select public.portal_order($1, $2) r", [slug, order.id])).rows[0].r;
      expect(detail.status_label).toBe("Scheduled");
      // Never internal fields.
      for (const k of ["internal_notes", "scheduling_notes", "status_note", "driver", "truck"]) expect(JSON.stringify(detail)).not.toContain(`"${k}"`);

      // Bob (another customer of the same company) cannot open Alice's order, by id or in his list.
      await s.as(bob);
      expect((await pgError(s.query("select public.portal_order($1, $2)", [slug, order.id]))).code).toBe("P0002");
      const bobs = (await s.query<{ r: Array<{ id: string }> }>("select public.portal_orders($1) r", [slug])).rows[0].r;
      expect(bobs.map((o) => o.id)).not.toContain(order.id);

      // Alice cannot use her account at another company by changing the slug.
      const other = await s.createCompany(`Portal Other ${randomUUID().slice(0, 6)} (test)`);
      await openPortal(s, other);
      const otherSlug = await slugOf(s, other);
      await s.as(alice);
      expect((await pgError(s.query("select public.portal_context($1)", [otherSlug]))).code).toBe("42501");

      // A staff member of the company is not a portal customer.
      await s.as(owner);
      expect((await pgError(s.query("select public.portal_orders($1)", [slug]))).code).toBe("42501");

      // Revoked: refused immediately.
      await s.asAdmin();
      const acct = (await s.query<{ id: string }>("select id from public.portal_accounts where user_id = $1", [alice])).rows[0].id;
      await s.as(owner);
      await s.query("select public.portal_revoke($1)", [acct]);
      await s.as(alice);
      expect((await pgError(s.query("select public.portal_orders($1)", [slug]))).code).toBe("42501");

      // Turning the portal off closes it for everyone.
      await s.asAdmin();
      await s.query("update public.portal_settings set enabled = false where company_id = $1", [TOP_LINE]);
      await s.as(bob);
      expect((await pgError(s.query("select public.portal_context($1)", [slug]))).code).toBe("42501");
    });
  });

  it("invitations are single-use, expire, must match the signed-in email, and one email serves one customer", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      await openPortal(s, TOP_LINE);
      const email = `inv-${randomUUID().slice(0, 6)}@cust.example`;
      await s.as(owner);
      const inv = (await s.query<{ r: { token: string } }>("select public.portal_invite($1, null, $2) r", [ids.customerId, email])).rows[0].r;
      expect(inv.token).toMatch(/^[0-9a-f]{64}$/);
      // Stored only as a hash.
      await s.asAdmin();
      expect((await s.query("select 1 from public.portal_accounts where invite_hash = $1", [inv.token])).rowCount).toBe(0);
      // Same email for another customer: refused.
      await s.as(owner);
      expect((await pgError(s.query("select public.portal_invite($1, null, $2)", [ids.contractCustomerId, email.toUpperCase()]))).code).toBe("23505");
      // Anyone with the link can see whom it is for; nothing else.
      await s.as(null);
      const peek = (await s.query<{ r: { email: string; customer: string } }>("select public.portal_invite_peek($1) r", [inv.token])).rows[0].r;
      expect(peek.email).toBe(email);
      expect((await s.query<{ r: unknown }>("select public.portal_invite_peek($1) r", ["0".repeat(64)])).rows[0].r).toBeNull();
      // Wrong person.
      const mallory = await customerUser(s, `mallory-${randomUUID().slice(0, 6)}@cust.example`);
      await asWithEmail(s, mallory);
      expect((await pgError(s.query("select public.portal_accept($1)", [inv.token]))).code).toBe("42501");
      // Right person, once.
      const user = await customerUser(s, email);
      await asWithEmail(s, user);
      await s.query("select public.portal_accept($1)", [inv.token]);
      expect((await pgError(s.query("select public.portal_accept($1)", [inv.token]))).code).toBe("22023");
      // Expired invitation.
      await s.as(owner);
      const late = (await s.query<{ r: { id: string; token: string } }>("select public.portal_invite($1, null, $2) r", [ids.customerId, `late-${randomUUID().slice(0, 6)}@cust.example`])).rows[0].r;
      await s.asAdmin();
      await s.query("update public.portal_accounts set invite_expires_at = now() - interval '1 minute' where id = $1", [late.id]);
      const lateUser = await customerUser(s, (await s.query<{ email: string }>("select email from public.portal_accounts where id = $1", [late.id])).rows[0].email);
      await asWithEmail(s, lateUser);
      expect((await pgError(s.query("select public.portal_accept($1)", [late.token]))).code).toBe("22023");
    });
  });

  it("quote requests are de-duplicated; quote answers wait for staff; support threads stay with the customer", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      await openPortal(s, TOP_LINE);
      const slug = await slugOf(s, TOP_LINE);
      // A quote sent to Alice's company.
      await s.as(owner);
      const q = await saveQuote(s, {
        customer_id: ids.customerId, quote_date: "2026-10-01", valid_until: "2099-12-31", tax_rate_bp: 0,
        lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "20", unit_rate_cents: 1000 }],
      });
      await s.query("select public.mark_quote_sent($1, $2, 'Handed over')", [q.quote_id, q.edit_seq]);
      const alice = await enroll(s, owner, ids.customerId, `qa-${randomUUID().slice(0, 6)}@cust.example`);
      const bob = await enroll(s, owner, ids.contractCustomerId, `qb-${randomUUID().slice(0, 6)}@cust.example`);

      await s.as(alice);
      const one = (await s.query<{ r: { id: string; duplicate: boolean } }>("select public.portal_request_quote($1, $2::jsonb) r", [slug, JSON.stringify({ material: "Limestone", quantity: "30", unit: "ton" })])).rows[0].r;
      const two = (await s.query<{ r: { id: string; duplicate: boolean } }>("select public.portal_request_quote($1, $2::jsonb) r", [slug, JSON.stringify({ material: "limestone", quantity: "30", unit: "ton" })])).rows[0].r;
      expect(two).toEqual({ id: one.id, duplicate: true });

      const quotes = (await s.query<{ r: { quotes: Array<{ id: string; total_cents: number }> } }>("select public.portal_quotes($1) r", [slug])).rows[0].r;
      expect(quotes.quotes.map((x) => x.id)).toContain(q.quote_id);
      const full = (await s.query<{ r: Record<string, unknown> }>("select public.portal_quote($1, $2) r", [slug, q.quote_id])).rows[0].r;
      expect(JSON.stringify(full)).not.toContain("internal_notes");
      expect(full.can_respond).toBe(true);
      await s.query("select public.portal_quote_respond($1, $2, true, 'Alice Buyer', '')", [slug, q.quote_id]);
      // The quote is still "sent": a customer never changes its status directly.
      await s.asAdmin();
      expect((await s.query("select status from public.quotes where id = $1", [q.quote_id])).rows[0].status).toBe("sent");
      await s.as(alice);
      expect((await pgError(s.query("select public.portal_quote_respond($1, $2, true, 'Alice Buyer', '')", [slug, q.quote_id]))).code).toBe("23505");
      // Bob cannot see or answer it.
      await s.as(bob);
      expect((await pgError(s.query("select public.portal_quote($1, $2)", [slug, q.quote_id]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.portal_quote_respond($1, $2, false, 'Bob', 'no')", [slug, q.quote_id]))).code).toBe("P0002");

      // Staff confirm the acceptance through the normal workflow.
      await s.asAdmin();
      const resp = (await s.query<{ id: string }>("select id from public.portal_quote_responses where quote_id = $1", [q.quote_id])).rows[0].id;
      await s.as(owner);
      await s.query("select public.portal_quote_response_handle($1, true)", [resp]);
      await s.asAdmin();
      expect((await s.query("select status from public.quotes where id = $1", [q.quote_id])).rows[0].status).toBe("accepted");

      // Support: Alice's thread is hers; Bob cannot read or reply; staff replies are visible to Alice.
      await s.as(alice);
      const req = (await s.query<{ r: { id: string } }>("select public.portal_support_create($1, 'Gate code', 'What is the gate code for the site?', null) r", [slug])).rows[0].r.id;
      await s.as(bob);
      expect((await pgError(s.query("select public.portal_support_thread($1, $2)", [slug, req]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.portal_support_reply($1, $2, 'hi')", [slug, req]))).code).toBe("P0002");
      await s.as(owner);
      await s.query("select public.portal_staff_reply($1, 'It is 4412.', false)", [req]);
      await s.as(alice);
      const thread = (await s.query<{ r: { status: string; messages: Array<{ from: string }> } }>("select public.portal_support_thread($1, $2) r", [slug, req])).rows[0].r;
      expect(thread.status).toBe("answered");
      expect(thread.messages.map((m) => m.from)).toEqual(["customer", "staff"]);
    });
  });

  it("help articles: drafts stay private; the public page and tracking links show only what the company publishes", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const order = await scheduledOrder(s, owner, inDays(await businessToday(s), 12));
      await openPortal(s, TOP_LINE, { public_page: true, tracking: true });
      const slug = await slugOf(s, TOP_LINE);
      await s.as(owner);
      await s.query("select public.portal_help_save(null, 'Draft policy', 'Policies', 'Not yet', 'draft')");
      await s.query("select public.portal_help_save(null, 'How to order', 'Ordering', 'Call us.', 'published')");
      const link = (await s.query<{ r: { id: string; token: string } }>("select public.portal_tracking_create($1, 7) r", [order.id])).rows[0].r;
      await s.as(null);
      const help = (await s.query<{ r: Array<{ title: string }> }>("select public.portal_help($1) r", [slug])).rows[0].r;
      expect(help.map((a) => a.title)).toContain("How to order");
      expect(help.map((a) => a.title)).not.toContain("Draft policy");
      const tracked = (await s.query<{ r: Record<string, unknown> }>("select public.portal_track($1) r", [link.token])).rows[0].r;
      expect(tracked.number).toBe(order.number);
      expect(tracked).not.toHaveProperty("po");
      // Revoked links stop working.
      await s.as(owner);
      await s.query("select public.portal_tracking_revoke($1)", [link.id]);
      await s.as(null);
      expect((await s.query<{ r: unknown }>("select public.portal_track($1) r", [link.token])).rows[0].r).toBeNull();
      // Anonymous visitors cannot call customer functions.
      expect((await pgError(s.query("select public.portal_orders($1)", [slug]))).code).toBe("42501");
      // Without the public page, help needs a signed-in customer.
      await s.asAdmin();
      await s.query("update public.portal_settings set public_page = false where company_id = $1", [TOP_LINE]);
      await s.as(null);
      expect((await pgError(s.query("select public.portal_help($1)", [slug]))).code).toBe("42501");
    });
  });

  it("Testing Lab preview: platform admins only, demo companies only, one customer, and it expires", async () => {
    await withSession(async (s) => {
      // A platform admin.
      const admin = await s.createUser(null, { membership: false });
      await s.asAdmin();
      const adminEmail = (await s.query<{ email: string }>("select email from auth.users where id = $1", [admin])).rows[0].email;
      await s.query("set local role service_role");
      await s.query("select public.platform_admin_grant($1, 'test')", [adminEmail]);
      await s.asAdmin();
      // A real company with an open portal: never previewable.
      const ids = await sampleIds(s);
      await openPortal(s, TOP_LINE);
      await s.as(admin);
      expect((await pgError(s.query("select public.platform_portal_preview_start($1, $2)", [TOP_LINE, ids.customerId]))).code).toBe("42501");
      // A demo company.
      const demo = await s.createCompany(`Preview Demo ${randomUUID().slice(0, 6)} (test)`);
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      const owner = await s.createUser("owner", { companyId: demo });
      await s.as(owner);
      const cust = (await s.query<{ id: string }>("insert into public.customers (name) values ('Preview Customer') returning id")).rows[0].id;
      const other = (await s.query<{ id: string }>("insert into public.customers (name) values ('Other Customer') returning id")).rows[0].id;
      await openPortal(s, demo);
      const slug = await slugOf(s, demo);
      // Not a platform admin: refused.
      await s.as(owner);
      expect((await pgError(s.query("select public.platform_portal_preview_start($1, $2)", [demo, cust]))).code).toBe("42501");
      // Before starting, the admin sees nothing.
      await s.as(admin);
      expect((await pgError(s.query("select public.portal_context($1)", [slug]))).code).toBe("42501");
      await s.query("select public.platform_portal_preview_start($1, $2)", [demo, cust]);
      const ctx = (await s.query<{ r: { customer: { name: string } } }>("select public.portal_context($1) r", [slug])).rows[0].r;
      expect(ctx.customer.name).toBe("Preview Customer");
      expect((await s.query<{ r: { customer: string } }>("select public.portal_preview_state($1) r", [slug])).rows[0].r.customer).toBe("Preview Customer");
      // The preview is that one customer: another customer's support thread is not reachable.
      await s.asAdmin();
      const otherAcct = (await s.query<{ id: string }>("insert into public.portal_accounts (company_id, customer_id, email, status) values ($1, $2, 'x@other.example', 'active') returning id", [demo, other])).rows[0].id;
      const otherReq = (await s.query<{ id: string }>("insert into public.portal_support_requests (company_id, customer_id, account_id, subject) values ($1, $2, $3, 'Theirs') returning id", [demo, other, otherAcct])).rows[0].id;
      await s.as(admin);
      expect((await pgError(s.query("select public.portal_support_thread($1, $2)", [slug, otherReq]))).code).toBe("P0002");
      // Recorded in the platform audit.
      await s.asAdmin();
      expect((await s.query("select 1 from private.platform_audit where action = 'testing_lab.portal_preview' and target_id = $1", [demo])).rowCount).toBe(1);
      // Expired: refused.
      await s.query("update private.portal_previews set expires_at = now() - interval '1 second' where admin_id = $1", [admin]);
      await s.as(admin);
      expect((await pgError(s.query("select public.portal_context($1)", [slug]))).code).toBe("42501");
      // Checklist: demo companies only, platform admins only.
      expect((await pgError(s.query("select public.platform_testing_record('portal.orders', $1, 'tested', '')", [TOP_LINE]))).code).toBe("22023");
      await s.query("select public.platform_testing_record('portal.orders', $1, 'tested', 'Checked orders list')", [demo]);
      const checks = (await s.query<{ r: Array<{ view_key: string; status: string }> }>("select public.platform_testing_checks() r")).rows[0].r;
      expect(checks.some((c) => c.view_key === "portal.orders" && c.status === "tested")).toBe(true);
      await s.as(owner);
      expect((await pgError(s.query("select public.platform_testing_checks()"))).code).toBe("42501");
    });
  });
});
