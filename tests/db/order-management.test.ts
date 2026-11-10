// Order management: direct orders, editing, scheduling, status rules,
// pricing protection, audit history and company isolation.
import { afterAll, describe, expect, it } from "vitest";
import { calculateQuote } from "@/lib/quotes/calc";
import { canTransitionOrder, ORDER_STATUSES, orderTransitionPermission } from "@/lib/orders/status";
import { pgError, pool, sampleIds, saveQuote, TOP_LINE, withSession, type Session, withoutPermission } from "./helpers";

afterAll(() => pool.end());

type Ids = Awaited<ReturnType<typeof sampleIds>>;
type SaveResult = { order_id: string; order_number: string; edit_seq: number; total_cents: number };

async function saveOrder(s: Session, payload: Record<string, unknown>): Promise<SaveResult> {
  const res = await s.query<{ r: SaveResult }>("select public.save_order_draft($1::jsonb) as r", [JSON.stringify(payload)]);
  return res.rows[0].r;
}

async function setStatus(s: Session, orderId: string, status: string, note = "") {
  const res = await s.query<{ r: { status: string; edit_seq: number } }>("select public.set_order_status($1, $2::public.order_status, $3) as r", [orderId, status, note]);
  return res.rows[0].r;
}

async function schedule(s: Session, orderId: string, payload: Record<string, unknown>, seq: number | null = null) {
  const res = await s.query<{ r: { edit_seq: number; changed: boolean } }>("select public.update_order_schedule($1, $2, $3::jsonb) as r", [orderId, seq, JSON.stringify(payload)]);
  return res.rows[0].r;
}

async function details(s: Session, orderId: string, payload: Record<string, unknown>, seq: number | null = null) {
  const res = await s.query<{ r: { edit_seq: number; changed: boolean } }>("select public.update_order_details($1, $2, $3::jsonb) as r", [orderId, seq, JSON.stringify(payload)]);
  return res.rows[0].r;
}

async function order(s: Session, id: string) {
  await s.asAdmin();
  return (await s.query("select * from public.orders where id = $1", [id])).rows[0];
}

/** Gravel at the standard rate ($10.00/ton) and hauling at the standard rate ($5.00/ton) for Prairie View Landscaping. */
function standardLines(ids: Ids, qty = "18.5") {
  return [
    { kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: qty, unit_rate_cents: 1000, taxable: true },
    { kind: "hauling", calc_method: "per_unit", charge_item_id: ids.haulTonId, description: "Hauling", unit_code: "ton", quantity: qty, unit_rate_cents: 500 },
  ];
}

async function directOrder(s: Session, ids: Ids, extra: Record<string, unknown> = {}) {
  const office = await s.createUser("office");
  await s.as(office);
  const r = await saveOrder(s, {
    customer_id: ids.customerId,
    order_date: "2026-10-12",
    requested_date: "2026-10-15",
    tax_rate_bp: 700,
    contact_name: "Jordan Example",
    site_line1: "42 Sample Lane",
    site_city: "Crown Point",
    site_state: "IN",
    project_name: "Driveway base",
    customer_po: "",
    lines: standardLines(ids),
    ...extra,
  });
  return { ...r, office };
}

async function acceptedQuote(s: Session, ids: Ids) {
  const owner = await s.createUser("owner");
  await s.as(owner);
  const q = await saveQuote(s, {
    customer_id: ids.contractCustomerId,
    quote_date: "2026-10-01",
    valid_until: "2026-10-31",
    tax_rate_bp: 700,
    contact_name: "Pat Morgan",
    site_line1: "1500 Example Hwy",
    site_city: "Merrillville",
    customer_po: "PO-778",
    lines: [
      { kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "22.5", unit_rate_cents: 850, taxable: true },
      { kind: "discount", calc_method: "percent_of_subtotal", charge_item_id: ids.discountPctId, description: "Loyalty discount", percent_bp: 1000 },
    ],
  });
  await s.query("select public.mark_quote_sent($1, $2, 'Handed over')", [q.quote_id, q.edit_seq]);
  await s.query("select public.set_quote_status($1, 'accepted', 'Signed')", [q.quote_id]);
  const conv = await s.query<{ r: { order_id: string } }>("select public.convert_quote_to_order($1) as r", [q.quote_id]);
  return { quote: q, orderId: conv.rows[0].r.order_id, owner };
}

describe("status rules", () => {
  it("database and app agree on every transition and its permission", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      for (const from of ORDER_STATUSES) {
        for (const to of ORDER_STATUSES) {
          const r = await s.query<{ ok: boolean; perm: string }>(
            "select private.order_transition_allowed($1, $2) as ok, private.order_transition_permission($1, $2) as perm",
            [from, to],
          );
          expect(r.rows[0].ok, `${from} → ${to}`).toBe(canTransitionOrder(from, to));
          if (r.rows[0].ok) expect(r.rows[0].perm, `${from} → ${to}`).toBe(orderTransitionPermission(from, to));
        }
      }
    });
  });
});

describe("direct orders", () => {
  it("creates a numbered draft priced from the configured rates, with history and audit", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      expect(r.order_number).toMatch(/^ORD-\d{4,}$/);

      const o = await order(s, r.order_id);
      expect(o).toMatchObject({
        status: "draft",
        source_quote_id: null,
        customer_id: ids.customerId,
        project_name: "Driveway base",
        site_line1: "42 Sample Lane",
        is_sample: true,
        created_by: r.office,
        updated_by: r.office,
        edit_seq: 1,
        confirmed_at: null,
      });
      expect(o.bill_to_snapshot.name).toBe("Prairie View Landscaping");

      const lines = (await s.query("select * from public.order_lines where order_id = $1 order by line_no", [r.order_id])).rows;
      expect(lines.map((l) => l.price_source)).toEqual(["standard", "standard"]);
      expect(lines.map((l) => l.company_id)).toEqual([TOP_LINE, TOP_LINE]);

      // Totals agree with the app's calculation.
      const calc = calculateQuote(
        [
          { kind: "material", calcMethod: "per_unit", quantityMilli: 18500, rateCents: 1000, percentBp: null, taxable: true },
          { kind: "hauling", calcMethod: "per_unit", quantityMilli: 18500, rateCents: 500, percentBp: null, taxable: false },
        ],
        700,
      );
      expect(Number(o.total_cents)).toBe(calc.totalCents);
      expect(Number(o.tax_cents)).toBe(calc.taxCents);

      const events = await s.query("select from_status, to_status from public.order_status_events where order_id = $1", [r.order_id]);
      expect(events.rows).toEqual([{ from_status: null, to_status: "draft" }]);
      const audit = await s.query("select action, details from public.audit_events where entity_id = $1", [r.order_id]);
      expect(audit.rows.map((a) => a.action)).toEqual(["order.created"]);
      expect(audit.rows[0].details).toMatchObject({ pricing_override: false, line_count: 2 });
    });
  });

  it("refuses price overrides and discounts without pricing.override, allows them for the owner", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const base = { customer_id: ids.customerId, order_date: "2026-10-12" };
      const over = [{ ...standardLines(ids)[0], unit_rate_cents: 950 }];
      let err = await pgError(saveOrder(s, { ...base, lines: over }));
      expect(err.code).toBe("42501");
      expect(err.message).toMatch(/permission to override pricing/);
      err = await pgError(
        saveOrder(s, { ...base, lines: [...standardLines(ids), { kind: "discount", calc_method: "percent_of_subtotal", charge_item_id: ids.discountPctId, description: "Discount", percent_bp: 500 }] }),
      );
      expect(err.code).toBe("42501");

      const owner = await s.createUser("owner");
      await s.as(owner);
      const r = await saveOrder(s, { ...base, lines: over });
      await s.asAdmin();
      const line = (await s.query("select price_source, catalog_rate_cents from public.order_lines where order_id = $1", [r.order_id])).rows[0];
      expect(line).toEqual({ price_source: "override", catalog_rate_cents: "1000" });
    });
  });

  it("rejects invalid data with clear messages", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      await s.asAdmin();
      const otherContact = (await s.query<{ id: string }>("select id from customer_contacts where customer_id = $1 limit 1", [ids.contractCustomerId])).rows[0].id;
      const otherSite = (await s.query<{ id: string }>("select id from customer_sites where customer_id = $1 limit 1", [ids.contractCustomerId])).rows[0].id;
      const office = await s.createUser("office");
      await s.as(office);
      const base = { customer_id: ids.customerId, order_date: "2026-10-12", lines: standardLines(ids) };
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ ...base, customer_id: null }, /Select a customer/],
        [{ ...base, lines: [{ ...standardLines(ids)[0], quantity: "0" }] }, /quantity must be greater than 0/],
        [{ ...base, lines: [{ ...standardLines(ids)[0], quantity: "1.2345" }] }, /at most 3 decimal/],
        [{ ...base, lines: [{ ...standardLines(ids)[0], unit_code: "bogus" }] }, /valid unit/],
        [{ ...base, lines: [{ ...standardLines(ids)[0], description: "  " }] }, /description is required/],
        [{ ...base, requested_date: "2026-10-01" }, /requested delivery date cannot be before the order date/],
        [{ ...base, contact_id: otherContact }, /contact does not belong to this customer/],
        [{ ...base, site_id: otherSite }, /job site does not belong to this customer/],
        [{ ...base, order_date: "2020-01-01" }, /within a year of today/],
        [{ ...base, tax_rate_bp: 3000 }, /Tax rate must be between/],
      ];
      for (const [payload, message] of cases) {
        const err = await pgError(saveOrder(s, payload));
        expect(err.message, JSON.stringify(payload).slice(0, 80)).toMatch(message);
      }
      // Archived customer
      await s.asAdmin();
      await s.query("update public.customers set active = false where id = $1", [ids.customerId]);
      await s.as(office);
      expect((await pgError(saveOrder(s, base))).message).toMatch(/archived/);
    });
  });

  it("draft lines can change until confirmed, then lines and prices are locked — even for the database owner", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      await s.as(r.office);
      const edited = await saveOrder(s, { order_id: r.order_id, expected_edit_seq: 1, customer_id: ids.customerId, order_date: "2026-10-12", lines: standardLines(ids, "30") });
      expect(edited.edit_seq).toBe(2);
      expect(edited.total_cents).toBeGreaterThan(r.total_cents);
      // Stale editor
      const conflict = await pgError(saveOrder(s, { order_id: r.order_id, expected_edit_seq: 1, customer_id: ids.customerId, order_date: "2026-10-12", lines: standardLines(ids) }));
      expect(conflict.code).toBe("PT409");

      await setStatus(s, r.order_id, "confirmed");
      const locked = await pgError(saveOrder(s, { order_id: r.order_id, customer_id: ids.customerId, order_date: "2026-10-12", lines: standardLines(ids) }));
      expect(locked.code).toBe("42501");
      expect(locked.message).toMatch(/only be changed while the order is a draft/);

      const before = await order(s, r.order_id);
      expect(before.confirmed_at).not.toBeNull();
      expect((await pgError(s.query("update public.order_lines set unit_rate_cents = 1 where order_id = $1", [r.order_id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.order_lines where order_id = $1", [r.order_id]))).code).toBe("42501");
      expect((await pgError(s.query("update public.orders set total_cents = 1 where id = $1", [r.order_id]))).code).toBe("42501");
      expect((await pgError(s.query("update public.orders set customer_id = $2 where id = $1", [r.order_id, ids.contractCustomerId]))).code).toBe("42501");
      expect((await pgError(s.query("update public.orders set order_number = 'X' where id = $1", [r.order_id]))).code).toBe("42501");
      const after = await order(s, r.order_id);
      expect(after.total_cents).toBe(before.total_cents);
    });
  });

  it("confirming needs at least one line", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids, { lines: [] });
      await s.as(r.office);
      expect((await pgError(setStatus(s, r.order_id, "confirmed"))).message).toMatch(/at least one line/);
    });
  });

  it("app users cannot write order tables directly", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("update public.orders set project_name = 'x' where id = $1", [r.order_id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.order_lines where order_id = $1", [r.order_id]))).code).toBe("42501");
    });
  });
});

describe("quote-linked orders", () => {
  it("details can be edited while prices, lines and the quote stay exactly as accepted", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const { quote, orderId, owner } = await acceptedQuote(s, ids);
      await s.asAdmin();
      const quoteBefore = (await s.query("select * from public.quotes where id = $1", [quote.quote_id])).rows;
      const versionsBefore = (await s.query("select * from public.quote_versions where quote_id = $1", [quote.quote_id])).rows;
      const qLinesBefore = (await s.query("select * from public.quote_lines where quote_version_id = $1", [quote.version_id])).rows;
      const linesBefore = (await s.query("select * from public.order_lines where order_id = $1 order by line_no", [orderId])).rows;
      const before = await order(s, orderId);
      expect(before.contact_id).toBeNull();
      expect(before.confirmed_at).not.toBeNull();
      expect(before.order_date).not.toBeNull();

      const office = await s.createUser("office");
      await s.as(office);
      const r = await details(s, orderId, {
        contact_name: "Sam Field",
        contact_phone: "(219) 555-0199",
        site_line1: "1510 Example Hwy",
        site_city: "Merrillville",
        customer_po: "PO-900",
        job_instructions: "Use the north gate",
        requested_date: "2026-12-01",
      }, before.edit_seq);
      expect(r.changed).toBe(true);

      const after = await order(s, orderId);
      expect(after).toMatchObject({ contact_name: "Sam Field", site_line1: "1510 Example Hwy", customer_po: "PO-900", updated_by: office });
      for (const k of ["subtotal_cents", "discount_cents", "tax_cents", "total_cents", "tax_rate_bp", "terms", "customer_id", "source_quote_id", "source_quote_version_id", "bill_to_snapshot"]) {
        expect(after[k], k).toEqual(before[k]);
      }
      expect((await s.query("select * from public.order_lines where order_id = $1 order by line_no", [orderId])).rows).toEqual(linesBefore);
      expect((await s.query("select * from public.quotes where id = $1", [quote.quote_id])).rows).toEqual(quoteBefore);
      expect((await s.query("select * from public.quote_versions where quote_id = $1", [quote.quote_id])).rows).toEqual(versionsBefore);
      expect((await s.query("select * from public.quote_lines where quote_version_id = $1", [quote.version_id])).rows).toEqual(qLinesBefore);

      // The full editor refuses quote-linked orders; triggers refuse even the database owner.
      await s.as(owner);
      const err = await pgError(saveOrder(s, { order_id: orderId, customer_id: ids.contractCustomerId, order_date: "2026-10-12", lines: [] }));
      expect(err.code).toBe("42501");
      expect(err.message).toMatch(/created from a quote/);
      await s.asAdmin();
      expect((await pgError(s.query("update public.order_lines set amount_cents = 0 where order_id = $1", [orderId]))).code).toBe("42501");
      expect((await pgError(s.query("update public.orders set discount_cents = 0 where id = $1", [orderId]))).code).toBe("42501");
      expect((await pgError(s.query("update public.orders set source_quote_id = null where id = $1", [orderId]))).code).toBe("42501");
    });
  });

  it("conversion stays idempotent and records the order date and confirmation", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const { quote, orderId } = await acceptedQuote(s, ids);
      const again = await s.query<{ r: { order_id: string; created: boolean } }>("select public.convert_quote_to_order($1) as r", [quote.quote_id]);
      expect(again.rows[0].r).toMatchObject({ order_id: orderId, created: false });
      const o = await order(s, orderId);
      expect(o.status).toBe("confirmed");
      expect(o.confirmed_at).not.toBeNull();
    });
  });

  it("an update of the order details with nothing changed writes no audit entry", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const { orderId } = await acceptedQuote(s, ids);
      const o = await order(s, orderId);
      const office = await s.createUser("office");
      await s.as(office);
      const same = Object.fromEntries(
        ["contact_name", "contact_email", "contact_phone", "site_label", "site_line1", "site_line2", "site_city", "site_state", "site_postal_code", "project_name", "customer_po", "job_instructions", "internal_notes"].map((k) => [k, o[k]]),
      );
      const r = await details(s, orderId, { ...same, site_id: o.site_id, contact_id: o.contact_id });
      expect(r.changed).toBe(false);
      await s.asAdmin();
      const n = await s.query("select count(*)::int as n from public.audit_events where entity_id = $1 and action = 'order.updated'", [orderId]);
      expect(n.rows[0].n).toBe(0);
    });
  });
});

describe("scheduling and status changes", () => {
  it("moves an order through delivery, recording events, timestamps and audit", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      await s.as(r.office);
      await setStatus(s, r.order_id, "confirmed", "Confirmed by phone");
      // A scheduled date is required first.
      expect((await pgError(setStatus(s, r.order_id, "scheduled"))).message).toMatch(/Set a scheduled date/);

      const sched = await schedule(s, r.order_id, { scheduled_start: "2026-10-15", scheduled_end: "2026-10-16", window_start: "07:00", window_end: "11:30", scheduling_notes: "Call foreman" });
      expect(sched.changed).toBe(true);
      for (const st of ["scheduled", "dispatched", "in_progress", "partially_completed", "in_progress", "completed"]) {
        await setStatus(s, r.order_id, st);
      }
      const o = await order(s, r.order_id);
      expect(o).toMatchObject({ status: "completed", scheduling_notes: "Call foreman", window_start: "07:00:00", window_end: "11:30:00" });
      expect(o.completed_at).not.toBeNull();

      const events = await s.query("select from_status, to_status, note from public.order_status_events where order_id = $1 order by occurred_at, id", [r.order_id]);
      expect(events.rows.map((e) => e.to_status)).toEqual(expect.arrayContaining(["draft", "confirmed", "scheduled", "dispatched", "in_progress", "partially_completed", "completed"]));
      expect(events.rows.find((e) => e.to_status === "confirmed")).toMatchObject({ from_status: "draft", note: "Confirmed by phone" });

      const audit = await s.query<{ action: string; details: { changes?: Record<string, unknown> } }>("select action, details from public.audit_events where entity_id = $1", [r.order_id]);
      const actions = audit.rows.map((a) => a.action);
      expect(actions.filter((a) => a === "order.status_changed")).toHaveLength(7);
      const scheduled = audit.rows.find((a) => a.action === "order.scheduled");
      expect(scheduled?.details.changes).toMatchObject({ scheduled_start: { from: null, to: "2026-10-15" }, window_start: { from: null, to: "07:00:00" } });

      // Completed orders are final.
      await s.as(r.office);
      expect((await pgError(setStatus(s, r.order_id, "in_progress"))).message).toMatch(/cannot move from completed/);
      expect((await pgError(details(s, r.order_id, { project_name: "x" }))).message).toMatch(/cannot be edited/);
      expect((await pgError(schedule(s, r.order_id, { scheduled_start: "2026-10-20" }))).message).toMatch(/cannot be changed/);
    });
  });

  it("enforces the transition rules and their requirements", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      await s.as(r.office);
      expect((await pgError(setStatus(s, r.order_id, "completed"))).message).toMatch(/cannot move from draft to completed/);
      expect((await pgError(setStatus(s, r.order_id, "draft"))).message).toMatch(/already draft/);
      await setStatus(s, r.order_id, "confirmed");
      expect((await pgError(setStatus(s, r.order_id, "in_progress"))).message).toMatch(/cannot move from confirmed to in progress/);
      expect((await pgError(setStatus(s, r.order_id, "on_hold"))).message).toMatch(/reason/);
      await setStatus(s, r.order_id, "on_hold", "Site not ready");
      expect((await order(s, r.order_id)).status_note).toBe("Site not ready");
      await s.as(r.office);
      await schedule(s, r.order_id, { scheduled_start: "2026-10-20" });
      await setStatus(s, r.order_id, "scheduled");
      // A scheduled order keeps its date.
      expect((await pgError(schedule(s, r.order_id, { scheduled_start: "" }))).message).toMatch(/needs a scheduled date/);
      // Invalid schedule values
      expect((await pgError(schedule(s, r.order_id, { scheduled_start: "2026-10-20", scheduled_end: "2026-10-19" }))).message).toMatch(/end date must be on or after/);
      expect((await pgError(schedule(s, r.order_id, { scheduled_start: "2026-10-20", window_start: "09:00" }))).message).toMatch(/both a start and an end time/);
      expect((await pgError(schedule(s, r.order_id, { scheduled_start: "2026-10-20", window_start: "09:00", window_end: "08:00" }))).message).toMatch(/must end after it starts/);
      expect((await pgError(schedule(s, r.order_id, { scheduled_start: "2026-10-01" }))).message).toMatch(/before the order date/);
      // Stale edit_seq
      expect((await pgError(schedule(s, r.order_id, { scheduled_start: "2026-10-21" }, 1))).code).toBe("PT409");

      expect((await pgError(setStatus(s, r.order_id, "canceled"))).message).toMatch(/reason/);
      await setStatus(s, r.order_id, "canceled", "Customer canceled the project");
      const o = await order(s, r.order_id);
      expect(o.canceled_at).not.toBeNull();
      await s.as(r.office);
      expect((await pgError(setStatus(s, r.order_id, "confirmed"))).message).toMatch(/cannot move from canceled/);
    });
  });
});

describe("permissions", () => {
  it("dispatchers create orders by default (orders.create, 2026-11-09): a new order and their own draft, which they confirm, schedule and dispatch; without orders.create they cannot", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      const dispatcher = await s.createUser("dispatcher");
      // The narrow permission, not orders.edit.
      await s.asAdmin();
      const held = (await s.query<{ permission: string }>("select permission from public.role_permissions where company_id = $1 and role = 'dispatcher' and permission like 'orders.%' order by 1", [TOP_LINE])).rows.map((x) => x.permission);
      expect(held).toEqual(["orders.create", "orders.schedule", "orders.view"]);
      const defaults = (await s.query<{ role: string }>("select role::text from public.role_permission_defaults where permission = 'orders.create' order by 1")).rows.map((x) => x.role);
      expect(defaults).toEqual(["dispatcher", "office", "owner"]);

      await s.as(dispatcher);
      const mine = await saveOrder(s, { customer_id: ids.customerId, order_date: "2026-10-12", site_line1: "7 Phone-in Road", project_name: "Urgent pad", lines: standardLines(ids) });
      expect(mine.order_id).toBeTruthy();
      // Their own draft can be changed until it is confirmed (same prices, so no override is needed).
      const again = await saveOrder(s, { order_id: mine.order_id, expected_edit_seq: mine.edit_seq, customer_id: ids.customerId, order_date: "2026-10-12", site_line1: "7 Phone-in Road", project_name: "Urgent pad", lines: standardLines(ids, "20") });
      expect(again.edit_seq).toBe(mine.edit_seq + 1);
      // A different rate still needs pricing.override.
      const cheaper = standardLines(ids).map((l, i) => (i === 0 ? { ...l, unit_rate_cents: 900 } : l));
      expect((await pgError(saveOrder(s, { customer_id: ids.customerId, lines: cheaper }))).message).toMatch(/override pricing/);

      // Confirm their own draft, then schedule and dispatch it with orders.schedule as before.
      await setStatus(s, mine.order_id, "confirmed");
      await schedule(s, mine.order_id, { scheduled_start: "2026-10-20" });
      await setStatus(s, mine.order_id, "scheduled");
      await setStatus(s, mine.order_id, "dispatched");
      expect((await order(s, mine.order_id)).status).toBe("dispatched");

      // Without orders.create (an owner turned it off for the role): no new orders, no confirming.
      await withoutPermission(s, "dispatcher", "orders.create");
      await s.as(dispatcher);
      expect((await pgError(saveOrder(s, { customer_id: ids.customerId, lines: standardLines(ids) }))).code).toBe("42501");
      expect((await pgError(setStatus(s, r.order_id, "confirmed"))).code).toBe("42501");
      expect((await pgError(details(s, r.order_id, { project_name: "x" }))).code).toBe("42501");

      // Scheduling and moving work along stay orders.schedule; canceling stays orders.edit.
      await s.as(r.office);
      await setStatus(s, r.order_id, "confirmed");
      await s.as(dispatcher);
      await schedule(s, r.order_id, { scheduled_start: "2026-10-20" });
      await setStatus(s, r.order_id, "scheduled");
      await setStatus(s, r.order_id, "dispatched");
      expect((await pgError(setStatus(s, r.order_id, "canceled", "No"))).code).toBe("42501");
      expect((await order(s, r.order_id)).status).toBe("dispatched");
    });
  });

  it("orders.create alone never changes someone else's order, confirms or cancels their draft, cancels a confirmed order, converts quotes, sends tracking links, adds documents or overrides a credit hold", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const officeDraft = await directOrder(s, ids);
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      const mine = await saveOrder(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: standardLines(ids) });

      // Someone else's draft: not changed, not confirmed, not canceled. (Their own draft they may cancel since MD1,
      // 20261120016000: see "own direct orders" below.)
      expect((await pgError(saveOrder(s, { order_id: officeDraft.order_id, customer_id: ids.customerId, lines: standardLines(ids, "1") }))).code).toBe("42501");
      expect((await pgError(setStatus(s, officeDraft.order_id, "confirmed"))).code).toBe("42501");
      expect((await pgError(setStatus(s, officeDraft.order_id, "canceled", "Not needed"))).code).toBe("42501");
      expect((await pgError(details(s, officeDraft.order_id, { project_name: "x" }))).code).toBe("42501");
      await setStatus(s, mine.order_id, "confirmed");
      // Once confirmed, their own order is no longer theirs to change (details and lines need orders.edit).
      expect((await pgError(saveOrder(s, { order_id: mine.order_id, customer_id: ids.customerId, lines: standardLines(ids) }))).code).toBe("42501");
      expect((await pgError(details(s, mine.order_id, { project_name: "x" }))).code).toBe("42501");
      expect((await pgError(setStatus(s, mine.order_id, "canceled", "Customer called back"))).code).toBe("42501");

      // Tracking links, order documents and quote conversion stay orders.edit.
      const quote = await acceptedQuote(s, ids);
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.convert_quote_to_order($1)", [quote.quote.quote_id]))).code).toBe("42501");
      expect((await pgError(s.query("select public.portal_tracking_create($1, 7)", [mine.order_id]))).code).toBe("42501");
      expect((await pgError(s.query("select public.portal_tracking_revoke(gen_random_uuid())"))).code).toBe("42501");
      expect((await pgError(s.query("select public.order_document_begin($1, null, 'other', 'application/pdf', 1000, 'Rate confirmation.pdf')", [mine.order_id]))).code).toBe("42501");

      // Credit hold: a new order (or switching their draft to a customer on hold) is refused and never recorded as an
      // override; someone who can change orders decides, as before. (A line without a configured price: no override.)
      const manual = [{ kind: "material", calc_method: "per_unit", description: "Fill sand", unit_code: "ton", quantity: "5", unit_rate_cents: 700 }];
      await s.as(owner);
      await s.query("select public.set_customer_credit_hold($1, true, 'Two invoices 60 days late')", [ids.contractCustomerId]);
      await s.as(dispatcher);
      const refused = await pgError(saveOrder(s, { customer_id: ids.contractCustomerId, lines: manual }));
      expect(refused.code).toBe("42501");
      expect(refused.message).toMatch(/credit hold/);
      const draft = await saveOrder(s, { customer_id: ids.customerId, lines: standardLines(ids) });
      expect((await pgError(saveOrder(s, { order_id: draft.order_id, customer_id: ids.contractCustomerId, lines: manual }))).message).toMatch(/credit hold/);
      expect((await pgError(s.query("select public.record_credit_override($1, 'order', $2, 'Customer promised to pay')", [ids.contractCustomerId, draft.order_id]))).code).toBe("42501");
      await s.asAdmin();
      expect((await s.query("select 1 from public.credit_hold_overrides where customer_id = $1", [ids.contractCustomerId])).rowCount).toBe(0);
      await s.as(officeDraft.office);
      expect((await saveOrder(s, { customer_id: ids.contractCustomerId, lines: manual })).order_id).toBeTruthy();
    });
  });

  it("mechanics, drivers and pending users can do nothing with orders", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      for (const role of ["mechanic", "driver", null] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await pgError(saveOrder(s, { customer_id: ids.customerId, lines: standardLines(ids) }))).code, String(role)).toBe("42501");
        expect((await pgError(schedule(s, r.order_id, { scheduled_start: "2026-10-20" }))).code, String(role)).toBe("42501");
        const err = await pgError(setStatus(s, r.order_id, "canceled", "x"));
        expect(["42501", "P0001"], String(role)).toContain(err.code);
        expect((await s.query("select id from public.orders where id = $1", [r.order_id])).rowCount, String(role)).toBe(0);
      }
    });
  });

  it("people who can view orders see order history but not the rest of the audit log", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      await s.as(r.office);
      await details(s, r.order_id, { project_name: "Driveway base, phase 2" });
      // Fleet history is also readable (fleet.view); nothing else without audit.view.
      const rows = await s.query("select action, entity_type from public.audit_events where entity_type not in ('truck', 'trailer', 'driver', 'driver_qualification')");
      expect(rows.rows.length).toBeGreaterThanOrEqual(2);
      expect(new Set(rows.rows.map((a) => a.entity_type))).toEqual(new Set(["order"]));
      const changed = await s.query<{ details: { changes: Record<string, unknown> } }>("select details from public.audit_events where action = 'order.updated' and entity_id = $1", [r.order_id]);
      expect(changed.rows[0].details.changes).toEqual({ project_name: { from: "Driveway base", to: "Driveway base, phase 2" }, contact_name: { from: "Jordan Example", to: "" }, site_line1: { from: "42 Sample Lane", to: "" }, site_city: { from: "Crown Point", to: "" }, site_state: { from: "IN", to: "" }, requested_date: { from: "2026-10-15", to: null } });
    });
  });
});

// MD1 and SEC3 (owner 2026-11-09, 20261120016000): with orders.create a person cancels a direct draft they entered,
// flags their own direct order urgent and changes its stops (draft or confirmed); confirming their draft rechecks the
// credit hold; the price list answers them. Anyone else's order, and a confirmed order's cancel, still need orders.edit.
describe("own direct orders (orders.create)", () => {
  const flag = (s: Session, orderId: string, reason: string) =>
    s.query<{ r: { urgency_id: string; created: boolean; changed: boolean } }>("select public.flag_order_urgent($1, $2) as r", [orderId, reason]).then((x) => x.rows[0].r);
  const stops = (s: Session, orderId: string, list: Array<{ kind: string; name: string }>) =>
    s.query<{ n: number }>("select public.save_order_stops($1, $2::jsonb) as n", [orderId, JSON.stringify(list)]).then((x) => x.rows[0].n);
  const twoStops = [{ kind: "pickup", name: "North yard (test)" }, { kind: "delivery", name: "Phone-in site (test)" }];

  it("cancels their own draft with a reason, recorded in its history; never someone else's draft or a confirmed order", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const officeDraft = await directOrder(s, ids);
      const dispatcher = await s.createUser("dispatcher");
      const other = await s.createUser("dispatcher");
      await s.as(dispatcher);
      const mine = await saveOrder(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: standardLines(ids) });

      // A reason is required, as for every cancel.
      expect((await pgError(setStatus(s, mine.order_id, "canceled"))).message).toMatch(/Enter a reason/);
      expect(await setStatus(s, mine.order_id, "canceled", "Customer called back: entered twice")).toMatchObject({ status: "canceled" });
      expect((await order(s, mine.order_id))).toMatchObject({ status: "canceled", status_note: "Customer called back: entered twice" });
      expect((await order(s, mine.order_id)).canceled_at).not.toBeNull();
      await s.asAdmin();
      const history = (await s.query<{ from_status: string; to_status: string; note: string; actor_id: string }>("select from_status::text, to_status::text, note, actor_id from public.order_status_events where order_id = $1 order by occurred_at", [mine.order_id])).rows;
      expect(history.at(-1)).toEqual({ from_status: "draft", to_status: "canceled", note: "Customer called back: entered twice", actor_id: dispatcher });
      expect((await s.query("select 1 from public.audit_events where action = 'order.status_changed' and entity_id = $1 and actor_id = $2", [mine.order_id, dispatcher])).rowCount).toBe(1);

      // Someone else's draft (the office's, another dispatcher's): refused, and left as it was.
      await s.as(dispatcher);
      expect((await pgError(setStatus(s, officeDraft.order_id, "canceled", "Not needed"))).code).toBe("42501");
      await s.as(other);
      const theirs = await saveOrder(s, { customer_id: ids.customerId, site_line1: "9 Other Road", lines: standardLines(ids) });
      await s.as(dispatcher);
      expect((await pgError(setStatus(s, theirs.order_id, "canceled", "Not needed"))).code).toBe("42501");
      expect((await order(s, officeDraft.order_id)).status).toBe("draft");
      expect((await order(s, theirs.order_id)).status).toBe("draft");

      // Their own order once confirmed: canceling it is an office decision (orders.edit).
      await s.as(dispatcher);
      const confirmed = await saveOrder(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: standardLines(ids) });
      await setStatus(s, confirmed.order_id, "confirmed");
      expect((await pgError(setStatus(s, confirmed.order_id, "canceled", "Customer called back"))).code).toBe("42501");
      expect((await order(s, confirmed.order_id)).status).toBe("confirmed");
      await s.as(officeDraft.office);
      expect(await setStatus(s, confirmed.order_id, "canceled", "Customer called back")).toMatchObject({ status: "canceled" });

      // Without orders.create (turned off for the role): not even their own draft.
      await s.as(dispatcher);
      const last = await saveOrder(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: standardLines(ids) });
      await withoutPermission(s, "dispatcher", "orders.create");
      await s.as(dispatcher);
      expect((await pgError(setStatus(s, last.order_id, "canceled", "Entered twice"))).code).toBe("42501");
      expect((await order(s, last.order_id)).status).toBe("draft");
    });
  });

  it("confirming their own draft rechecks the credit hold: a hold put on after the draft was saved stops it", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      const draft = await saveOrder(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: standardLines(ids) });
      const second = await saveOrder(s, { customer_id: ids.customerId, site_line1: "8 Phone-in Road", lines: standardLines(ids) });
      const third = await saveOrder(s, { customer_id: ids.customerId, site_line1: "9 Phone-in Road", lines: standardLines(ids) });
      // Put on hold after the drafts were saved.
      await s.as(owner);
      await s.query("select public.set_customer_credit_hold($1, true, 'Two invoices 60 days late')", [ids.customerId]);
      await s.asAdmin();
      const name = (await s.query<{ name: string }>("select name from public.customers where id = $1", [ids.customerId])).rows[0].name;

      // The same message as saving a new order for them.
      await s.as(dispatcher);
      const refused = await pgError(setStatus(s, draft.order_id, "confirmed"));
      expect(refused.code).toBe("42501");
      expect(refused.message).toBe(`${name} is on credit hold. A new order for them needs someone who can change orders: they decide whether to go ahead and record why.`);
      expect(await pgError(saveOrder(s, { customer_id: ids.customerId, lines: standardLines(ids) }))).toEqual(refused);
      expect((await order(s, draft.order_id)).status).toBe("draft");

      // Canceling stays possible (nothing goes ahead for the customer).
      await s.as(dispatcher);
      expect(await setStatus(s, third.order_id, "canceled", "Customer on hold, entered by mistake")).toMatchObject({ status: "canceled" });

      // Someone who can change orders decides, as before: the office confirms the second draft.
      await s.as(office);
      expect(await setStatus(s, second.order_id, "confirmed")).toMatchObject({ status: "confirmed" });

      // Hold released: the dispatcher confirms their draft.
      await s.as(owner);
      await s.query("select public.set_customer_credit_hold($1, false, 'Paid in full')", [ids.customerId]);
      await s.as(dispatcher);
      expect(await setStatus(s, draft.order_id, "confirmed")).toMatchObject({ status: "confirmed" });
    });
  });

  it("flags their own direct order urgent and changes its stops, draft or confirmed; never anyone else's order", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const officeDraft = await directOrder(s, ids);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      const mine = await saveOrder(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: standardLines(ids) });

      // Draft: flag, change the reason, save stops.
      expect(await flag(s, mine.order_id, "Customer needs it before noon")).toMatchObject({ created: true, changed: true });
      expect(await flag(s, mine.order_id, "Customer needs it before 11")).toMatchObject({ created: false, changed: true });
      expect(await stops(s, mine.order_id, twoStops)).toBe(2);
      // Confirmed: still theirs to flag and to give stops.
      await setStatus(s, mine.order_id, "confirmed");
      expect(await flag(s, mine.order_id, "Customer needs it before 10")).toMatchObject({ created: false, changed: true });
      expect(await stops(s, mine.order_id, [...twoStops, { kind: "delivery", name: "Second drop (test)" }])).toBe(3);
      await s.asAdmin();
      expect((await s.query<{ flagged_by: string; reason: string }>("select flagged_by, reason from public.order_urgencies where order_id = $1 and closed_at is null", [mine.order_id])).rows).toEqual([{ flagged_by: dispatcher, reason: "Customer needs it before 10" }]);
      expect((await s.query("select 1 from public.audit_events where action = 'order.stops_saved' and entity_id = $1 and actor_id = $2", [mine.order_id, dispatcher])).rowCount).toBe(2);

      // Withdrawing the flag stays orders.edit (dispatch moves it along and resolves it, as before).
      const urgency = (await s.query<{ id: string }>("select id from public.order_urgencies where order_id = $1 and closed_at is null", [mine.order_id])).rows[0].id;
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.update_order_urgency($1, 'canceled', 'Not urgent after all')", [urgency]))).code).toBe("42501");

      // Someone else's order (the office's draft, then confirmed): refused, nothing changed.
      expect((await pgError(flag(s, officeDraft.order_id, "Customer called"))).code).toBe("42501");
      expect((await pgError(stops(s, officeDraft.order_id, twoStops))).code).toBe("42501");
      await s.as(officeDraft.office);
      await setStatus(s, officeDraft.order_id, "confirmed");
      await s.as(dispatcher);
      expect((await pgError(flag(s, officeDraft.order_id, "Customer called"))).code).toBe("42501");
      expect((await pgError(stops(s, officeDraft.order_id, twoStops))).code).toBe("42501");
      await s.asAdmin();
      expect((await s.query("select 1 from public.order_urgencies where order_id = $1", [officeDraft.order_id])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.order_stops where order_id = $1", [officeDraft.order_id])).rowCount).toBe(0);

      // An order from a quote is never "their own direct order", even when they converted nothing themselves.
      const quote = await acceptedQuote(s, ids);
      await s.as(dispatcher);
      expect((await pgError(flag(s, quote.orderId, "Customer called"))).code).toBe("42501");

      // A canceled order of their own: closed, as for everyone.
      const done = await saveOrder(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: standardLines(ids) });
      await setStatus(s, done.order_id, "canceled", "Entered twice");
      expect((await pgError(flag(s, done.order_id, "Customer called"))).message).toMatch(/cannot be flagged/);
      expect((await pgError(stops(s, done.order_id, twoStops))).message).toMatch(/completed or canceled/);

      // The office (orders.edit) still flags and gives stops on any order, the dispatcher's included.
      await s.as(officeDraft.office);
      expect(await stops(s, mine.order_id, twoStops)).toBe(2);
      expect(await flag(s, officeDraft.order_id, "Customer called")).toMatchObject({ created: true });

      // Without orders.create: not even their own order.
      await withoutPermission(s, "dispatcher", "orders.create");
      await s.as(dispatcher);
      expect((await pgError(flag(s, mine.order_id, "Customer needs it before 9"))).code).toBe("42501");
      expect((await pgError(stops(s, mine.order_id, twoStops))).code).toBe("42501");
    });
  });

  it("another company's dispatcher cannot cancel, flag or give stops to a Top Line order", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      const mine = await saveOrder(s, { customer_id: ids.customerId, site_line1: "7 Phone-in Road", lines: standardLines(ids) });
      const B = await s.createCompany("Brookside Aggregates (test)");
      const bDispatcher = await s.createUser("dispatcher", { companyId: B });
      await s.as(bDispatcher);
      expect((await pgError(setStatus(s, mine.order_id, "canceled", "x"))).message).toMatch(/Order not found/);
      expect((await pgError(flag(s, mine.order_id, "Customer called"))).message).toMatch(/Order not found/);
      expect((await pgError(stops(s, mine.order_id, twoStops))).message).toMatch(/Order not found/);
      expect((await order(s, mine.order_id)).status).toBe("draft");
      await s.asAdmin();
      expect((await s.query("select 1 from public.order_urgencies where order_id = $1", [mine.order_id])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.order_stops where order_id = $1", [mine.order_id])).rowCount).toBe(0);
    });
  });

  it("the price list (effective_prices) answers quotes.view, orders.edit or orders.create, and no one else", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const prices = (s2: Session) => s2.query<{ material_id: string | null; rate_cents: string }>("select * from public.effective_prices($1, '2026-10-12')", [ids.customerId]);
      const dispatcher = await s.createUser("dispatcher");
      // A dispatcher who can create orders but not see quotes still gets the prices a new order needs.
      await withoutPermission(s, "dispatcher", "quotes.view");
      await s.as(dispatcher);
      const rows = (await prices(s)).rows;
      expect(rows.find((r) => r.material_id === ids.gravelId)?.rate_cents).toBe("1000");
      // Neither quotes.view nor orders.create (nor orders.edit): refused.
      await withoutPermission(s, "dispatcher", "orders.create");
      await s.as(dispatcher);
      expect((await pgError(prices(s))).code).toBe("42501");
      for (const role of ["driver", "mechanic"] as const) {
        await s.as(await s.createUser(role));
        expect((await pgError(prices(s))).code, role).toBe("42501");
      }
      // The office (quotes.view, orders.edit) as before.
      await s.as(await s.createUser("office"));
      expect((await prices(s)).rows.length).toBeGreaterThan(0);
    });
  });
});

describe("company isolation", () => {
  async function companyB(s: Session) {
    const B = await s.createCompany("Brookside Aggregates (test)");
    const bOwner = await s.createUser("owner", { companyId: B });
    await s.as(bOwner);
    const bCustomer = (await s.query<{ id: string }>("insert into public.customers (name) values ('Riverbend Builders (test)') returning id")).rows[0].id;
    return { B, bOwner, bCustomer };
  }

  it("another company cannot use Top Line customers, contacts, sites or materials in an order", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      await s.asAdmin();
      const tlContact = (await s.query<{ id: string }>("select id from customer_contacts where customer_id = $1 limit 1", [ids.contractCustomerId])).rows[0].id;
      const tlSite = (await s.query<{ id: string }>("select id from customer_sites where customer_id = $1 limit 1", [ids.contractCustomerId])).rows[0].id;
      const { bCustomer } = await companyB(s);
      const custom = { kind: "other", calc_method: "per_unit", description: "Hauling (test)", unit_code: "each", quantity: "1", unit_rate_cents: 10000 };

      expect((await pgError(saveOrder(s, { customer_id: ids.customerId, lines: [custom] }))).message).toMatch(/Select a customer/);
      expect((await pgError(saveOrder(s, { customer_id: bCustomer, lines: standardLines(ids) }))).message).toMatch(/material not found/);
      expect((await pgError(saveOrder(s, { customer_id: bCustomer, contact_id: tlContact, lines: [custom] }))).message).toMatch(/contact does not belong/);
      expect((await pgError(saveOrder(s, { customer_id: bCustomer, site_id: tlSite, lines: [custom] }))).message).toMatch(/job site does not belong/);

      // Its own order works and is numbered in its own sequence.
      const own = await saveOrder(s, { customer_id: bCustomer, lines: [custom] });
      expect(own.order_number).toMatch(/^ORD-1001$/);
    });
  });

  it("another company cannot see or change Top Line orders", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      const { orderId } = await acceptedQuote(s, ids);
      await companyB(s);
      for (const id of [r.order_id, orderId]) {
        expect((await s.query("select id from public.order_list where id = $1", [id])).rowCount).toBe(0);
        expect((await s.query("select id from public.audit_events where entity_id = $1", [id])).rowCount).toBe(0);
        expect((await pgError(details(s, id, { project_name: "hijack" }))).message).toMatch(/Order not found/);
        expect((await pgError(schedule(s, id, { scheduled_start: "2026-10-20" }))).message).toMatch(/Order not found/);
        expect((await pgError(setStatus(s, id, "canceled", "hijack"))).message).toMatch(/Order not found/);
      }
      expect((await pgError(saveOrder(s, { order_id: r.order_id, customer_id: ids.customerId, lines: [] }))).message).toMatch(/Select a customer|Order not found/);
      const after = await order(s, r.order_id);
      expect(after.status).toBe("draft");
      expect(after.project_name).toBe("Driveway base");
    });
  });
});

describe("sample data", () => {
  it("removing sample data also removes direct orders of sample customers", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      const owner = await s.createUser("owner");
      await s.as(owner);
      const res = await s.query<{ r: { direct_orders: number } }>("select public.remove_sample_data() as r");
      expect(res.rows[0].r.direct_orders).toBeGreaterThanOrEqual(1);
      await s.asAdmin();
      expect((await s.query("select 1 from public.orders where id = $1", [r.order_id])).rowCount).toBe(0);
    });
  });
});
