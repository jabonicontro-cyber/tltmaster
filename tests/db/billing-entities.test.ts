// Billing businesses (20261120003400) and QuickBooks sends (20261120003500): a handoff snapshot split between businesses
// by charge type, who may change businesses and rules, one claimed send per order and business (never two invoices),
// simulated sends only in demo companies, token secrets unreadable by app users, and company isolation.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;
type Snapshot = { lines: Array<{ kind: string; billing_entity_id?: string; billing_entity_name?: string }> };

const saveEntity = async (s: Session, p: Row, id: string | null = null) =>
  (await s.query<{ id: string }>("select public.billing_entity_save($1, $2::jsonb) as id", [id, JSON.stringify(p)])).rows[0].id;
const begin = async (s: Session, handoffOrder: string, entity: string | null, simulated: boolean) =>
  (await s.query<{ r: Row }>("select public.accounting_begin_send($1, $2, $3) as r", [handoffOrder, entity, simulated])).rows[0].r;
const finish = (s: Session, send: string, ok: boolean, number = "", error = "") =>
  s.query("select public.accounting_finish_send($1, $2, $3, $4, 1000, 1000, $5)", [send, ok, ok ? "QBO-1" : null, number, error]);

/** A completed, acknowledged order (a material line and a hauling line) handed off for billing. */
async function handedOff(s: Session, office: string) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
  await assign(s, load.load_id, f.t1, null, f.d1);
  await s.as(office);
  const t = (await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
    load_id: load.load_id, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:00", quantity: "40", unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 8)}`,
  })])).rows[0].r;
  await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
  await s.query("select public.set_order_status($1, 'in_progress', '')", [order.id]);
  await s.query("select public.set_order_status($1, 'completed', '')", [order.id]);
  const st = (await s.query<Row>("select exceptions_fingerprint from public.billing_order_status where order_id = $1", [order.id])).rows[0];
  if (st?.exceptions_fingerprint) await s.query("select public.acknowledge_billing_exceptions($1, $2, 'Test')", [order.id, st.exceptions_fingerprint]);
  await s.query("select public.hand_off_orders($1::uuid[], '', '', $2)", [[order.id], randomUUID()]);
  const h = (await s.query<{ id: string; snapshot: Snapshot }>("select id, snapshot from public.billing_handoff_orders where order_id = $1", [order.id])).rows[0];
  return { order, handoffOrder: h.id, snapshot: h.snapshot };
}

describe("billing businesses", () => {
  it("splits a handoff snapshot between businesses by charge type; only billing managers change them", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const trucking = await saveEntity(s, { name: "Test Trucking", invoice_prefix: "tr", is_default: true });
      const stone = await saveEntity(s, { name: "Test Stone & Sand", invoice_prefix: "SS" });
      expect((await pgError(saveEntity(s, { name: "Bad prefix", invoice_prefix: "TOO-LONG" }))).message).toMatch(/prefix/i);
      expect((await pgError(saveEntity(s, { name: " " }))).message).toMatch(/name/);
      // One default: making Stone the default moves it from Trucking.
      await saveEntity(s, { name: "Test Stone & Sand", invoice_prefix: "SS", is_default: true }, stone);
      expect((await s.query("select name from public.billing_entities where is_default")).rows).toEqual([{ name: "Test Stone & Sand" }]);
      await saveEntity(s, { name: "Test Trucking", invoice_prefix: "TR", is_default: true }, trucking);
      expect((await s.query("select invoice_prefix from public.billing_entities where id = $1", [trucking])).rows[0].invoice_prefix).toBe("TR");

      await s.query("select public.billing_entity_rules_save($1::jsonb)", [JSON.stringify({ material: stone, hauling: "" })]);
      const { snapshot } = await handedOff(s, office);
      const material = snapshot.lines.find((l) => l.kind === "material")!;
      const hauling = snapshot.lines.find((l) => l.kind === "hauling")!;
      expect(material).toMatchObject({ billing_entity_id: stone, billing_entity_name: "Test Stone & Sand" });
      // No rule: the default business.
      expect(hauling).toMatchObject({ billing_entity_id: trucking, billing_entity_name: "Test Trucking" });

      for (const role of ["dispatcher", "driver"] as const) {
        await s.as(await s.createUser(role));
        expect((await pgError(saveEntity(s, { name: "Not allowed" }))).code).toBe("42501");
        expect((await pgError(s.query("select public.billing_entity_rules_save('{}'::jsonb)"))).code).toBe("42501");
      }
    });
  });

  it("leaves snapshots without businesses when none are set up", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      await s.asAdmin();
      await s.query("delete from public.billing_entity_rules where company_id = $1", [TOP_LINE]);
      await s.query("delete from public.billing_entities where company_id = $1", [TOP_LINE]);
      const { snapshot } = await handedOff(s, office);
      expect(snapshot.lines.every((l) => l.billing_entity_id === undefined)).toBe(true);
    });
  });
});

describe("QuickBooks sends", () => {
  it("claims each order and business once, refuses a second send, and lets a failed one be retried", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const { handoffOrder } = await handedOff(s, office);

      // Not connected: a real send is refused; a simulated send is refused outside a demo company.
      expect((await pgError(begin(s, handoffOrder, null, false))).message).toMatch(/Connect QuickBooks/);
      expect((await pgError(begin(s, handoffOrder, null, true))).code).toBe("42501");

      const conn = (await s.query<{ id: string }>("select public.accounting_save_connection(null, 'sandbox', '9130-test', 'Sandbox Co') as id")).rows[0].id;
      expect((await pgError(begin(s, handoffOrder, null, false))).message).toMatch(/product or service/);
      await s.query("select public.accounting_set_item($1, '1', 'Services')", [conn]);

      const first = await begin(s, handoffOrder, null, false);
      expect(first).toMatchObject({ go: true, connection: conn });
      // While it is being sent, a second press does not send again.
      expect(await begin(s, handoffOrder, null, false)).toMatchObject({ go: false, status: "sending" });
      await finish(s, first.id as string, false, "", "QuickBooks: the customer is inactive");
      expect((await s.query("select status, last_error from public.accounting_invoice_sends where id = $1", [first.id])).rows[0]).toEqual({ status: "failed", last_error: "QuickBooks: the customer is inactive" });
      // A failed send may be retried, on the same record.
      const retry = await begin(s, handoffOrder, null, false);
      expect(retry).toMatchObject({ go: true, id: first.id });
      await finish(s, retry.id as string, true, "TL-1001");
      expect(await begin(s, handoffOrder, null, false)).toMatchObject({ go: false, status: "sent", number: "TL-1001" });
      expect((await pgError(finish(s, first.id as string, true, "again"))).code).toBe("P0002");
      expect((await s.query("select attempts from public.accounting_invoice_sends where id = $1", [first.id])).rows[0].attempts).toBe(2);

      // Dispatchers cannot send or connect; nobody but the server reads the token store.
      await s.as(await s.createUser("dispatcher"));
      expect((await pgError(begin(s, handoffOrder, null, false))).code).toBe("42501");
      expect((await pgError(s.query("select public.accounting_save_connection(null, 'sandbox', 'x', 'x')"))).code).toBe("42501");
      await s.as(office);
      expect((await pgError(s.query("select * from public.accounting_connection_secrets"))).code).toBe("42501");
      expect((await pgError(s.query("insert into public.accounting_connection_secrets (connection_id, company_id, tokens_ciphertext, access_expires_at) values ($1, $2, 'x', now())", [conn, TOP_LINE]))).code).toBe("42501");
      expect((await pgError(s.query("update public.accounting_invoice_sends set status = 'sent' where id = $1", [first.id]))).code).toBe("42501");
    });
  });

  it("simulates sends in a demo company only, and keeps sends and connections to their company", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const { handoffOrder } = await handedOff(s, office);
      await s.query("select public.accounting_save_connection(null, 'sandbox', 'iso-test', 'Iso Co')");
      // Another company sees none of it and cannot claim this company's order.
      await s.asAdmin();
      const company = await s.createCompany(`Other ${randomUUID().slice(0, 6)}`);
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [company]);
      await s.as(await s.createUser("office", { companyId: company }));
      expect((await s.query("select * from public.accounting_connections")).rowCount).toBe(0);
      expect((await s.query("select * from public.billing_entities")).rowCount).toBe(0);
      // Even simulated (the other company is a demo), another company's order is not in its handoffs.
      expect((await pgError(begin(s, handoffOrder, null, true))).code).toBe("P0002");
      // As a demo company, the same order is recorded as a simulated send without a connection.
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [TOP_LINE]);
      await s.query("delete from public.accounting_connections where company_id = $1", [TOP_LINE]);
      await s.as(office);
      const r = await begin(s, handoffOrder, null, true);
      expect(r).toMatchObject({ go: true });
      await finish(s, r.id as string, true, "DEMO");
      expect((await s.query("select simulated, status from public.accounting_invoice_sends where id = $1", [r.id])).rows[0]).toEqual({ simulated: true, status: "sent" });
    });
  });
});
