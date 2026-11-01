// Invoicing and receivables (B99, migration 20261120004800): with Taviron issuing, a handed-off order becomes a draft
// invoice from its frozen snapshot, issuing numbers it and sets its due date, payments never exceed what is owed,
// voiding needs a reason and never deletes, one active invoice per handoff, QuickBooks companies are refused, and
// other companies and roles see or change nothing.
import { afterAll, describe, expect, it } from "vitest";
import { handedOff } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

type Inv = { status: string; number: string | null; total_cents: string; issue_date: string | null; due_date: string | null; order_number: string; lines: unknown[]; bill_to: { name: string } };

describe("invoicing", () => {
  it("drafts, issues, records payments and voids invoices for handed-off orders", async () => {
    await withSession(async (s) => {
      // What is still owed, read the way the app reads it (invoice total less active payments).
      const balance = async (id: string) => Number((await s.query<{ b: string }>(
        "select i.total_cents - coalesce((select sum(amount_cents) from public.invoice_payments p where p.invoice_id = i.id and p.voided_at is null), 0) b from public.invoices i where i.id = $1", [id])).rows[0].b);
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const { order, handoffOrder } = await handedOff(s, office);

      // QuickBooks issues by default: Taviron refuses to invoice until the company chooses Taviron.
      await s.as(owner);
      expect((await pgError(s.query("select public.invoice_create($1)", [handoffOrder]))).message).toMatch(/issues invoices in QuickBooks/);
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.invoicing_save_settings('taviron', 30, '')"))).code).toBe("42501");
      await s.as(owner);
      expect((await pgError(s.query("select public.invoicing_save_settings('taviron', 200, '')"))).message).toMatch(/0 to 120/);
      await s.query("select public.invoicing_save_settings('taviron', 15, 'Thank you')");

      // A draft from the frozen handoff: no number yet; only one active invoice per handoff.
      const inv = (await s.query<{ r: string }>("select public.invoice_create($1) r", [handoffOrder])).rows[0].r;
      let row = (await s.query<Inv>("select status, number, total_cents, issue_date, due_date, order_number, lines, bill_to from public.invoices where id = $1", [inv])).rows[0];
      expect(row.status).toBe("draft");
      expect(row.number).toBeNull();
      expect(row.order_number).toBe(order.number);
      expect(row.lines.length).toBeGreaterThan(0);
      expect(Number(row.total_cents)).toBeGreaterThan(0);
      expect((await pgError(s.query("select public.invoice_create($1)", [handoffOrder]))).code).toBe("23505");
      expect((await pgError(s.query("select public.invoice_add_payment($1, 100, current_date, 'check')", [inv]))).message).toMatch(/issued invoices only/);

      // Issue: numbered INV-…, due after the terms; a second issue is refused.
      await s.query("select public.invoice_issue($1, null)", [inv]);
      row = (await s.query<Inv>("select status, number, total_cents, issue_date, due_date, order_number, lines, bill_to from public.invoices where id = $1", [inv])).rows[0];
      expect(row.status).toBe("issued");
      expect(row.number).toMatch(/^INV-\d{4,}$/);
      const total = Number(row.total_cents);
      expect((await pgError(s.query("select public.invoice_issue($1, null)", [inv]))).message).toMatch(/Only a draft/);

      // Payments: never more than is owed; a void needs a reason; the balance follows.
      expect((await pgError(s.query("select public.invoice_add_payment($1, $2, current_date, 'check')", [inv, total + 1]))).message).toMatch(/more than/);
      const p1 = (await s.query<{ r: string }>("select public.invoice_add_payment($1, $2, current_date, 'check', '1001', '') r", [inv, Math.floor(total / 2)])).rows[0].r;
      expect(await balance(inv)).toBe(total - Math.floor(total / 2));
      // The invoice cannot be voided while it has payments.
      expect((await pgError(s.query("select public.invoice_void($1, 'Wrong customer')", [inv]))).message).toMatch(/Void the payments first/);
      expect((await pgError(s.query("select public.invoice_void_payment($1, ' ')", [p1]))).message).toMatch(/reason/);
      await s.query("select public.invoice_void_payment($1, 'Check bounced')", [p1]);
      expect(await balance(inv)).toBe(total);

      // Sending is recorded only when real; a preview is logged, not marked sent.
      await s.query("select public.invoice_record_sent($1, array['ap@example.test'], true)", [inv]);
      expect((await s.query<{ sent_at: string | null }>("select sent_at from public.invoices where id = $1", [inv])).rows[0].sent_at).toBeNull();
      await s.query("select public.invoice_record_sent($1, array['ap@example.test'], false)", [inv]);
      expect((await s.query<{ sent_at: string | null }>("select sent_at from public.invoices where id = $1", [inv])).rows[0].sent_at).not.toBeNull();

      // Void: kept with its number and reason; a new invoice can then be made for the same handoff.
      await s.query("select public.invoice_void($1, 'Re-invoiced with the right PO')", [inv]);
      row = (await s.query<Inv>("select status, number, total_cents, issue_date, due_date, order_number, lines, bill_to from public.invoices where id = $1", [inv])).rows[0];
      expect(row.status).toBe("void");
      expect(row.number).toMatch(/^INV-/);
      const again = (await s.query<{ r: string }>("select public.invoice_create($1) r", [handoffOrder])).rows[0].r;
      expect(again).not.toBe(inv);

      // QuickBooks cannot also invoice an order Taviron invoiced (a simulated demo send is not an invoice).
      await s.asAdmin();
      const company = (await s.query<{ c: string }>("select company_id c from public.invoices where id = $1", [again])).rows[0].c;
      expect((await pgError(s.query("insert into public.accounting_invoice_sends (company_id, handoff_order_id, status) values ($1, $2, 'sending')", [company, handoffOrder]))).message).toMatch(/already has a Taviron invoice/);

      // Read-only roles and other companies.
      await s.as(dispatcher);
      expect((await s.query("select id from public.invoices where id = $1", [again])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.invoice_issue($1, null)", [again]))).code).toBe("42501");
      const other = await s.createCompany("Other Invoice Co (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select id from public.invoices where id = $1", [again])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.invoice_issue($1, null)", [again]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.demo_invoice_samples()"))).code).toBe("42501");
      // Every company got an invoice number sequence.
      await s.asAdmin();
      expect((await s.query("select 1 from public.document_sequences where company_id = $1 and key = 'invoice'", [other])).rowCount).toBe(1);
    });
  });
});
