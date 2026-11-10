// Billing businesses (20261120003400) and QuickBooks sends (20261120003500): a handoff snapshot split between businesses
// by charge type, who may change businesses and rules, one claimed send per order and business (never two invoices),
// simulated sends only in demo companies, token secrets unreadable by app users, and company isolation.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { handedOff } from "./fixtures";
import { pgError, pool, TOP_LINE, withDeliveryProof, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;

const saveEntity = async (s: Session, p: Row, id: string | null = null) =>
  (await s.query<{ id: string }>("select public.billing_entity_save($1, $2::jsonb) as id", [id, JSON.stringify(p)])).rows[0].id;
const begin = async (s: Session, handoffOrder: string, entity: string | null, simulated: boolean) =>
  (await s.query<{ r: Row }>("select public.accounting_begin_send($1, $2, $3) as r", [handoffOrder, entity, simulated])).rows[0].r;
// A successful real send carries the server's proof that QuickBooks answered (security audit L2).
const finish = async (s: Session, send: string, ok: boolean, number = "", error = "") => {
  if (ok) {
    const row = (await s.query<{ company_id: string; simulated: boolean }>("select company_id, simulated from public.accounting_invoice_sends where id = $1", [send])).rows[0];
    if (row && !row.simulated) await withDeliveryProof(s, row.company_id, "accounting.sent", send);
  }
  return s.query("select public.accounting_finish_send($1, $2, $3, $4, 1000, 1000, $5)", [send, ok, ok ? "QBO-1" : null, number, error]);
};

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

  it("a Taviron support visit sees the sends but sends nothing to QuickBooks; a demo's simulated send still works (20261120018100)", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const { handoffOrder } = await handedOff(s, office);
      const conn = (await s.query<{ id: string }>("select public.accounting_save_connection(null, 'sandbox', 'visit-test', 'Visit Co') as id")).rows[0].id;
      await s.query("select public.accounting_set_item($1, '1', 'Services')", [conn]);
      const earlier = await begin(s, handoffOrder, null, false);
      await finish(s, earlier.id as string, false, "", "QuickBooks: the customer is inactive");
      const customer = (await s.query<{ id: string }>("select id from public.customers limit 1")).rows[0].id;

      // Support staff, let in by an owner, visit the company.
      const staffId = await s.createUser(null, { membership: false });
      await s.asAdmin();
      const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [staffId])).rows[0].email;
      await s.query("set local role service_role");
      await s.query("select public.platform_admin_grant($1, 'test')", [email]);
      await s.asAdmin();
      await s.query("update private.platform_admins set level = 'support' where user_id = $1", [staffId]);
      await s.as(await s.createUser("owner"));
      await s.query("select public.support_access_grant(3)");
      await s.as(staffId);
      await s.query("select public.platform_support_enter($1, '')", [TOP_LINE]);

      const message = "Taviron support cannot send anything to QuickBooks. Ask someone in the company to send it.";
      for (const e of [
        await pgError(begin(s, handoffOrder, null, false)),
        await pgError(s.query("select public.accounting_link_customer($1, $2, '77', 'Matched', false)", [conn, customer])),
      ]) expect(e).toEqual({ code: "42501", message });
      // Viewing what would be sent and what was sent still works.
      expect((await s.query("select status, last_error from public.accounting_invoice_sends where id = $1", [earlier.id])).rows[0])
        .toEqual({ status: "failed", last_error: "QuickBooks: the customer is inactive" });
      expect((await s.query("select 1 from public.billing_handoff_orders where id = $1", [handoffOrder])).rowCount).toBe(1);

      // A demo company's sends are simulated: nothing leaves Taviron, so a visit there can still show them.
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [TOP_LINE]);
      await s.as(staffId);
      expect(await begin(s, handoffOrder, null, true)).toMatchObject({ go: true });
    });
  });
});
