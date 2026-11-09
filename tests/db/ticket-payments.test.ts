// Payments by delivery ticket (TP1, migration 20261120009400): a ticket's billed amount is its share of the billed
// handoff (adds up exactly, per billing business); a payment is applied to tickets in full or in part, never beyond what
// is open or the payment itself; unapplied money stays visible; with Taviron invoicing the issued invoice is paid with it;
// voiding the payment reopens the tickets and voids its invoice payments, which cannot be voided on their own; other
// roles and companies see or change nothing.
import { afterAll, describe, expect, it } from "vitest";
import { businessToday, handedOff } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

type Share = { ticket_number: string; entity_id: string | null; cents: string };

describe("ticket shares", () => {
  it("splits a billed order over its tickets by quantity, spreads flat charges, tax and discount, and adds up exactly", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const A = "00000000-0000-4000-8000-0000000000aa";
      const B = "00000000-0000-4000-8000-0000000000bb";
      const snapshot = {
        order: { total_cents: 100_007 }, // lines 95_000 + tax and fees 5_007
        lines: [
          { line_id: "m", amount_cents: 60_000, billing_entity_id: A }, // material, 3 tickets 10 / 10 / 20 tons
          { line_id: "h", amount_cents: 30_001, billing_entity_id: B }, // hauling, billed per ton on the same tickets
          { line_id: "fuel", amount_cents: 5_000, billing_entity_id: B }, // flat, no tickets
          { line_id: "disc", amount_cents: -1, billing_entity_id: A }, // a discount line
        ],
        tickets: [
          { ticket_number: "T-1", order_line_id: "m", quantity: "10" },
          { ticket_number: "T-2", order_line_id: "m", quantity: "10" },
          { ticket_number: "T-3", order_line_id: "m", quantity: "20" },
          { ticket_number: "T-1", order_line_id: "h", quantity: "10" },
          { ticket_number: "T-2", order_line_id: "h", quantity: "10" },
          { ticket_number: "T-3", order_line_id: "h", quantity: "20" },
        ],
      };
      const rows = (await s.query<Share>("select * from private.handoff_ticket_shares($1::jsonb) order by ticket_number, entity_id", [JSON.stringify(snapshot)])).rows;
      const total = rows.reduce((t, r) => t + Number(r.cents), 0);
      expect(total).toBe(100_007);
      const byTicket = (n: string) => rows.filter((r) => r.ticket_number === n).reduce((t, r) => t + Number(r.cents), 0);
      // T-3 carried twice the tons, so about half of everything.
      expect(Math.abs(byTicket("T-3") - 50_003)).toBeLessThanOrEqual(2);
      expect(Math.abs(byTicket("T-1") - byTicket("T-2"))).toBeLessThanOrEqual(1);
      // Each share keeps the business that billed it.
      expect(new Set(rows.map((r) => r.entity_id))).toEqual(new Set([A, B]));
      expect(rows.filter((r) => r.entity_id === A).reduce((t, r) => t + Number(r.cents), 0)).toBeGreaterThan(55_000);
      // No tickets: nothing to pay by ticket.
      expect((await s.query("select * from private.handoff_ticket_shares($1::jsonb)", [JSON.stringify({ ...snapshot, tickets: [] })])).rowCount).toBe(0);
      // The split itself: always the exact total, largest remainders first.
      expect((await s.query<{ r: string[] }>("select private.split_cents(10, array[1,1,1]::numeric[]) r")).rows[0].r.map(Number)).toEqual([4, 3, 3]);
      expect((await s.query<{ r: string[] }>("select private.split_cents(-10, array[0,0]::numeric[]) r")).rows[0].r.map(Number)).toEqual([-5, -5]);
    });
  });
});

describe("payments by ticket", () => {
  it("applies payments to tickets, keeps the rest as credit, pays the Taviron invoice and reopens on void", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const { order, handoffOrder } = await handedOff(s, office);
      await s.as(owner);
      const customer = (await s.query<{ customer_id: string }>("select customer_id from public.orders where id = $1", [order.id])).rows[0].customer_id;
      type Bal = { issuer: string; tickets: Array<{ handoff_order_id: string; ticket_number: string; billed_cents: number; applied_cents: number; open_cents: number; invoice_number: string | null }>; payments: Array<{ id: string; unapplied_cents: number; voided: boolean }>; unapplied_cents: number };
      const balances = async () => (await s.query<{ r: Bal }>("select public.customer_ticket_balances($1) r", [customer])).rows[0].r;
      let b = await balances();
      const ticket = b.tickets.find((t) => t.handoff_order_id === handoffOrder)!;
      expect(ticket.billed_cents).toBeGreaterThan(0);
      expect(ticket.open_cents).toBe(ticket.billed_cents);
      const billed = ticket.billed_cents;
      const record = (amount: number, tickets: unknown[]) =>
        s.query<{ r: string }>("select public.customer_payment_record($1::jsonb) r", [JSON.stringify({ customer_id: customer, amount_cents: amount, received_on: null, method: "check", reference: "4471", note: "", tickets })]);
      const today = await businessToday(s);
      await s.as(owner);
      const pay = (amount: number, tickets: unknown[]) =>
        s.query<{ r: string }>("select public.customer_payment_record($1::jsonb) r", [JSON.stringify({ customer_id: customer, amount_cents: amount, received_on: today, method: "check", reference: "4471", note: "", tickets })]);

      // QuickBooks issuer (the default): tracked in Taviron only, no invoice payment.
      expect((await pgError(record(1000, []))).message).toMatch(/date/);
      expect((await pgError(pay(1000, [{ handoff_order_id: handoffOrder, ticket_number: ticket.ticket_number, amount_cents: billed + 1 }]))).message).toMatch(/left to pay/);
      expect((await pgError(pay(1000, [{ handoff_order_id: handoffOrder, ticket_number: "NOPE-1", amount_cents: 10 }]))).message).toMatch(/not a billed ticket/);
      expect((await pgError(pay(500, [{ handoff_order_id: handoffOrder, ticket_number: ticket.ticket_number, amount_cents: 600 }]))).message).toMatch(/more than the payment/);
      const part = Math.floor(billed / 3);
      const p1 = (await pay(part + 250, [{ handoff_order_id: handoffOrder, ticket_number: ticket.ticket_number, amount_cents: part }])).rows[0].r;
      b = await balances();
      expect(b.issuer).toBe("quickbooks");
      expect(b.tickets.find((t) => t.handoff_order_id === handoffOrder)!.open_cents).toBe(billed - part);
      expect(b.unapplied_cents).toBe(250);
      // The credit is applied later; never beyond what the payment has left.
      expect((await pgError(s.query("select public.customer_payment_apply($1, $2::jsonb)", [p1, JSON.stringify([{ handoff_order_id: handoffOrder, ticket_number: ticket.ticket_number, amount_cents: 251 }])]))).message).toMatch(/more than the payment/);
      await s.query("select public.customer_payment_apply($1, $2::jsonb)", [p1, JSON.stringify([{ handoff_order_id: handoffOrder, ticket_number: ticket.ticket_number, amount_cents: 250 }])]);
      b = await balances();
      expect(b.unapplied_cents).toBe(0);
      expect(b.tickets.find((t) => t.handoff_order_id === handoffOrder)!.open_cents).toBe(billed - part - 250);
      // Void: the ticket reopens.
      expect((await pgError(s.query("select public.customer_payment_void($1, ' ')", [p1]))).message).toMatch(/reason/);
      await s.query("select public.customer_payment_void($1, 'Check bounced')", [p1]);
      b = await balances();
      expect(b.tickets.find((t) => t.handoff_order_id === handoffOrder)!.open_cents).toBe(billed);

      // Taviron issuer: a ticket must be on an issued invoice, and the invoice is paid with it.
      await s.query("select public.invoicing_save_settings('taviron', 30, '')");
      expect((await pgError(pay(100, [{ handoff_order_id: handoffOrder, ticket_number: ticket.ticket_number, amount_cents: 100 }]))).message).toMatch(/not on an issued invoice/);
      const inv = (await s.query<{ r: string }>("select public.invoice_create($1) r", [handoffOrder])).rows[0].r;
      await s.query("select public.invoice_issue($1, null)", [inv]);
      const p2 = (await pay(part, [{ handoff_order_id: handoffOrder, ticket_number: ticket.ticket_number, amount_cents: part }])).rows[0].r;
      const invPays = (await s.query<{ id: string; amount_cents: string; customer_payment_id: string }>("select id, amount_cents, customer_payment_id from public.invoice_payments where invoice_id = $1 and voided_at is null", [inv])).rows;
      expect(invPays).toHaveLength(1);
      expect(Number(invPays[0].amount_cents)).toBe(part);
      expect(invPays[0].customer_payment_id).toBe(p2);
      b = await balances();
      expect(b.tickets.find((t) => t.handoff_order_id === handoffOrder)!.invoice_number).toMatch(/^INV-/);
      // Its invoice payment is voided with the ticket payment only.
      expect((await pgError(s.query("select public.invoice_void_payment($1, 'Wrong')", [invPays[0].id]))).message).toMatch(/payment by ticket/);
      await s.query("select public.customer_payment_void($1, 'Entered twice')", [p2]);
      expect((await s.query("select 1 from public.invoice_payments where invoice_id = $1 and voided_at is null", [inv])).rowCount).toBe(0);

      // Dispatchers neither see nor record payments; another company sees nothing.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.customer_ticket_balances($1)", [customer]))).code).toBe("42501");
      expect((await pgError(pay(100, []))).code).toBe("42501");
      expect((await s.query("select 1 from public.customer_payments")).rowCount).toBe(0);
      const otherCompany = await s.createCompany("Elsewhere Hauling");
      const otherOwner = await s.createUser("owner", { companyId: otherCompany });
      await s.as(otherOwner);
      expect((await pgError(s.query("select public.customer_ticket_balances($1)", [customer]))).message).toMatch(/Customer not found/);
      expect((await s.query("select 1 from public.ticket_payment_applications")).rowCount).toBe(0);
    });
  });
});
