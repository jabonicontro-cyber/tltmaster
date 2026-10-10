import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, saveQuote, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Ids = Awaited<ReturnType<typeof sampleIds>>;

/** Owner creates a quote with an override and a discount, sends it, and the office marks it accepted. */
async function acceptedQuote(s: Session, ids: Ids, opts: { accept?: boolean } = {}) {
  const owner = await s.createUser("owner");
  await s.as(owner);
  const r = await saveQuote(s, {
    customer_id: ids.contractCustomerId,
    quote_date: "2026-10-01",
    valid_until: "2026-10-31",
    tax_rate_bp: 700,
    contact_name: "Pat Morgan",
    contact_email: "pat@lakeshore-paving.example",
    contact_phone: "(219) 555-0111",
    site_label: "Route 30 parking lot job",
    site_line1: "1500 Example Hwy",
    site_city: "Merrillville",
    site_state: "IN",
    site_postal_code: "46410",
    project_name: "Lot base",
    customer_po: "PO-778",
    job_instructions: "Enter from the east gate",
    terms: "Net 30",
    internal_notes: "Owner approved discount",
    lines: [
      // Customer rate is $9.00 — $8.50 is an owner-approved override.
      { kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "22.5", unit_rate_cents: 850, taxable: true },
      { kind: "hauling", calc_method: "per_unit", charge_item_id: ids.haulTonId, description: "Hauling", unit_code: "ton", quantity: "22.5", unit_rate_cents: 500 },
      { kind: "surcharge", calc_method: "percent_of_subtotal", charge_item_id: ids.fuelId, description: "Fuel", percent_bp: 500 },
      { kind: "discount", calc_method: "percent_of_subtotal", charge_item_id: ids.discountPctId, description: "Loyalty discount", percent_bp: 1000 },
    ],
  });
  await s.query("select public.mark_quote_sent($1, $2, 'Handed over')", [r.quote_id, r.edit_seq]);
  if (opts.accept !== false) {
    await s.query("select public.set_quote_status($1, 'accepted', 'Signed')", [r.quote_id]);
  }
  return { ...r, owner };
}

async function convert(s: Session, quoteId: string) {
  const res = await s.query<{ r: { order_id: string; order_number: string; created: boolean } }>(
    "select public.convert_quote_to_order($1) as r",
    [quoteId],
  );
  return res.rows[0].r;
}

describe("converting accepted quotes into orders", () => {
  it("creates a confirmed, numbered order that copies the accepted revision exactly", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const q = await acceptedQuote(s, ids);

      // Snapshot of the quote before conversion
      await s.asAdmin();
      const quoteBefore = await s.query("select * from public.quotes where id = $1", [q.quote_id]);
      const versionsBefore = await s.query("select * from public.quote_versions where quote_id = $1 order by version_no", [q.quote_id]);
      const linesBefore = await s.query("select * from public.quote_lines where quote_version_id = $1 order by line_no", [q.version_id]);

      const office = await s.createUser("office");
      await s.as(office);
      const r = await convert(s, q.quote_id);
      expect(r.created).toBe(true);
      expect(r.order_number).toMatch(/^O-\d{4}-\d{4}$/);

      const order = (await s.query("select * from public.orders where id = $1", [r.order_id])).rows[0];
      const version = versionsBefore.rows[0];
      expect(order).toMatchObject({
        status: "confirmed",
        customer_id: ids.contractCustomerId,
        source_quote_id: q.quote_id,
        source_quote_version_id: q.version_id,
        contact_name: "Pat Morgan",
        contact_email: "pat@lakeshore-paving.example",
        site_line1: "1500 Example Hwy",
        site_postal_code: "46410",
        project_name: "Lot base",
        customer_po: "PO-778",
        job_instructions: "Enter from the east gate",
        terms: "Net 30",
        tax_rate_bp: 700,
        subtotal_cents: version.subtotal_cents,
        discount_cents: version.discount_cents,
        tax_cents: version.tax_cents,
        total_cents: version.total_cents,
        is_sample: true,
        created_by: office,
      });
      expect(order.bill_to_snapshot).toEqual(version.bill_to_snapshot);
      expect(Number(order.discount_cents)).toBeGreaterThan(0);

      const orderLines = await s.query("select * from public.order_lines where order_id = $1 order by line_no", [r.order_id]);
      const pick = (l: Record<string, unknown>) => ({
        line_no: l.line_no, kind: l.kind, calc_method: l.calc_method, material_id: l.material_id, charge_item_id: l.charge_item_id,
        description: l.description, unit_code: l.unit_code, unit_label: l.unit_label, quantity: l.quantity,
        unit_rate_cents: l.unit_rate_cents, percent_bp: l.percent_bp, catalog_rate_cents: l.catalog_rate_cents,
        catalog_percent_bp: l.catalog_percent_bp, price_source: l.price_source, taxable: l.taxable, amount_cents: l.amount_cents,
      });
      expect(orderLines.rows.map(pick)).toEqual(linesBefore.rows.map(pick));
      expect(orderLines.rows.map((l) => l.source_quote_line_id)).toEqual(linesBefore.rows.map((l) => l.id));
      // Owner-approved override and discount are preserved, not re-priced.
      expect(orderLines.rows[0]).toMatchObject({ price_source: "override", unit_rate_cents: "850", catalog_rate_cents: "900" });
      expect(orderLines.rows[3]).toMatchObject({ kind: "discount" });
      expect(Number(orderLines.rows[3].amount_cents)).toBeLessThan(0);

      // The quote and its revisions are untouched.
      await s.asAdmin();
      const quoteAfter = await s.query("select * from public.quotes where id = $1", [q.quote_id]);
      expect(quoteAfter.rows[0]).toEqual(quoteBefore.rows[0]);
      expect((await s.query("select * from public.quote_versions where quote_id = $1 order by version_no", [q.quote_id])).rows).toEqual(versionsBefore.rows);
      expect((await s.query("select * from public.quote_lines where quote_version_id = $1 order by line_no", [q.version_id])).rows).toEqual(linesBefore.rows);

      // History and audit
      const events = await s.query("select from_status, to_status, note from public.order_status_events where order_id = $1", [r.order_id]);
      expect(events.rows).toEqual([{ from_status: null, to_status: "confirmed", note: expect.stringMatching(/^Created from quote Q-\d{4}-\d{4} revision 1$/) }]);
      const audit = await s.query("select action from public.audit_events where entity_id in ($1, $2)", [r.order_id, q.quote_id]);
      expect(audit.rows.map((a) => a.action)).toEqual(expect.arrayContaining(["order.created_from_quote", "quote.converted_to_order"]));
    });
  });

  it("converts the accepted revision, not an earlier one", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const q = await acceptedQuote(s, ids, { accept: false });
      await s.query("select public.revise_quote($1, 'More stone')", [q.quote_id]);
      const v2 = await saveQuote(s, {
        quote_id: q.quote_id,
        customer_id: ids.contractCustomerId,
        quote_date: "2026-10-02",
        valid_until: "2026-10-31",
        lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "40", unit_rate_cents: 900 }],
      });
      await s.query("select public.mark_quote_sent($1, $2, 'Emailed')", [q.quote_id, v2.edit_seq]);
      await s.query("select public.set_quote_status($1, 'accepted', '')", [q.quote_id]);
      const r = await convert(s, q.quote_id);
      const order = (await s.query("select source_quote_version_id, total_cents from public.orders where id = $1", [r.order_id])).rows[0];
      expect(order.source_quote_version_id).toBe(v2.version_id);
      expect(order.total_cents).toBe("36000");
    });
  });

  it("returns the same order when the conversion is repeated", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const q = await acceptedQuote(s, ids);
      const first = await convert(s, q.quote_id);
      const second = await convert(s, q.quote_id);
      expect(second).toEqual({ ...first, created: false });
      const count = await s.query("select count(*)::int as n from public.orders where source_quote_id = $1", [q.quote_id]);
      expect(count.rows[0].n).toBe(1);
      const lines = await s.query("select count(*)::int as n from public.order_lines where order_id = $1", [first.order_id]);
      expect(lines.rows[0].n).toBe(4);
    });
  });

  it("only accepted quotes can be converted", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      await s.as(owner);
      const draft = await saveQuote(s, {
        customer_id: ids.customerId,
        lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel", unit_code: "ton", quantity: "1", unit_rate_cents: 1000 }],
      });
      expect((await pgError(convert(s, draft.quote_id))).message).toMatch(/is draft\. Only accepted quotes/);

      await s.query("select public.mark_quote_sent($1, $2, 'Handed over')", [draft.quote_id, draft.edit_seq]);
      expect((await pgError(convert(s, draft.quote_id))).message).toMatch(/is sent\. Only accepted quotes/);

      await s.query("select public.set_quote_status($1, 'declined', 'Too expensive')", [draft.quote_id]);
      expect((await pgError(convert(s, draft.quote_id))).message).toMatch(/is declined/);

      await s.query("select public.set_quote_status($1, 'canceled', 'Closed out')", [draft.quote_id]);
      expect((await pgError(convert(s, draft.quote_id))).message).toMatch(/is canceled/);

      expect((await pgError(convert(s, "00000000-0000-0000-0000-000000000000"))).message).toMatch(/Quote not found/);
      const n = await s.query("select count(*)::int as n from public.orders where source_quote_id = $1", [draft.quote_id]);
      expect(n.rows[0].n).toBe(0);
    });
  });

  it("requires the orders.edit permission", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const q = await acceptedQuote(s, ids);

      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(convert(s, q.quote_id))).code).toBe("42501");

      const pending = await s.createUser(null);
      await s.as(pending);
      expect((await pgError(convert(s, q.quote_id))).code).toBe("42501");

      await s.as(null);
      expect((await pgError(convert(s, q.quote_id))).code).toBe("42501");

      // An owner can revoke the permission from office staff.
      const office = await s.createUser("office");
      await s.as(q.owner);
      await s.query("select public.set_role_permission('office', 'orders.edit', false)");
      await s.as(office);
      expect((await pgError(convert(s, q.quote_id))).code).toBe("42501");

      await s.asAdmin();
      const n = await s.query("select count(*)::int as n from public.orders where source_quote_id = $1", [q.quote_id]);
      expect(n.rows[0].n).toBe(0);
    });
  });

  it("orders are read-only to clients and visible according to orders.view", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const q = await acceptedQuote(s, ids);
      const r = await convert(s, q.quote_id);

      const office = await s.createUser("office");
      await s.as(office);
      expect((await pgError(s.query("update public.orders set total_cents = 1 where id = $1", [r.order_id]))).code).toBe("42501");
      expect((await pgError(s.query("update public.order_lines set unit_rate_cents = 1 where order_id = $1", [r.order_id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.orders where id = $1", [r.order_id]))).code).toBe("42501");
      expect((await pgError(s.query("insert into public.orders (order_number, customer_id) values ('X', $1)", [ids.customerId]))).code).toBe("42501");

      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await s.query("select * from public.order_list where id = $1", [r.order_id])).rowCount).toBe(1);

      const pending = await s.createUser(null);
      await s.as(pending);
      expect((await s.query("select * from public.orders")).rowCount).toBe(0);
    });
  });

  it("a converted quote can no longer change status", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const q = await acceptedQuote(s, ids);
      await convert(s, q.quote_id);
      const err = await pgError(s.query("select public.set_quote_status($1, 'canceled', 'Changed mind')", [q.quote_id]));
      expect(err.message).toMatch(/converted to an order/);
    });
  });

  it("two users converting at the same moment get one order", async () => {
    // Committed setup in its own transaction; cleaned up through sample-data removal.
    const setup = await pool.connect();
    let quoteId = "";
    let ownerId = "";
    try {
      await setup.query("begin");
      const s: Session = {
        client: setup,
        as: async (uid) => {
          await setup.query("reset role");
          await setup.query("set local role authenticated");
          await setup.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
        },
        asAdmin: async () => {
          await setup.query("reset role");
        },
        query: (sql, params) => setup.query(sql, params as unknown[]),
        createUser: async (role) => {
          await setup.query("reset role");
          const id = (await setup.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;
          await setup.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, `race-${id.slice(0, 8)}@test.example`]);
          await setup.query("update public.profiles set role = $2 where id = $1", [id, role]);
          return id;
        },
      };
      const ids = await sampleIds(s);
      const q = await acceptedQuote(s, ids);
      quoteId = q.quote_id;
      ownerId = q.owner;
      await setup.query("commit");
    } finally {
      setup.release();
    }

    const a = await pool.connect();
    const b = await pool.connect();
    const as = async (c: typeof a) => {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ownerId, role: "authenticated" })]);
    };
    try {
      await as(a);
      await as(b);
      const ra = await a.query("select public.convert_quote_to_order($1) as r", [quoteId]);
      const pb = b.query("select public.convert_quote_to_order($1) as r", [quoteId]); // waits for a's lock
      await new Promise((res) => setTimeout(res, 200));
      await a.query("commit");
      const rb = await pb;
      await b.query("commit");
      expect(ra.rows[0].r.created).toBe(true);
      expect(rb.rows[0].r).toEqual({ ...ra.rows[0].r, created: false });
      const n = await a.query("select count(*)::int as n from public.orders where source_quote_id = $1", [quoteId]);
      expect(n.rows[0].n).toBe(1);
    } finally {
      a.release();
      b.release();
      // Remove the committed sample quote and its order.
      const c = await pool.connect();
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ownerId, role: "authenticated" })]);
      await c.query("select set_config('tlt.sample_purge', 'on', true)");
      await c.query("reset role");
      await c.query("update public.quotes set current_version_id = null, accepted_version_id = null where id = $1", [quoteId]);
      await c.query("delete from public.quotes where id = $1", [quoteId]);
      await c.query("commit");
      c.release();
    }
  });

  it("sample-data removal also removes orders created from sample quotes", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const q = await acceptedQuote(s, ids);
      const r = await convert(s, q.quote_id);
      const counts = await s.query<{ c: Record<string, number> }>("select public.sample_data_counts() as c");
      expect(counts.rows[0].c.orders).toBeGreaterThanOrEqual(1);
      await s.query("select public.remove_sample_data()");
      expect((await s.query("select 1 from public.orders where id = $1", [r.order_id])).rowCount).toBe(0);
    });
  });
});
