// One invoice for several orders (UX10, migration 20261120007000): orders of one customer combine into one draft whose
// lines name their order and whose totals add up; an order is never on two active invoices (alone or combined);
// voiding frees the orders; other customers, QuickBooks companies, other roles and other companies are refused.
import { afterAll, describe, expect, it } from "vitest";
import { handedOff } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

type Inv = { status: string; order_number: string; total_cents: string; subtotal_cents: string; tax_cents: string; lines: Array<{ description: string; line_no: number; order_number: string }>; customer_po: string; service_start: string; service_end: string };

describe("invoice for several orders", () => {
  it("combines handed-off orders of one customer and never bills an order twice", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const a = await handedOff(s, office);
      const b = await handedOff(s, office);
      const c = await handedOff(s, office);

      // QuickBooks issues by default: refused until the company chooses Taviron.
      await s.as(owner);
      expect((await pgError(s.query("select public.invoice_create_combined($1::uuid[])", [[a.handoffOrder, b.handoffOrder]]))).message).toMatch(/issues invoices in QuickBooks/);
      await s.query("select public.invoicing_save_settings('taviron', 30, '')");

      // The candidates list the three orders; a dispatcher cannot combine; one order alone is refused.
      const cand = (await s.query<{ handoff_order_id: string; customer_id: string }>("select handoff_order_id, customer_id from public.invoice_combine_candidates()")).rows;
      for (const h of [a, b, c]) expect(cand.some((r) => r.handoff_order_id === h.handoffOrder)).toBe(true);
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.invoice_create_combined($1::uuid[])", [[a.handoffOrder, b.handoffOrder]]))).code).toBe("42501");
      await s.as(office);
      expect((await pgError(s.query("select public.invoice_create_combined($1::uuid[])", [[a.handoffOrder, a.handoffOrder]]))).message).toMatch(/at least two/);

      // Combine a and b: the lines of both, each naming its order, numbered in sequence; totals add up.
      const snap = async (h: string) => (await s.query<{ t: string; st: string }>("select snapshot->'order'->>'total_cents' t, snapshot->'order'->>'subtotal_cents' st from public.billing_handoff_orders where id = $1", [h])).rows[0];
      const [sa, sb] = [await snap(a.handoffOrder), await snap(b.handoffOrder)];
      const inv = (await s.query<{ r: string }>("select public.invoice_create_combined($1::uuid[]) r", [[b.handoffOrder, a.handoffOrder]])).rows[0].r;
      const row = (await s.query<Inv>("select status, order_number, total_cents, subtotal_cents, tax_cents, lines, customer_po, service_start, service_end from public.invoices where id = $1", [inv])).rows[0];
      expect(row.status).toBe("draft");
      expect(row.order_number.split(", ").sort()).toEqual([a.order.number, b.order.number].sort());
      expect(Number(row.total_cents)).toBe(Number(sa.t) + Number(sb.t));
      expect(Number(row.subtotal_cents)).toBe(Number(sa.st) + Number(sb.st));
      expect(row.lines.length).toBe(a.snapshot.lines.length + b.snapshot.lines.length);
      expect(row.lines.map((l) => l.line_no)).toEqual(row.lines.map((_, i) => i + 1));
      for (const l of row.lines) expect(l.description).toMatch(new RegExp(`^Order ${l.order_number} · `));
      const listed = (await s.query<{ order_number: string; position: number; total_cents: string }>("select order_number, position, total_cents from public.invoice_orders where invoice_id = $1 order by position", [inv])).rows;
      expect(listed.map((o) => o.position)).toEqual([1, 2]);
      expect(listed.reduce((t, o) => t + Number(o.total_cents), 0)).toBe(Number(row.total_cents));

      // Neither order can be invoiced again, alone or combined; they are no longer candidates.
      expect((await pgError(s.query("select public.invoice_create($1)", [a.handoffOrder]))).code).toBe("23505");
      expect((await pgError(s.query("select public.invoice_create($1)", [b.handoffOrder]))).code).toBe("23505");
      expect((await pgError(s.query("select public.invoice_create_combined($1::uuid[])", [[b.handoffOrder, c.handoffOrder]]))).message).toMatch(/already has an invoice/);
      const left = (await s.query<{ handoff_order_id: string }>("select handoff_order_id from public.invoice_combine_candidates()")).rows.map((r) => r.handoff_order_id);
      expect(left).toContain(c.handoffOrder);
      expect(left).not.toContain(a.handoffOrder);
      expect(left).not.toContain(b.handoffOrder);

      // A single invoice for c, then c cannot join a combined invoice either.
      const single = (await s.query<{ r: string }>("select public.invoice_create($1) r", [c.handoffOrder])).rows[0].r;
      expect((await s.query<{ n: string }>("select count(*) n from public.invoice_orders where invoice_id = $1 and active", [single])).rows[0].n).toBe("1");

      // Voiding the combined invoice frees both orders: they can be combined again.
      await s.query("select public.invoice_void($1, 'Wrong PO')", [inv]);
      expect((await s.query<{ n: string }>("select count(*) n from public.invoice_orders where invoice_id = $1 and active", [inv])).rows[0].n).toBe("0");
      const again = (await s.query<{ r: string }>("select public.invoice_create_combined($1::uuid[]) r", [[a.handoffOrder, b.handoffOrder]])).rows[0].r;
      expect(again).not.toBe(inv);

      // An undone handoff cannot be combined.
      await s.query("select public.invoice_void($1, 'Redo')", [again]);
      await s.query("select public.revert_billing_handoff($1, 'Mistake')", [b.handoffOrder]);
      expect((await pgError(s.query("select public.invoice_create_combined($1::uuid[])", [[a.handoffOrder, b.handoffOrder]]))).message).toMatch(/was undone/);

      // Another company sees none of it and cannot combine these orders.
      const otherCompany = await s.createCompany("Other hauling (test)");
      const other = await s.createUser("owner", { companyId: otherCompany });
      await s.as(other);
      expect((await s.query("select * from public.invoice_orders")).rows.length).toBe(0);
      expect((await s.query("select * from public.invoice_combine_candidates()")).rows.length).toBe(0);
      expect((await pgError(s.query("select public.invoice_create_combined($1::uuid[])", [[a.handoffOrder, c.handoffOrder]]))).message).toMatch(/QuickBooks|not found/);
    });
  });

  it("refuses orders of different customers", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const a = await handedOff(s, office);
      const b = await handedOff(s, office);
      await s.as(owner);
      await s.query("select public.invoicing_save_settings('taviron', 30, '')");
      // Move b's order to another customer of the company (setup).
      await s.asAdmin();
      const cust = (await s.query<{ id: string }>("select c.id from public.customers c join public.orders o on o.company_id = c.company_id where o.id = $1 and c.id <> o.customer_id limit 1", [b.order.id])).rows[0];
      expect(cust).toBeTruthy();
      await s.query("set local session_replication_role = replica");
      await s.query("update public.orders set customer_id = $1 where id = $2", [cust.id, b.order.id]);
      await s.query("set local session_replication_role = origin");
      await s.as(office);
      expect((await pgError(s.query("select public.invoice_create_combined($1::uuid[])", [[a.handoffOrder, b.handoffOrder]]))).message).toMatch(/same customer/);
    });
  });
});
