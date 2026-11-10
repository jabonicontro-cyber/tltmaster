// Financial review fixes (2026-11-09, master plan §12 SEC4; CLAUDE.md "Security first, above all for financial data"):
//   M1 (20261120016100, owner decision 2026-11-10): with orders.create and without orders.edit a person may type a price
//      on a line without a price-list rate, never change the tax; the order is flagged "Price to be checked" and is not
//      handed off or invoiced until someone with pricing.edit, pricing.override or billing.manage confirms it.
//   L1 (20261120016200): credit limit and detention rate readable only through the billing-gated customer_money_terms.
//   L4 (20261120016200): price list and tax exemption need pricing.edit; payment terms and detention billing.manage.
//   L2 (20261120016300): assign_load asks for the credit-hold reason and records it itself.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { TOP_LINE, pgError, pool, sampleIds, withSession, withoutPermission, type Session } from "./helpers";

afterAll(() => pool.end());

type Ids = Awaited<ReturnType<typeof sampleIds>>;

const save = async (s: Session, payload: Record<string, unknown>) =>
  (await s.query<{ r: { order_id: string; order_number: string; edit_seq: number } }>("select public.save_order_draft($1::jsonb) as r", [JSON.stringify(payload)])).rows[0].r;
const setStatus = (s: Session, id: string, status: string, note = "") => s.query("select public.set_order_status($1, $2::public.order_status, $3)", [id, status, note]);
const confirmPrice = async (s: Session, id: string, note = "") =>
  (await s.query<{ r: { confirmed: boolean } }>("select public.order_confirm_price($1, $2) as r", [id, note])).rows[0].r;
const orderRow = async (s: Session, id: string) => {
  await s.asAdmin();
  return (await s.query<{ price_check_requested_by: string | null; price_check_requested_at: Date | null; price_checked_by: string | null; price_checked_at: Date | null; price_check_note: string; tax_rate_bp: number }>(
    "select price_check_requested_by, price_check_requested_at, price_checked_by, price_checked_at, price_check_note, tax_rate_bp from public.orders where id = $1", [id])).rows[0];
};

/** A gravel line at its price-list rate (taxable by default) and a typed hauling line without any rate. */
function phonedInLines(ids: Ids, typedCents = 9500) {
  return [
    { kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "40", unit_rate_cents: 1000, taxable: true },
    { kind: "hauling", calc_method: "per_unit", description: "Rush haul, same day (typed)", unit_code: "ton", quantity: "40", unit_rate_cents: typedCents, taxable: false },
  ];
}

describe("M1: a price typed with orders.create only", () => {
  it("tax follows the customer and company settings: the rate and a line's taxable flag cannot be changed", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const dispatcher = await s.createUser("dispatcher");
      const office = await s.createUser("office");
      const base = { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: phonedInLines(ids) };
      await s.as(dispatcher);
      // The company default is 0 %: another rate is refused, and so is a line taxed differently from its material.
      const rate = await pgError(save(s, { ...base, tax_rate_bp: 700 }));
      expect(rate.code).toBe("42501");
      expect(rate.message).toBe("Sales tax follows the company setting (0.00%). Someone who can change orders can use another rate on this order.");
      const flag = await pgError(save(s, { ...base, lines: [{ ...phonedInLines(ids)[0], taxable: false }] }));
      expect(flag.code).toBe("42501");
      expect(flag.message).toMatch(/^Line 1: whether it is taxed follows the material setting \(taxable\)/);
      expect((await pgError(save(s, { ...base, lines: [phonedInLines(ids)[0], { ...phonedInLines(ids)[1], taxable: true }] }))).message).toMatch(/^Line 2: .*company setting \(not taxable\)/);
      // The defaults are accepted.
      const ok = await save(s, base);
      expect((await orderRow(s, ok.order_id)).tax_rate_bp).toBe(0);

      // With a company default, only that rate; a draft of their own cannot be moved off it either.
      await s.asAdmin();
      await s.query("update public.company_settings set default_tax_rate_bp = 700 where company_id = $1", [TOP_LINE]);
      await s.as(dispatcher);
      expect((await pgError(save(s, { ...base, order_id: ok.order_id }))).message).toMatch(/company setting \(7.00%\)/);
      await save(s, { ...base, order_id: ok.order_id, tax_rate_bp: 700 });
      expect((await orderRow(s, ok.order_id)).tax_rate_bp).toBe(700);
      // A tax-exempt customer is never taxed, whatever is sent.
      await s.asAdmin();
      await s.query("update public.customers set tax_exempt = true where id = $1", [ids.customerId]);
      await s.as(dispatcher);
      const exempt = await save(s, { ...base, tax_rate_bp: 250 });
      expect((await orderRow(s, exempt.order_id)).tax_rate_bp).toBe(0);

      // Someone who can change orders (the office) chooses the tax as before.
      await s.asAdmin();
      await s.query("update public.customers set tax_exempt = false where id = $1", [ids.customerId]);
      await s.as(office);
      const officeOrder = await save(s, { ...base, tax_rate_bp: 825, lines: [{ ...phonedInLines(ids)[0], taxable: false }, phonedInLines(ids)[1]] });
      expect((await orderRow(s, officeOrder.order_id)).tax_rate_bp).toBe(825);
    });
  });

  it("flags the order with who typed the price; a confirmation stands while the typed prices stay the same", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const dispatcher = await s.createUser("dispatcher");
      const office = await s.createUser("office");
      const base = { customer_id: ids.customerId, site_line1: "7 Phone-in Road" };
      await s.as(dispatcher);
      const o = await save(s, { ...base, lines: phonedInLines(ids) });
      let row = await orderRow(s, o.order_id);
      expect(row.price_check_requested_by).toBe(dispatcher);
      expect(row.price_checked_at).toBeNull();
      const lines = (await s.query<{ line_no: number; price_source: string; price_entered_by: string | null }>("select line_no, price_source::text, price_entered_by from public.order_lines where order_id = $1 order by line_no", [o.order_id])).rows;
      expect(lines).toEqual([
        { line_no: 1, price_source: "standard", price_entered_by: null },
        { line_no: 2, price_source: "manual", price_entered_by: dispatcher },
      ]);
      expect((await s.query("select 1 from public.audit_events where action = 'order.price_check_requested' and entity_id = $1 and actor_id = $2", [o.order_id, dispatcher])).rowCount).toBe(1);

      // A rate different from the price list stays refused without pricing.override, as before.
      await s.as(dispatcher);
      expect((await pgError(save(s, { ...base, order_id: o.order_id, lines: [{ ...phonedInLines(ids)[0], unit_rate_cents: 900 }, phonedInLines(ids)[1]] }))).message).toMatch(/do not have permission to override pricing/);

      // The office confirms while it is still a draft; saving the same typed prices again keeps the confirmation.
      await s.as(office);
      expect(await confirmPrice(s, o.order_id, "Agreed with the customer by phone")).toMatchObject({ confirmed: true });
      expect(await confirmPrice(s, o.order_id)).toMatchObject({ confirmed: false });
      await s.as(dispatcher);
      await save(s, { ...base, order_id: o.order_id, project_name: "Rush job", lines: phonedInLines(ids) });
      row = await orderRow(s, o.order_id);
      expect(row.price_checked_by).toBe(office);
      expect(row.price_check_note).toBe("Agreed with the customer by phone");

      // A different typed price asks again; no typed price left, nothing to check.
      await s.as(dispatcher);
      await save(s, { ...base, order_id: o.order_id, lines: phonedInLines(ids, 9900) });
      row = await orderRow(s, o.order_id);
      expect([row.price_check_requested_by, row.price_checked_at]).toEqual([dispatcher, null]);
      await s.as(dispatcher);
      await save(s, { ...base, order_id: o.order_id, lines: [phonedInLines(ids)[0]] });
      row = await orderRow(s, o.order_id);
      expect([row.price_check_requested_at, row.price_checked_at]).toEqual([null, null]);

      // People who may change orders or decide prices type prices as before: nothing is flagged.
      await s.as(office);
      const officeOrder = await save(s, { ...base, lines: phonedInLines(ids) });
      expect((await orderRow(s, officeOrder.order_id)).price_check_requested_at).toBeNull();
    });
  });

  // Security review 2026-11-10: the confirmation is tied to everything that decides the amount (quantity included), as a
  // structured value, so a changed quantity or reshaped lines always ask again.
  it("a confirmation never survives a changed quantity or an added typed line", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const dispatcher = await s.createUser("dispatcher");
      const office = await s.createUser("office");
      const base = { customer_id: ids.customerId, site_line1: "9 Quantity Road" };
      await s.as(dispatcher);
      const o = await save(s, { ...base, lines: phonedInLines(ids) });
      await s.as(office);
      expect(await confirmPrice(s, o.order_id, "Rush rate agreed")).toMatchObject({ confirmed: true });

      // Same typed price, 100 times the quantity: asks again.
      const [gravel, typed] = phonedInLines(ids);
      await s.as(dispatcher);
      await save(s, { ...base, order_id: o.order_id, lines: [gravel, { ...typed, quantity: "4000" }] });
      let row = await orderRow(s, o.order_id);
      expect([row.price_check_requested_by, row.price_checked_at]).toEqual([dispatcher, null]);

      // Confirmed again, then the typed line is split in two with the same description: asks again.
      await s.as(office);
      expect(await confirmPrice(s, o.order_id)).toMatchObject({ confirmed: true });
      await s.as(dispatcher);
      await save(s, { ...base, order_id: o.order_id, lines: [gravel, { ...typed, quantity: "4000" }, { ...typed, quantity: "1", unit_rate_cents: 999999 }] });
      row = await orderRow(s, o.order_id);
      expect([row.price_check_requested_by, row.price_checked_at]).toEqual([dispatcher, null]);
    });
  });

  it("a price typed during a Taviron support visit waits for someone at the company", async () => {
    await withSession(async (s) => {
      const B = await s.createCompany("Visit Pricing Haul (test)");
      const staff = await s.createUser(null, { membership: false });
      await s.asAdmin();
      const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [staff])).rows[0].email;
      await s.query("set local role service_role");
      await s.query("select public.platform_admin_grant($1, 'test')", [email]);
      await s.asAdmin();
      await s.query("update private.platform_admins set level = 'support' where user_id = $1", [staff]);
      await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [B]);
      const customer = (await s.query<{ id: string }>("insert into public.customers (company_id, customer_number, name) values ($1, 'V-1', 'Visit Customer (test)') returning id", [B])).rows[0].id;
      const bOwner = (await s.query<{ user_id: string }>("select user_id from public.company_memberships where company_id = $1 and role = 'owner' limit 1", [B])).rows[0]?.user_id ?? await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      await s.query("select public.support_access_grant(1)");
      await s.as(staff);
      await s.query("select public.platform_support_enter($1, 'Enter a rush order')", [B]);
      const o = await save(s, { customer_id: customer, site_line1: "1 Visit Lane", lines: [{ kind: "hauling", calc_method: "per_unit", description: "Rush haul (typed)", unit_code: "ton", quantity: "10", unit_rate_cents: 5000, taxable: false }] });
      const row = await orderRow(s, o.order_id);
      expect(row.price_check_requested_by).toBe(staff);
      expect(row.price_checked_at).toBeNull();
    });
  });

  it("only pricing.edit, pricing.override or billing.manage confirm; never another company or a Taviron support visit", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      const o = await save(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: phonedInLines(ids) });

      // The dispatcher who typed it, a driver and a mechanic: refused.
      for (const who of [dispatcher, await s.createUser("driver"), await s.createUser("mechanic")]) {
        await s.as(who);
        expect((await pgError(confirmPrice(s, o.order_id))).code).toBe("42501");
      }
      // Another company's billing person: the order is not found.
      const B = await s.createCompany("Brookside Aggregates (test)");
      await s.as(await s.createUser("owner", { companyId: B }));
      expect((await pgError(confirmPrice(s, o.order_id))).message).toBe("Order not found.");
      expect((await orderRow(s, o.order_id)).price_checked_at).toBeNull();

      // A Taviron support visit is refused before anything is read.
      const staff = await s.createUser(null, { membership: false });
      await s.asAdmin();
      const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [staff])).rows[0].email;
      await s.query("set local role service_role");
      await s.query("select public.platform_admin_grant($1, 'test')", [email]);
      await s.asAdmin();
      await s.query("update private.platform_admins set level = 'support' where user_id = $1", [staff]);
      await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [B]);
      const bOwner = (await s.query<{ user_id: string }>("select user_id from public.company_memberships where company_id = $1 and role = 'owner' limit 1", [B])).rows[0]?.user_id ?? await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      await s.query("select public.support_access_grant(1)");
      await s.as(staff);
      await s.query("select public.platform_support_enter($1, 'Check a price')", [B]);
      expect((await pgError(confirmPrice(s, randomUUID()))).message).toMatch(/Taviron support cannot confirm prices/);
      expect((await pgError(s.query("select public.order_confirm_price($1, 'Fix the rate', $2::jsonb)", [randomUUID(), JSON.stringify([{ line_id: randomUUID(), unit_rate_cents: 100 }])]))).message).toMatch(/Taviron support cannot confirm prices/);

      // pricing.edit alone is enough (a custom role: the dispatcher given pricing.edit), and it is recorded.
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'mechanic', 'pricing.edit') on conflict do nothing", [TOP_LINE]);
      const pricer = await s.createUser("mechanic");
      await s.as(pricer);
      expect(await confirmPrice(s, o.order_id, "Checked against last month's rate")).toMatchObject({ confirmed: true });
      await s.asAdmin();
      const audit = (await s.query<{ actor_id: string; summary: string; details: { requested_by: string } }>("select actor_id, summary, details from public.audit_events where action = 'order.price_checked' and entity_id = $1", [o.order_id])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: pricer, details: { requested_by: dispatcher } });
      expect(audit[0].summary).toMatch(/typed price checked and confirmed: Checked against last month's rate/);
    });
  });

  // Owner answer 2026-11-10 (20261120016400): billing corrects a typed price while confirming it, with a reason, even
  // on a confirmed order; totals follow; the old and new prices are recorded.
  it("billing.manage corrects a typed price while confirming it; a dispatcher, pricing.edit alone and support visits cannot", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const dispatcher = await s.createUser("dispatcher");
      const office = await s.createUser("office");
      await s.as(dispatcher);
      const o = await save(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: phonedInLines(ids) });
      await setStatus(s, o.order_id, "confirmed");
      await s.asAdmin();
      const lines = (await s.query<{ id: string; line_no: number }>("select id, line_no from public.order_lines where order_id = $1 order by line_no", [o.order_id])).rows;
      const [gravel, typed] = [lines[0].id, lines[1].id];
      const correct = (note: string, list: Array<{ line_id: string; unit_rate_cents: number }>) =>
        s.query<{ r: { confirmed: boolean; corrected: number; total_cents: number } }>("select public.order_confirm_price($1, $2, $3::jsonb) as r", [o.order_id, note, JSON.stringify(list)]);

      // The dispatcher who typed it, and someone who sets price lists (pricing.edit) but not billing: refused.
      await s.as(dispatcher);
      expect((await pgError(correct("Lower rate", [{ line_id: typed, unit_rate_cents: 8800 }]))).code).toBe("42501");
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'mechanic', 'pricing.edit') on conflict do nothing", [TOP_LINE]);
      const pricer = await s.createUser("mechanic");
      await s.as(pricer);
      expect((await pgError(correct("Lower rate", [{ line_id: typed, unit_rate_cents: 8800 }]))).message).toBe("Only billing can correct a typed price. You can confirm it as typed.");
      // Billing: a reason is required; only typed lines; a sensible price.
      await s.as(office);
      expect((await pgError(correct(" ", [{ line_id: typed, unit_rate_cents: 8800 }]))).message).toBe("Say why the price is corrected.");
      expect((await pgError(correct("Lower rate", [{ line_id: gravel, unit_rate_cents: 900 }]))).message).toBe("Line 1: only a typed price can be corrected here.");
      expect((await pgError(correct("Lower rate", [{ line_id: typed, unit_rate_cents: -1 }]))).message).toMatch(/^Line 2: enter a price between/);
      expect((await pgError(correct("Lower rate", [{ line_id: randomUUID(), unit_rate_cents: 8800 }]))).message).toMatch(/^Line not found/);
      expect((await orderRow(s, o.order_id)).price_checked_at).toBeNull();

      // Corrected and confirmed: the line, the totals (40 t gravel at $10 + 40 t at $88), the check and the record.
      await s.as(office);
      expect((await correct("Customer agreed $88 per ton for the rush haul", [{ line_id: typed, unit_rate_cents: 8800 }])).rows[0].r)
        .toMatchObject({ confirmed: true, corrected: 1, total_cents: 392000 });
      await s.asAdmin();
      expect((await s.query("select unit_rate_cents::int, amount_cents::int, price_entered_by from public.order_lines where id = $1", [typed])).rows[0])
        .toEqual({ unit_rate_cents: 8800, amount_cents: 352000, price_entered_by: dispatcher });
      expect((await s.query("select subtotal_cents::int, total_cents::int, price_checked_by, price_check_note from public.orders where id = $1", [o.order_id])).rows[0])
        .toEqual({ subtotal_cents: 392000, total_cents: 392000, price_checked_by: office, price_check_note: "Customer agreed $88 per ton for the rush haul" });
      const audit = (await s.query<{ actor_id: string; summary: string; details: { changes: Array<{ line_no: number; from_cents: number; to_cents: number }>; reason: string; total_from: number; total_to: number } }>(
        "select actor_id, summary, details from public.audit_events where action = 'order.price_corrected' and entity_id = $1", [o.order_id])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_id).toBe(office);
      expect(audit[0].details).toMatchObject({ reason: "Customer agreed $88 per ton for the rush haul", total_from: 420000, total_to: 392000, changes: [{ line_no: 2, from_cents: 9500, to_cents: 8800 }] });
      expect(audit[0].summary).toBe(`${o.order_number}: typed price corrected (line 2 from $95.00 to $88.00): Customer agreed $88 per ton for the rush haul`);
      expect((await s.query("select 1 from public.audit_events where action = 'order.price_checked' and entity_id = $1 and actor_id = $2", [o.order_id, office])).rowCount).toBe(1);
      // Once confirmed, no second correction through this step.
      await s.as(office);
      expect((await pgError(correct("Again", [{ line_id: typed, unit_rate_cents: 8000 }]))).message).toMatch(/was already confirmed/);
      // Lines of confirmed orders stay fixed for everything else (the guard's exception lives only inside this step).
      await s.asAdmin();
      await s.query("set local role authenticated");
      expect((await pgError(s.query("update public.order_lines set unit_rate_cents = 1 where id = $1", [typed]))).code).toBe("42501");
    });
  });

  it("billing waits: blocked readiness, no handoff and no invoice until the price is confirmed", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const dispatcher = await s.createUser("dispatcher");
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const yesterday = addDays(today, -1);
      const f = await fleet(s, office, yesterday);

      // The dispatcher's phoned-in order, confirmed by them (the urgent job is not held up), then run as usual.
      await s.as(dispatcher);
      const o = await save(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", order_date: addDays(today, -2), lines: phonedInLines(ids) });
      await setStatus(s, o.order_id, "confirmed");
      await s.as(office);
      await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: addDays(today, -2), scheduled_end: today })]);
      await setStatus(s, o.order_id, "scheduled");
      const load = await planLoad(s, o.order_id, yesterday, "07:00", "09:00", { planned_quantity: "40", unit_code: "ton" });
      await s.query("select public.assign_load($1, $2, null, $3, '', null)", [load.load_id, f.t1, f.d1]);
      // The scale ticket is for the gravel line; the typed hauling line has none (an exception billing acknowledges).
      const gravelLine = (await s.query<{ id: string }>("select id from public.order_lines where order_id = $1 and line_no = 1", [o.order_id])).rows[0].id;
      const t = (await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
        load_id: load.load_id, order_line_id: gravelLine, delivered_date: yesterday, delivered_time: "08:00", quantity: "40", unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 8)}`,
      })])).rows[0].r;
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
      await setStatus(s, o.order_id, "in_progress");
      await setStatus(s, o.order_id, "completed");

      type St = { readiness: string; price_check_pending: boolean; exceptions_count: number; exceptions_fingerprint: string };
      const status = async () => (await s.query<St>("select readiness, price_check_pending, exceptions_count, exceptions_fingerprint from public.billing_order_status where order_id = $1", [o.order_id])).rows[0];
      let st = await status();
      expect(st).toMatchObject({ readiness: "blocked", price_check_pending: true });
      expect((await s.query<{ line_no: number; pricing_check: string }>("select line_no, pricing_check from public.billing_line_status where order_id = $1 order by line_no", [o.order_id])).rows)
        .toEqual([{ line_no: 1, pricing_check: "ok" }, { line_no: 2, pricing_check: "manual_price" }]);
      // Acknowledging every exception does not get around it.
      expect(st.exceptions_count).toBeGreaterThan(0);
      if (st.exceptions_count > 0) await s.query("select public.acknowledge_billing_exceptions($1, $2, 'Checked')", [o.order_id, st.exceptions_fingerprint]);
      expect((await status()).readiness).toBe("blocked");
      const refused = await pgError(s.query("select public.hand_off_orders($1::uuid[], '', '', $2)", [[o.order_id], randomUUID()]));
      expect(refused.message).toBe(`Price to be checked on order ${o.order_number}: a price was typed without a price-list rate. Someone who can set prices or manage billing confirms it on the order first.`);

      // Confirmed by the office: ready, handed off, invoiced.
      expect(await confirmPrice(s, o.order_id)).toMatchObject({ confirmed: true });
      st = await status();
      expect(st).toMatchObject({ readiness: "ready", price_check_pending: false });
      expect((await s.query<{ pricing_check: string }>("select pricing_check from public.billing_line_status where order_id = $1 and line_no = 2", [o.order_id])).rows[0].pricing_check).toBe("ok");
      await s.query("select public.hand_off_orders($1::uuid[], '', '', $2)", [[o.order_id], randomUUID()]);
      const handoff = (await s.query<{ id: string }>("select id from public.billing_handoff_orders where order_id = $1", [o.order_id])).rows[0].id;
      await s.as(owner);
      await s.query("select public.invoicing_save_settings('taviron', 15, '')");

      // Invoicing checks again: a check asked after the handoff (set here directly) stops the invoice, alone or combined.
      await s.asAdmin();
      await s.query("update public.orders set price_checked_at = null, price_checked_by = null where id = $1", [o.order_id]);
      await s.as(owner);
      expect((await pgError(s.query("select public.invoice_create($1)", [handoff]))).message).toMatch(/^Price to be checked on order/);
      // A correction (20261120016400) never changes a handed-off order: the handoff is undone first.
      const typedLine = (await s.query<{ id: string }>("select id from public.order_lines where order_id = $1 and line_no = 2", [o.order_id])).rows[0].id;
      const correct = () => s.query("select public.order_confirm_price($1, 'Customer agreed a lower rush rate', $2::jsonb)", [o.order_id, JSON.stringify([{ line_id: typedLine, unit_rate_cents: 8000 }])]);
      expect((await pgError(correct())).message).toBe(`Order ${o.order_number} was handed off for billing. Undo the handoff first, then correct the price.`);
      expect((await pgError(s.query("select public.invoice_create_combined($1::uuid[])", [[handoff, randomUUID()]]))).message).toMatch(/Price to be checked|not found/);
      await confirmPrice(s, o.order_id);
      const invoice = (await s.query<{ r: string }>("select public.invoice_create($1) as r", [handoff])).rows[0].r;
      expect(invoice).toBeTruthy();
      // Never a line on an issued invoice: refused in plain words, nothing changes.
      await s.query("select public.invoice_issue($1, null)", [invoice]);
      await s.asAdmin();
      await s.query("update public.orders set price_checked_at = null, price_checked_by = null where id = $1", [o.order_id]);
      const before = (await s.query<{ unit_rate_cents: number }>("select unit_rate_cents from public.order_lines where id = $1", [typedLine])).rows[0].unit_rate_cents;
      await s.as(owner);
      expect((await pgError(correct())).message).toBe(`Order ${o.order_number} is on an issued invoice, so its prices cannot be changed here. Correct the invoice instead.`);
      await s.asAdmin();
      expect((await s.query<{ unit_rate_cents: number }>("select unit_rate_cents from public.order_lines where id = $1", [typedLine])).rows[0].unit_rate_cents).toBe(before);
    });
  });
});

describe("L1: credit limit and detention rate are billing data", () => {
  it("are not readable from the customers table; customer_money_terms answers billing.view only, in the own company", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      await s.query("update public.customers set credit_limit_cents = 500000, detention_free_minutes = 30, detention_rate_cents = 7500 where id = $1", [ids.customerId]);
      const dispatcher = await s.createUser("dispatcher");
      const office = await s.createUser("office");
      for (const who of [dispatcher, office]) {
        await s.as(who);
        expect((await pgError(s.query("select credit_limit_cents from public.customers where id = $1", [ids.customerId]))).code).toBe("42501");
        expect((await pgError(s.query("select detention_rate_cents from public.customers where id = $1", [ids.customerId]))).code).toBe("42501");
        expect((await pgError(s.query("select * from public.customers where id = $1", [ids.customerId]))).code).toBe("42501");
        // Every other column reads as before (the dispatcher's order and dispatch screens).
        expect((await s.query("select id, name, payment_terms, credit_hold, detention_free_minutes from public.customers where id = $1", [ids.customerId])).rowCount).toBe(1);
      }
      await s.as(dispatcher);
      expect((await pgError(s.query("select * from public.customer_money_terms(array[$1]::uuid[])", [ids.customerId]))).code).toBe("42501");
      await s.as(office);
      expect((await s.query("select customer_id, credit_limit_cents::int, detention_free_minutes, detention_rate_cents from public.customer_money_terms(array[$1]::uuid[])", [ids.customerId])).rows)
        .toEqual([{ customer_id: ids.customerId, credit_limit_cents: 500000, detention_free_minutes: 30, detention_rate_cents: 7500 }]);
      // Another company's billing person never sees them.
      const B = await s.createCompany("Brookside Aggregates (test)");
      await s.as(await s.createUser("office", { companyId: B }));
      expect((await s.query("select * from public.customer_money_terms(array[$1]::uuid[])", [ids.customerId])).rowCount).toBe(0);
    });
  });

  it("every other customer column is readable by signed-in people (a column added later needs its own grant)", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const cols = (await s.query<{ attname: string; readable: boolean }>(
        "select a.attname, has_column_privilege('authenticated', 'public.customers', a.attname, 'select') readable from pg_attribute a where a.attrelid = 'public.customers'::regclass and a.attnum > 0 and not a.attisdropped")).rows;
      expect(cols.filter((c) => !c.readable).map((c) => c.attname).sort()).toEqual(["credit_limit_cents", "detention_rate_cents"]);
    });
  });
});

describe("L4: who changes a customer's money fields", () => {
  it("price list and tax exemption need pricing.edit; payment terms and detention billing.manage; on new customers too", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const list = (await s.query<{ id: string }>("select id from public.price_lists where company_id = $1 and not is_standard limit 1", [TOP_LINE])).rows[0]?.id;
      // A role with customers.edit only (the dispatcher, given it for this test).
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'dispatcher', 'customers.edit') on conflict do nothing", [TOP_LINE]);
      const clerk = await s.createUser("dispatcher");
      await s.as(clerk);
      const upd = (set: string, v: unknown) => s.query(`update public.customers set ${set} = $2 where id = $1`, [ids.customerId, v]);
      await upd("notes", "Gate code 1234 (test)");
      for (const [set, v, msg] of [
        ["tax_exempt", true, /price list or sales tax exemption/],
        ["price_list_id", list ?? null, /price list or sales tax exemption/],
        ["payment_terms", "Net 60", /payment terms or detention/],
        ["detention_free_minutes", 30, /payment terms or detention/],
      ] as const) {
        if (set === "price_list_id" && !list) continue;
        const e = await pgError(set === "detention_free_minutes"
          ? s.query("update public.customers set detention_free_minutes = 30, detention_rate_cents = 9000 where id = $1", [ids.customerId])
          : upd(set, v));
        expect(e.code, set).toBe("42501");
        expect(e.message, set).toMatch(msg);
      }
      expect((await pgError(upd("credit_limit_cents", 100))).code).toBe("42501");
      // New customers: plain is fine; a tax exemption, terms or a credit limit are refused.
      const ins = (extra: string, vals: unknown[]) => s.query(`insert into public.customers (company_id, name${extra}) values ($1, $2${vals.map((_, i) => `, $${i + 3}`).join("")})`, [TOP_LINE, `New Customer ${randomUUID().slice(0, 6)} (test)`, ...vals]);
      await ins("", []);
      expect((await pgError(ins(", tax_exempt", [true]))).message).toMatch(/price list or a sales tax exemption/);
      expect((await pgError(ins(", payment_terms", ["Net 30"]))).message).toMatch(/payment terms or detention/);
      expect((await pgError(ins(", credit_limit_cents", [1000]))).message).toMatch(/credit hold or set a credit limit/);

      // The office (pricing.edit and billing.manage) changes all of them.
      await s.as(await s.createUser("office"));
      await upd("tax_exempt", true);
      await upd("payment_terms", "Net 60");
      await s.query("update public.customers set detention_free_minutes = 30, detention_rate_cents = 9000 where id = $1", [ids.customerId]);
      if (list) await upd("price_list_id", list);
      await ins(", tax_exempt, payment_terms", [true, "Net 30"]);

      // pricing.edit without billing.manage: price list and tax yes, terms no.
      await withoutPermission(s, "office", "billing.manage");
      await s.as(await s.createUser("office"));
      await upd("tax_exempt", false);
      expect((await pgError(upd("payment_terms", "Net 15"))).code).toBe("42501");
    });
  });
});

describe("L4 and the platform import (security review 2026-11-10)", () => {
  it("the audited platform import brings a spreadsheet's payment terms and tax exemption in; anything else is still refused", async () => {
    await withSession(async (s) => {
      const B = await s.createCompany("Import Terms Haul (test)");
      // A Taviron admin with no membership in the company, inside a definer function as platform_import_approve runs
      // (row rules bypassed by the function's owner; auth.uid() is the admin).
      const admin = await s.createUser(null, { membership: false });
      await s.asAdmin();
      await s.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin, role: "authenticated", aal: "aal2" })]);
      const insert = () => s.query("insert into public.customers (company_id, customer_number, name, payment_terms, tax_exempt) values ($1, $2, 'Imported Customer (test)', 'Net 30', true)", [B, `I-${randomUUID().slice(0, 6)}`]);
      expect((await pgError(insert())).code).toBe("42501");
      await s.query("select set_config('tlt.platform_write', 'on', true)");
      await insert();
      await s.query("select set_config('tlt.platform_write', 'off', true)");
      expect((await pgError(insert())).code).toBe("42501");
    });
  });
});

describe("L2: the credit-hold reason is required and recorded by the database", () => {
  it("assign_load refuses a load for a customer on hold without a reason and records the reason with the assignment", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const on = addDays(await businessToday(s), 2);
      const order = await scheduledOrder(s, owner, on);
      const f = await fleet(s, owner, on);
      await s.as(owner);
      const l1 = await planLoad(s, order.id, on, "07:00", "08:00", { planned_quantity: "10", unit_code: "ton" });
      const l2 = await planLoad(s, order.id, on, "09:00", "10:00", { planned_quantity: "10", unit_code: "ton" });
      const l3 = await planLoad(s, order.id, on, "11:00", "12:00", { planned_quantity: "10", unit_code: "ton" });
      await s.asAdmin();
      const customer = (await s.query<{ c: string }>("select customer_id c from public.orders where id = $1", [order.id])).rows[0].c;
      await s.as(owner);
      await s.query("select public.set_customer_credit_hold($1, true, 'Two invoices 60 days late')", [customer]);

      await s.as(dispatcher);
      const assign = (load: string, truck: string, driver: string, reason?: string) => reason === undefined
        ? s.query<{ r: { assignment_id: string } }>("select public.assign_load($1, $2, null, $3, '', null) as r", [load, truck, driver])
        : s.query<{ r: { assignment_id: string } }>("select public.assign_load($1, $2, null, $3, '', null, $4) as r", [load, truck, driver, reason]);
      for (const reason of [undefined, "", "ok"]) {
        const e = await pgError(assign(l1.load_id, f.t1, f.d1, reason));
        expect(e.code).toBe("22023");
        expect(e.message).toMatch(/is on credit hold\. To go ahead, give a reason; it is recorded\.$/);
      }
      await s.asAdmin();
      expect((await s.query("select 1 from public.dispatch_assignments where load_id = $1", [l1.load_id])).rowCount).toBe(0);

      await s.as(dispatcher);
      const a = (await assign(l1.load_id, f.t1, f.d1, "Owner approved by phone")).rows[0].r.assignment_id;
      // The off-shift path passes the reason on.
      expect((await pgError(s.query("select public.assign_load_off_shift($1, $2, null, $3, '', null, 'Extra shift')", [l2.load_id, f.t2, f.d2]))).code).toBe("22023");
      const b = (await s.query<{ r: { assignment_id: string } }>("select public.assign_load_off_shift($1, $2, null, $3, '', null, 'Extra shift', 'Billing approved') as r", [l2.load_id, f.t2, f.d2])).rows[0].r.assignment_id;
      await s.asAdmin();
      const rows = (await s.query<{ entity_id: string; reason: string; context: string; created_by: string; hold_reasons: string[] }>(
        "select entity_id, reason, context, created_by, hold_reasons from public.credit_hold_overrides where customer_id = $1 order by created_at, reason", [customer])).rows;
      expect(rows.map((r) => [r.entity_id, r.reason, r.context, r.created_by, r.hold_reasons])).toEqual(expect.arrayContaining([
        [a, "Owner approved by phone", "assignment", dispatcher, ["manual"]],
        [b, "Billing approved", "assignment", dispatcher, ["manual"]],
      ]));
      expect(rows).toHaveLength(2);
      expect((await s.query("select 1 from public.audit_events where action = 'customer.credit_override' and entity_id = $1 and actor_id = $2", [customer, dispatcher])).rowCount).toBe(2);

      // Released: no reason needed and nothing recorded.
      await s.as(owner);
      await s.query("select public.set_customer_credit_hold($1, false, '')", [customer]);
      await s.as(dispatcher);
      await assign(l3.load_id, f.t1, f.d3);
      await s.asAdmin();
      expect((await s.query("select 1 from public.credit_hold_overrides where customer_id = $1", [customer])).rowCount).toBe(2);
    });
  });
});

describe("M1 demo sample", () => {
  it("marks a demo's phoned-in order as typed by its dispatcher, once; never in a real company", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      // A real company (Top Line): refused, and nothing changes.
      const owner = await s.createUser("owner");
      await s.as(owner);
      const real = await save(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: phonedInLines(ids) });
      expect((await pgError(s.query("select public.demo_price_check_sample($1)", [real.order_id]))).code).toBe("42501");
      expect((await orderRow(s, real.order_id)).price_check_requested_at).toBeNull();

      // A demo company: its owner's order with a typed line gets the check, typed by the demo dispatcher.
      const demo = await s.createCompany(`Price Demo ${randomUUID().slice(0, 6)}`);
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      const demoOwner = await s.createUser("owner", { companyId: demo });
      const demoDispatcher = await s.createUser("dispatcher", { companyId: demo });
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [demo, demoOwner]);
      const customer = (await s.query<{ id: string }>("insert into public.customers (company_id, name, customer_number) values ($1, 'Demo Paving (test)', 'PD-1') returning id", [demo])).rows[0].id;
      await s.as(demoOwner);
      const o = await save(s, { customer_id: customer, site_line1: "1 Demo Road", lines: [phonedInLines(ids)[1]] });
      expect((await orderRow(s, o.order_id)).price_check_requested_at).toBeNull(); // the owner's own typed price: no check
      await s.as(demoOwner);
      expect((await s.query<{ n: number }>("select public.demo_price_check_sample($1) n", [o.order_id])).rows[0].n).toBe(1);
      const row = await orderRow(s, o.order_id);
      expect(row.price_check_requested_by).toBe(demoDispatcher);
      expect((await s.query<{ price_entered_by: string }>("select price_entered_by from public.order_lines where order_id = $1", [o.order_id])).rows).toEqual([{ price_entered_by: demoDispatcher }]);
      // Once per demo; another company's order is never touched.
      await s.as(demoOwner);
      expect((await s.query<{ n: number }>("select public.demo_price_check_sample($1) n", [o.order_id])).rows[0].n).toBe(0);
      expect((await s.query<{ n: number }>("select public.demo_price_check_sample($1) n", [real.order_id])).rows[0].n).toBe(0);
      expect((await orderRow(s, real.order_id)).price_check_requested_at).toBeNull();
    });
  });
});
