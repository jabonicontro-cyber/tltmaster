import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, saveQuote, withSession, type LineInput, type Session } from "./helpers";

afterAll(() => pool.end());

function gravelLine(ids: Awaited<ReturnType<typeof sampleIds>>, overrides: Partial<LineInput> = {}): LineInput {
  return {
    kind: "material",
    calc_method: "per_unit",
    material_id: ids.gravelId,
    description: "Gravel #53 limestone",
    unit_code: "ton",
    quantity: "22.5",
    unit_rate_cents: 1000, // matches the sample standard rate
    taxable: true,
    ...overrides,
  };
}

function haulLine(ids: Awaited<ReturnType<typeof sampleIds>>, overrides: Partial<LineInput> = {}): LineInput {
  return {
    kind: "hauling",
    calc_method: "per_unit",
    charge_item_id: ids.haulTonId,
    description: "Hauling per ton",
    unit_code: "ton",
    quantity: "22.5",
    unit_rate_cents: 500,
    taxable: false,
    ...overrides,
  };
}

async function newDraft(s: Session, ids: Awaited<ReturnType<typeof sampleIds>>, extra: Record<string, unknown> = {}) {
  return saveQuote(s, {
    customer_id: ids.customerId,
    quote_date: "2026-10-01",
    valid_until: "2026-10-31",
    tax_rate_bp: 700,
    contact_name: "Sam Lee",
    contact_email: "sam@prairieview-landscape.example",
    site_label: "Subdivision phase 2",
    site_line1: "25 Sample Meadow Ct",
    site_city: "Chesterton",
    site_state: "IN",
    lines: [gravelLine(ids), haulLine(ids)],
    ...extra,
  });
}

describe("quote creation and calculation", () => {
  it("creates a numbered draft with database-computed totals and price snapshots", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const r = await newDraft(s, ids);
      expect(r.quote_number).toMatch(/^Q-\d{4}-\d{4}$/);
      expect(r.version_no).toBe(1);
      // 22.5 × $10.00 = $225.00 (taxable) + 22.5 × $5.00 = $112.50; tax 7% of 225 = $15.75
      expect(r.total_cents).toBe(22500 + 11250 + 1575);

      const v = await s.query("select * from public.quote_versions where id = $1", [r.version_id]);
      expect(v.rows[0]).toMatchObject({
        subtotal_cents: "33750",
        taxable_cents: "22500",
        tax_cents: "1575",
        total_cents: "35325",
        tax_rate_bp: 700,
      });
      const lines = await s.query("select * from public.quote_lines where quote_version_id = $1 order by line_no", [r.version_id]);
      expect(lines.rows.map((l) => [l.line_no, l.price_source, l.catalog_rate_cents, l.unit_label])).toEqual([
        [1, "standard", "1000", "Tons"],
        [2, "standard", "500", "Tons"],
      ]);
      const q = await s.query("select status, is_sample from public.quotes where id = $1", [r.quote_id]);
      expect(q.rows[0]).toEqual({ status: "draft", is_sample: true });
    });
  });

  it("uses customer-specific rates before the standard list", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const prices = await s.query("select * from public.effective_prices($1, '2026-10-01') where material_id = $2", [
        ids.contractCustomerId,
        ids.gravelId,
      ]);
      expect(prices.rows[0]).toMatchObject({ rate_cents: "900", source: "customer" });

      const r = await saveQuote(s, {
        customer_id: ids.contractCustomerId,
        quote_date: "2026-10-01",
        valid_until: "2026-10-31",
        lines: [gravelLine(ids, { unit_rate_cents: 900 })],
      });
      const line = await s.query("select price_source from public.quote_lines where quote_version_id = $1", [r.version_id]);
      expect(line.rows[0].price_source).toBe("customer");
    });
  });

  it("requires pricing.override to change a configured rate or add a discount", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");

      await s.as(office);
      const overrideErr = await pgError(newDraft(s, ids, { lines: [gravelLine(ids, { unit_rate_cents: 950 })] }));
      expect(overrideErr.code).toBe("42501");
      expect(overrideErr.message).toMatch(/override pricing/);

      const discountErr = await pgError(
        newDraft(s, ids, {
          lines: [gravelLine(ids), { kind: "discount", calc_method: "percent_of_subtotal", charge_item_id: ids.discountPctId, description: "Discount", percent_bp: 500 }],
        }),
      );
      expect(discountErr.code).toBe("42501");

      // Manual rates for items without a configured price are fine.
      const manual = await newDraft(s, ids, {
        lines: [{ kind: "other", calc_method: "per_unit", description: "Site cleanup", unit_code: "hour", quantity: "2", unit_rate_cents: 7500 }],
      });
      expect(manual.total_cents).toBe(15000);

      await s.as(owner);
      const r = await newDraft(s, ids, {
        tax_rate_bp: 0,
        lines: [
          gravelLine(ids, { unit_rate_cents: 950 }),
          { kind: "discount", calc_method: "percent_of_subtotal", charge_item_id: ids.discountPctId, description: "Discount", percent_bp: 1000 },
        ],
      });
      // 22.5 × 9.50 = 213.75; 10% discount = 21.375 → 21.38
      expect(r.total_cents).toBe(21375 - 2138);
      const lines = await s.query("select price_source, amount_cents from public.quote_lines where quote_version_id = $1 order by line_no", [r.version_id]);
      expect(lines.rows).toEqual([
        { price_source: "override", amount_cents: "21375" },
        { price_source: "manual", amount_cents: "-2138" },
      ]);
    });
  });

  it("validates input", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ lines: [gravelLine(ids, { quantity: "0" })] }, /quantity/i],
        [{ lines: [gravelLine(ids, { quantity: "1.2345" })] }, /quantity/i],
        [{ lines: [gravelLine(ids, { unit_code: "bogus" })] }, /unit/i],
        [{ lines: [gravelLine(ids, { unit_rate_cents: -1 })] }, /rate/i],
        [{ lines: [gravelLine(ids, { description: "  " })] }, /description/i],
        [{ valid_until: "2026-09-01" }, /expiration/i],
        [{ tax_rate_bp: 9999 }, /tax rate/i],
        [{ customer_id: "00000000-0000-0000-0000-000000000000" }, /customer/i],
      ];
      for (const [extra, re] of cases) {
        const err = await pgError(newDraft(s, ids, extra));
        expect(err.message, JSON.stringify(extra)).toMatch(re);
      }
    });
  });

  it("forces tax to zero for tax-exempt customers", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      await s.query("update public.customers set tax_exempt = true where id = $1", [ids.customerId]);
      const office = await s.createUser("office");
      await s.as(office);
      const r = await newDraft(s, ids);
      expect(r.total_cents).toBe(33750);
    });
  });

  it("detects concurrent edits", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const r = await newDraft(s, ids);
      const second = await newDraft(s, ids, { quote_id: r.quote_id, expected_edit_seq: r.edit_seq, project_name: "First save" });
      expect(second.edit_seq).toBe(r.edit_seq + 1);
      const stale = await pgError(newDraft(s, ids, { quote_id: r.quote_id, expected_edit_seq: r.edit_seq }));
      expect(stale.code).toBe("PT409");
    });
  });
});

describe("quote versions, sending and status", () => {
  async function sendSuccessfully(s: Session, quoteId: string, editSeq: number | null) {
    const issued = await s.query<{ r: { version_id: string } }>("select public.issue_quote_version($1, $2) as r", [quoteId, editSeq]);
    const versionId = issued.rows[0].r.version_id;
    await s.query(
      "select public.record_quote_delivery($1, $2, 'sent', array['sam@prairieview-landscape.example'], '{}', 'Quote', 'Body', 'test', 'msg-1', null, $3::jsonb)",
      [quoteId, versionId, JSON.stringify({ filename: "Q.pdf", sha256: "a".repeat(64), byte_size: 1234 })],
    );
    return versionId;
  }

  it("locks a sent version and blocks every kind of change to it", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const r = await newDraft(s, ids);
      const versionId = await sendSuccessfully(s, r.quote_id, r.edit_seq);
      expect(versionId).toBe(r.version_id);

      const q = await s.query("select status, first_sent_at from public.quotes where id = $1", [r.quote_id]);
      expect(q.rows[0].status).toBe("sent");
      expect(q.rows[0].first_sent_at).not.toBeNull();

      const v = await s.query("select locked_at, sent_at, bill_to_snapshot, company_snapshot from public.quote_versions where id = $1", [versionId]);
      expect(v.rows[0].locked_at).not.toBeNull();
      expect(v.rows[0].bill_to_snapshot.name).toBe("Prairie View Landscaping");
      expect(v.rows[0].company_snapshot.company_name).toBeTruthy();

      // Editing through the function is refused
      const editErr = await pgError(newDraft(s, ids, { quote_id: r.quote_id }));
      expect(editErr.message).toMatch(/revision/i);

      // Even the database owner cannot change an issued version or its lines
      await s.asAdmin();
      expect((await pgError(s.query("update public.quote_versions set total_cents = 1 where id = $1", [versionId]))).message).toMatch(/issued/);
      expect((await pgError(s.query("update public.quote_lines set amount_cents = 1 where quote_version_id = $1", [versionId]))).message).toMatch(/issued/);
      expect((await pgError(s.query("delete from public.quote_lines where quote_version_id = $1", [versionId]))).message).toMatch(/issued/);
      expect((await pgError(s.query("delete from public.quote_versions where id = $1", [versionId]))).message).toMatch(/issued/);

      const deliveries = await s.query("select status, to_addresses, document_id from public.email_deliveries where quote_id = $1", [r.quote_id]);
      expect(deliveries.rows[0].status).toBe("sent");
      expect(deliveries.rows[0].document_id).not.toBeNull();
    });
  });

  it("revises without overwriting the sent version", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const r = await newDraft(s, ids);
      const v1 = await sendSuccessfully(s, r.quote_id, r.edit_seq);

      expect((await pgError(s.query("select public.revise_quote($1, '')", [r.quote_id]))).message).toMatch(/reason/i);
      const rev = await s.query<{ r: { version_id: string; version_no: number } }>(
        "select public.revise_quote($1, 'Customer asked for more stone') as r",
        [r.quote_id],
      );
      const v2 = rev.rows[0].r.version_id;
      expect(rev.rows[0].r.version_no).toBe(2);

      const q = await s.query("select status, current_version_id from public.quotes where id = $1", [r.quote_id]);
      expect(q.rows[0]).toEqual({ status: "draft", current_version_id: v2 });

      const edit = await newDraft(s, ids, {
        quote_id: r.quote_id,
        lines: [gravelLine(ids, { quantity: "40" })],
      });
      expect(edit.version_id).toBe(v2);
      expect(edit.total_cents).toBe(40000 + 2800);

      const versions = await s.query(
        "select version_no, total_cents, locked_at is not null as locked, revision_reason from public.quote_versions where quote_id = $1 order by version_no",
        [r.quote_id],
      );
      expect(versions.rows).toEqual([
        { version_no: 1, total_cents: "35325", locked: true, revision_reason: "" },
        { version_no: 2, total_cents: "42800", locked: false, revision_reason: "Customer asked for more stone" },
      ]);
      const v1Lines = await s.query("select count(*)::int as n from public.quote_lines where quote_version_id = $1", [v1]);
      expect(v1Lines.rows[0].n).toBe(2);

      const events = await s.query("select from_status, to_status from public.quote_status_events where quote_id = $1 order by occurred_at, id", [r.quote_id]);
      expect(events.rows.map((e) => `${e.from_status ?? "-"}>${e.to_status}`)).toEqual(
        expect.arrayContaining(["->draft", "draft>sent", "sent>draft"]),
      );
    });
  });

  it("a failed email does not mark the quote sent and releases the lock", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const r = await newDraft(s, ids);
      const issued = await s.query<{ r: { version_id: string } }>("select public.issue_quote_version($1, $2) as r", [r.quote_id, r.edit_seq]);
      await s.query(
        "select public.record_quote_delivery($1, $2, 'failed', array['x@example.com'], '{}', 'Quote', 'Body', 'resend', null, 'SMTP timeout', null)",
        [r.quote_id, issued.rows[0].r.version_id],
      );
      const q = await s.query("select status, first_sent_at from public.quotes where id = $1", [r.quote_id]);
      expect(q.rows[0]).toEqual({ status: "draft", first_sent_at: null });
      const v = await s.query("select locked_at, sent_at from public.quote_versions where id = $1", [r.version_id]);
      expect(v.rows[0]).toEqual({ locked_at: null, sent_at: null });
      // still editable
      const again = await newDraft(s, ids, { quote_id: r.quote_id, project_name: "Fixed" });
      expect(again.version_id).toBe(r.version_id);
      const failed = await s.query("select status, error_message from public.email_deliveries where quote_id = $1", [r.quote_id]);
      expect(failed.rows).toEqual([{ status: "failed", error_message: "SMTP timeout" }]);
    });
  });

  it("preview mode records the attempt without sending", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const r = await newDraft(s, ids);
      await s.query(
        "select public.record_quote_delivery($1, $2, 'preview', array['x@example.com'], '{}', 'Quote', 'Body', 'preview', null, null, null)",
        [r.quote_id, r.version_id],
      );
      const q = await s.query("select status from public.quotes where id = $1", [r.quote_id]);
      expect(q.rows[0].status).toBe("draft");
      expect((await pgError(s.query(
        "select public.record_quote_delivery($1, $2, 'sent', array['x@example.com'], '{}', 'Quote', 'Body', 'x', null, null, null)",
        [r.quote_id, r.version_id],
      ))).message).toMatch(/issued/);
    });
  });

  it("marks a quote sent manually with a note", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const r = await newDraft(s, ids);
      expect((await pgError(s.query("select public.mark_quote_sent($1, $2, '')", [r.quote_id, r.edit_seq]))).message).toMatch(/how the quote was delivered/);
      await s.query("select public.mark_quote_sent($1, $2, 'Printed and handed to customer')", [r.quote_id, r.edit_seq]);
      const q = await s.query("select status from public.quotes where id = $1", [r.quote_id]);
      expect(q.rows[0].status).toBe("sent");
    });
  });

  it("enforces status transitions", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(office);
      const r = await newDraft(s, ids);

      expect((await pgError(s.query("select public.set_quote_status($1, 'accepted', '')", [r.quote_id]))).message).toMatch(/draft quote cannot be marked accepted/);
      await sendSuccessfully(s, r.quote_id, r.edit_seq);

      await s.as(dispatcher);
      expect((await pgError(s.query("select public.set_quote_status($1, 'accepted', '')", [r.quote_id]))).code).toBe("42501");

      await s.as(office);
      expect((await pgError(s.query("select public.set_quote_status($1, 'declined', '')", [r.quote_id]))).message).toMatch(/reason/i);
      await s.query("select public.set_quote_status($1, 'accepted', 'Signed by phone')", [r.quote_id]);
      const q = await s.query("select status, accepted_version_id, accepted_at from public.quotes where id = $1", [r.quote_id]);
      expect(q.rows[0].status).toBe("accepted");
      expect(q.rows[0].accepted_version_id).toBe(r.version_id);

      expect((await pgError(s.query("select public.revise_quote($1, 'x')", [r.quote_id]))).message).toMatch(/only sent, declined or expired/i);
      await s.query("select public.set_quote_status($1, 'canceled', 'Job canceled by customer')", [r.quote_id]);
      expect((await pgError(s.query("select public.set_quote_status($1, 'accepted', '')", [r.quote_id]))).message).toMatch(/canceled quote cannot/);

      await s.asAdmin();
      const audit = await s.query("select action from public.audit_events where entity_id = $1 order by occurred_at", [r.quote_id]);
      expect(audit.rows.map((a) => a.action)).toEqual(
        expect.arrayContaining(["quote.created", "quote.issued", "quote.emailed", "quote.status_changed"]),
      );
    });
  });
});

describe("quote numbering under concurrency", () => {
  it("allocates distinct sequential numbers when two users save at the same time", async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      const first = await a.query<{ n: string }>("select private.next_document_number('quote') as n");
      // b blocks on the sequence row until a commits
      const secondPromise = b.query<{ n: string }>("select private.next_document_number('quote') as n");
      let settled = false;
      void secondPromise.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await a.query("commit");
      const second = await secondPromise;
      await b.query("rollback");
      const num = (s: string) => Number(s.split("-").pop());
      expect(num(second.rows[0].n)).toBe(num(first.rows[0].n) + 1);
    } finally {
      a.release();
      b.release();
    }
  });
});

describe("sample data removal", () => {
  it("removes sample records and keeps real ones", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      await s.as(owner);
      const r = await newDraft(s, ids);
      await s.query("select public.mark_quote_sent($1, $2, 'Handed over')", [r.quote_id, r.edit_seq]);
      const real = await s.query<{ id: string }>("insert into public.customers (name) values ('Real Customer Inc') returning id");

      const res = await s.query<{ r: Record<string, number> }>("select public.remove_sample_data() as r");
      expect(res.rows[0].r.quotes).toBe(1);
      expect(res.rows[0].r.customers).toBe(4);

      const counts = await s.query<{ c: Record<string, number> }>("select public.sample_data_counts() as c");
      expect(counts.rows[0].c).toEqual({ customers: 0, materials: 0, charge_items: 0, price_lists: 0, quotes: 0 });
      expect((await s.query("select 1 from public.customers where id = $1", [real.rows[0].id])).rowCount).toBe(1);
    });
  });
});
