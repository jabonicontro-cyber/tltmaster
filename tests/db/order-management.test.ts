// Order management: direct orders, editing, scheduling, status rules,
// pricing protection, audit history and company isolation.
import { afterAll, describe, expect, it } from "vitest";
import { calculateQuote } from "@/lib/quotes/calc";
import { canTransitionOrder, ORDER_STATUSES, orderTransitionPermission } from "@/lib/orders/status";
import { pgError, pool, sampleIds, saveQuote, TOP_LINE, withSession, type Session } from "./helpers";

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
  it("dispatchers schedule and move work along but cannot create, edit, confirm or cancel", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const r = await directOrder(s, ids);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(saveOrder(s, { customer_id: ids.customerId, lines: standardLines(ids) }))).code).toBe("42501");
      expect((await pgError(setStatus(s, r.order_id, "confirmed"))).code).toBe("42501");
      expect((await pgError(details(s, r.order_id, { project_name: "x" }))).code).toBe("42501");

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
