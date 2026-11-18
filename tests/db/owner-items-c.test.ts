// Owner decisions 2026-11-14 to 11-17, batch C: the invoicing question (INV1, 20261120024710), the PO asked for on
// acceptance (BL1, 20261120024730) and the driver's "Mistake on my ticket" (TM1, 20261120024720).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, sampleIds, saveQuote, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;

describe("who sends your invoices (INV1)", () => {
  it("a company that never chose is not counted as chosen; billing.manage answers; details never answer it", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany(`Invoicing Choice ${randomUUID().slice(0, 6)} (test)`);
      const owner = await s.createUser("owner", { companyId: company });
      const dispatcher = await s.createUser("dispatcher", { companyId: company });
      await s.as(owner);
      expect((await s.query("select 1 from public.invoicing_settings")).rowCount).toBe(0);
      // Payment terms on their own card: saved, the question still open.
      await s.query("select public.invoicing_save_details(14, 'Thank you (test)')");
      expect((await s.query("select issuer, terms_days, issuer_chosen_at from public.invoicing_settings")).rows[0]).toMatchObject({ issuer: "quickbooks", terms_days: 14, issuer_chosen_at: null });
      // The answer.
      await s.query("select public.invoicing_choose_issuer('taviron')");
      const row = (await s.query<{ issuer: string; terms_days: number; issuer_chosen_at: string | null; issuer_chosen_by: string }>("select issuer, terms_days, issuer_chosen_at, issuer_chosen_by from public.invoicing_settings")).rows[0];
      expect(row).toMatchObject({ issuer: "taviron", terms_days: 14, issuer_chosen_by: owner });
      expect(row.issuer_chosen_at).not.toBeNull();
      expect((await s.query("select 1 from public.audit_events where action = 'invoicing.issuer_chosen' and company_id = $1", [company])).rowCount).toBe(1);
      expect((await pgError(s.query("select public.invoicing_choose_issuer('excel')"))).code).toBe("22023");
      // Without billing.manage: refused.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.invoicing_choose_issuer('quickbooks')"))).code).toBe("42501");
      expect((await pgError(s.query("select public.invoicing_save_details(30, '')"))).code).toBe("42501");
    });
  });

  it("existing rows count as chosen, Top Line keeps QuickBooks, a demo's row is chosen when written", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      expect((await s.query<{ n: string }>("select count(*) n from public.invoicing_settings where issuer_chosen_at is null and company_id in (select id from public.companies where created_at < now() - interval '1 day')")).rows[0].n).toBe("0");
      const top = (await s.query<{ issuer: string; chosen: boolean }>("select issuer, issuer_chosen_at is not null as chosen from public.invoicing_settings where company_id = $1", [TOP_LINE])).rows[0];
      expect(top).toEqual({ issuer: "quickbooks", chosen: true });
      const demo = await s.createCompany(`Invoicing Demo ${randomUUID().slice(0, 6)} (test)`);
      await s.query("update public.companies set is_demo = true, demo_kind = (select demo_kind from public.companies where is_demo limit 1) where id = $1", [demo]);
      await s.query("insert into public.invoicing_settings (company_id, issuer, terms_days, footer) values ($1, 'taviron', 30, '')", [demo]);
      expect((await s.query("select 1 from public.invoicing_settings where company_id = $1 and issuer_chosen_at is not null", [demo])).rowCount).toBe(1);
    });
  });
});

describe("the PO on acceptance (BL1)", () => {
  it("records the PO on the accepted revision and its order; never overwrites one; works without", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const today = await businessToday(s);
      const office = await s.createUser("office");
      await s.as(office);
      const make = async () => {
        const q = await saveQuote(s, { customer_id: ids.customerId, quote_date: today, valid_until: addDays(today, 30), lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "10", unit_rate_cents: 1000 }] });
        await s.query("select public.mark_quote_sent($1, $2, 'Handed over (test)')", [q.quote_id, q.edit_seq]);
        return q;
      };
      const a = await make();
      await s.query("select public.quote_accept($1, 'By phone (test)', 'PO-77 (test)')", [a.quote_id]);
      expect((await s.query("select customer_po from public.quote_versions where id = $1", [a.version_id])).rows[0]).toEqual({ customer_po: "PO-77 (test)" });
      expect((await s.query("select status from public.quotes where id = $1", [a.quote_id])).rows[0]).toEqual({ status: "accepted" });
      expect((await s.query("select customer_po from public.orders where source_quote_id = $1", [a.quote_id])).rows[0]).toEqual({ customer_po: "PO-77 (test)" });
      expect((await s.query("select 1 from public.audit_events where action = 'quote.po_added' and entity_id = $1", [a.quote_id])).rowCount).toBe(1);
      // Without a PO: accepted all the same (a warning, never a block).
      const b = await make();
      await s.query("select public.quote_accept($1, '', '')", [b.quote_id]);
      expect((await s.query("select customer_po from public.quote_versions where id = $1", [b.version_id])).rows[0]).toEqual({ customer_po: "" });
      // An issued revision still cannot change any other way.
      expect((await pgError(s.query("update public.quote_versions set customer_po = 'X' where id = $1", [b.version_id]))).code).toBe("42501");
      // Someone without quotes.status: refused.
      const c = await make();
      await s.as(await s.createUser("dispatcher"));
      expect((await pgError(s.query("select public.quote_accept($1, '', 'PO-1')", [c.quote_id]))).code).toBe("42501");
    });
  });
});

describe("Mistake on my ticket (TM1)", () => {
  async function world(s: Session) {
    const today = await businessToday(s);
    const yesterday = addDays(today, -1);
    const office = await s.createUser("office");
    const f = await fleet(s, office, yesterday);
    const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
    const l1 = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
    const a1 = await assign(s, l1.load_id, f.t1, null, f.d1);
    const l2 = await planLoad(s, order.id, yesterday, "10:00", "12:00", { planned_quantity: "22", unit_code: "ton" });
    const a2 = await assign(s, l2.load_id, f.t2, null, f.d2);
    const driver1 = await s.createUser("driver");
    const driver2 = await s.createUser("driver");
    await s.as(office);
    await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driver1]);
    await s.query("update public.drivers set user_id = $2 where id = $1", [f.d2, driver2]);
    const send = async (driver: string, assignment: string, paper: string) => {
      await s.as(driver);
      return (await s.query<{ r: { ticket_id: string; ticket_number: string } }>("select public.driver_submit_ticket($1::jsonb) as r", [JSON.stringify({
        assignment_id: assignment, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30",
        quantity: "21.5", unit_code: "ton", external_reference: paper, notes: "", submission_key: randomUUID(),
      })])).rows[0].r;
    };
    const t1 = await send(driver1, a1, `P-${randomUUID().slice(0, 6)}`);
    const t2 = await send(driver2, a2, `P-${randomUUID().slice(0, 6)}`);
    return { office, driver1, driver2, t1, t2, order, f, l1, yesterday };
  }
  const report = (s: Session, p: Row) => s.query<{ r: { report_id: string; created: boolean } }>("select public.ticket_mistake_report($1::jsonb) as r", [JSON.stringify(p)]);

  it("a driver reports only on their own tickets, once per key; it goes to ticket review and is handled by a correction", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      // The paper number is on the driver's own ticket list after sending.
      const home = (await s.query<{ r: { tickets: Array<Row>; assignments: Array<{ tickets: Row[] }> } }>("select public.driver_portal_home() as r")).rows[0].r;
      const mine = home.tickets.find((t) => t.id === w.t1.ticket_id)!;
      expect(mine.paper_number).toMatch(/^P-/);
      expect(mine.mistake_reported).toBe(false);
      // A load card that still shows (a past load with its ticket leaves My Day) carries the same paper number.
      const onCard = home.assignments.flatMap((a) => a.tickets).find((t) => t.id === w.t1.ticket_id);
      if (onCard) expect(onCard.paper_number).toBe(mine.paper_number);

      const key = randomUUID();
      const first = (await report(s, { ticket_id: w.t1.ticket_id, field: "quantity", correct_value: "22.5", note: "Scale says 22.5 (test)", submission_key: key })).rows[0].r;
      expect(first.created).toBe(true);
      // The outbox sends it again: the same report.
      expect((await report(s, { ticket_id: w.t1.ticket_id, field: "quantity", correct_value: "22.5", note: "", submission_key: key })).rows[0].r).toEqual({ report_id: first.report_id, created: false });
      // Someone else's ticket, a bad field, nothing said: refused.
      expect((await pgError(report(s, { ticket_id: w.t2.ticket_id, field: "quantity", correct_value: "1", submission_key: randomUUID() }))).code).toBe("42501");
      expect((await pgError(report(s, { ticket_id: w.t1.ticket_id, field: "price", correct_value: "1", submission_key: randomUUID() }))).code).toBe("22023");
      expect((await pgError(report(s, { ticket_id: w.t1.ticket_id, field: "other", correct_value: "", note: "", submission_key: randomUUID() }))).code).toBe("22023");
      // The driver cannot write the table or the ticket.
      expect((await pgError(s.query("insert into public.ticket_mistake_reports (company_id, ticket_id, ticket_number, driver_id, field, note) select company_id, id, ticket_number, driver_id, 'other', 'x' from public.delivery_tickets limit 1"))).code).toBe("42501");
      expect((await pgError(s.query("update public.ticket_mistake_reports set status = 'resolved'"))).code).toBe("42501");
      expect((await s.query("select id from public.ticket_mistake_reports")).rows).toEqual([{ id: first.report_id }]);
      const after = (await s.query<{ r: { tickets: Array<Row> } }>("select public.driver_portal_home() as r")).rows[0].r;
      expect(after.tickets.find((t) => t.id === w.t1.ticket_id)?.mistake_reported).toBe(true);
      // The other driver sees nothing of it; a dispatcher's "can't complete" list is untouched (not a field report).
      await s.as(w.driver2);
      expect((await s.query("select 1 from public.ticket_mistake_reports")).rowCount).toBe(0);
      await s.as(await s.createUser("dispatcher"));
      expect((await s.query("select 1 from public.field_reports where description like '%Scale says 22.5%'")).rowCount).toBe(0);

      // The office's ticket review reads it; a dispatcher who sees tickets reads it too, but cannot handle it.
      await s.as(w.office);
      const open = (await s.query<{ ticket_number: string; field: string; correct_value: string }>("select ticket_number, field, correct_value from public.ticket_mistake_reports where status = 'open'")).rows;
      expect(open).toContainEqual({ ticket_number: w.t1.ticket_number, field: "quantity", correct_value: "22.5" });
      // The office corrects the ticket with the usual correction: the report is handled by itself.
      const paper = (await s.query<{ external_reference: string }>("select external_reference from public.delivery_tickets where id = $1", [w.t1.ticket_id])).rows[0].external_reference;
      await s.query("select public.correct_delivery_ticket($1, $2::jsonb, 'Driver reported the scale weight (test)')", [w.t1.ticket_id, JSON.stringify({
        load_id: w.l1.load_id, order_line_id: w.order.materialLine, delivered_date: w.yesterday, delivered_time: "08:30", quantity: "22.5", unit_code: "ton",
        external_reference: paper, notes: "", truck_id: w.f.t1, trailer_id: null, driver_id: w.f.d1, submission_key: randomUUID(),
      })]);
      const handled = (await s.query<{ status: string; resolution_note: string }>("select status, resolution_note from public.ticket_mistake_reports where id = $1", [first.report_id])).rows[0];
      expect(handled).toEqual({ status: "resolved", resolution_note: "Ticket corrected (revision 2)." });
    });
  });

  it("the office marks a report handled with a note (tickets.review); other companies never see it", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver2);
      const r = (await report(s, { ticket_id: w.t2.ticket_id, field: "ticket_number", correct_value: "4471", note: "", submission_key: randomUUID() })).rows[0].r;
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.ticket_mistake_resolve($1, 'ok')", [r.report_id]))).code).toBe("42501");
      await s.as(w.office);
      expect((await pgError(s.query("select public.ticket_mistake_resolve($1, '')", [r.report_id]))).code).toBe("22023");
      await s.query("select public.ticket_mistake_resolve($1, 'The ticket was right (test)')", [r.report_id]);
      expect((await s.query("select status, resolution_note from public.ticket_mistake_reports where id = $1", [r.report_id])).rows[0]).toEqual({ status: "resolved", resolution_note: "The ticket was right (test)" });
      expect((await s.query("select 1 from public.audit_events where action = 'ticket.mistake_handled' and company_id = $1", [TOP_LINE])).rowCount).toBeGreaterThan(0);
      const other = await s.createCompany(`Mistake Other ${randomUUID().slice(0, 6)} (test)`);
      await s.as(await s.createUser("office", { companyId: other }));
      expect((await s.query("select 1 from public.ticket_mistake_reports where id = $1", [r.report_id])).rowCount).toBe(0);
      expect((await s.query("select public.ticket_mistake_photo_path($1) as p", [r.report_id])).rows[0].p).toBeNull();
      expect((await pgError(s.query("select public.demo_ticket_mistake_sample()"))).code).toBe("42501");
    });
  });
});
