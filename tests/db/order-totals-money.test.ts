// Order and quote totals for money access only (owner decision 2026-11-17, master plan §12 SEC7, 20261120024700):
// dispatchers without billing or pricing access keep the per-unit rates they type and read, but not an order's or a
// quote's subtotal, tax and total, a line's amount, the totals in the history, or the ordered value on the customer
// and bases summaries; in SQL and through the REST API. Owner, office and the outside accountant read them through
// order_totals / order_line_amounts / quote_totals / quote_line_amounts and the read views.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday, scheduledOrder } from "./fixtures";
import { TOP_LINE, pgError, pool, sampleIds, saveQuote, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const totals = (s: Session, id: string) => s.query<{ total_cents: string; subtotal_cents: string }>("select * from public.order_totals(array[$1::uuid])", [id]);

describe("order and quote totals (SEC7)", () => {
  it("a dispatcher reads rates but no totals; the office and owner read the totals through the functions", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const today = await businessToday(s);
      // A dispatcher enters a phoned-in order (orders.create): the answer carries no total.
      const ids = await sampleIds(s);
      await s.as(dispatcher);
      const saved = (await s.query<{ r: { order_id: string; total_cents: number | null } }>("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
        customer_id: ids.customerId, site_line1: "7 Rate Rd (test)", order_date: today,
        lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "20", unit_rate_cents: 1000, taxable: true }],
      })])).rows[0].r;
      expect(saved.total_cents).toBeNull();
      const mine = saved.order_id;
      // The rate is theirs to read; the amount and the totals are not.
      expect((await s.query("select unit_rate_cents::int as r, quantity::text as q from public.order_lines where order_id = $1", [mine])).rows).toEqual([{ r: 1000, q: "20.000" }]);
      for (const sql of [
        "select total_cents from public.orders where id = $1",
        "select subtotal_cents from public.orders where id = $1",
        "select tax_cents from public.orders where id = $1",
        "select * from public.orders where id = $1",
        "select id from public.orders where id = $1 and total_cents > 0",
        "select amount_cents from public.order_lines where order_id = $1",
        "select * from public.order_lines where order_id = $1",
      ]) expect((await pgError(s.query(sql, [mine]))).code, sql).toBe("42501");
      expect((await pgError(totals(s, mine))).code).toBe("42501");
      expect((await pgError(s.query("select * from public.order_line_amounts(array[$1::uuid])", [mine]))).code).toBe("42501");
      // The read views keep every column, with the totals empty.
      expect((await s.query("select total_cents from public.order_list where id = $1", [mine])).rows).toEqual([{ total_cents: null }]);
      expect((await s.query<{ n: string }>("select count(*) n from public.order_list where total_cents is not null")).rows[0].n).toBe("0");
      expect((await s.query<{ n: string }>("select count(*) n from public.quote_list where total_cents is not null")).rows[0].n).toBe("0");
      // History: the entries that carry a total are not in the table for them; sales_history gives them without it.
      expect((await s.query("select 1 from public.audit_events where entity_id = $1 and action = 'order.created'", [mine])).rowCount).toBe(0);
      const hist = (await s.query<{ action: string; summary: string; details: Record<string, unknown> }>("select action, summary, details from public.sales_history('order', $1)", [mine])).rows;
      const created = hist.find((h) => h.action === "order.created")!;
      expect(created.summary).toMatch(/created \(direct order, draft\)$/);
      expect(created.summary).not.toMatch(/total/);
      expect(created.details).not.toHaveProperty("total_cents");
      // Customer and bases summaries: counts yes, money no.
      const history = (await s.query<{ h: Record<string, unknown> }>("select public.customer_history($1) as h", [ids.customerId])).rows[0].h;
      expect(history.ordered_cents_365d).toBeNull();
      expect((history.recent_orders as Array<{ total_cents: unknown }>).every((o) => o.total_cents === null)).toBe(true);
      expect(Number(history.orders)).toBeGreaterThan(0);
      const bases = (await s.query<{ b: Array<{ ordered_cents: unknown; orders: number }> }>("select public.dispatch_base_summary($1, $2) as b", [addDays(today, -1), today])).rows[0].b;
      for (const b of bases) expect(b.ordered_cents).toBeNull();
      // The Command Center's "needs a delivery date" item carries no total for them either.
      await s.query("select public.set_order_status($1, 'confirmed', '')", [mine]);
      const cc = async () => ((await s.query<{ r: { items: Array<{ order_id: string; details: Record<string, unknown> }> } }>(
        "select public.command_center_exceptions('order_unscheduled', false, 200, 0, false) as r")).rows[0].r.items ?? []).find((i) => i.order_id === mine);
      const item = await cc();
      expect(item).toBeTruthy();
      expect(item!.details.total_cents ?? null).toBeNull();

      // The office and the owner: totals through the functions and the views (never straight from the table).
      for (const [who, label] of [[office, "office"], [owner, "owner"]] as const) {
        await s.as(who);
        expect((await pgError(s.query("select total_cents from public.orders where id = $1", [mine]))).code, label).toBe("42501");
        const t = (await totals(s, mine)).rows[0];
        expect(t.subtotal_cents, label).toBe("20000");
        expect(Number(t.total_cents), label).toBeGreaterThanOrEqual(20000);
        expect((await s.query("select amount_cents::int as a from public.order_line_amounts(array[$1::uuid])", [mine])).rows, label).toEqual([{ a: 20000 }]);
        expect((await s.query("select total_cents::text as t from public.order_list where id = $1", [mine])).rows, label).toEqual([{ t: t.total_cents }]);
        const full = (await s.query<{ summary: string }>("select summary from public.sales_history('order', $1) where action = 'order.created'", [mine])).rows[0];
        expect(full.summary, label).toMatch(/total [0-9,]+\.\d\d$/);
        expect((await s.query("select 1 from public.audit_events where entity_id = $1 and action = 'order.created'", [mine])).rowCount, label).toBe(1);
        const h = (await s.query<{ h: { ordered_cents_365d: unknown } }>("select public.customer_history($1) as h", [ids.customerId])).rows[0].h;
        expect(h.ordered_cents_365d, label).not.toBeNull();
        if (who === owner) expect(Number((await cc())?.details.total_cents), label).toBeGreaterThan(0);
      }
      // An order of the office's: saving answers with the total for them.
      const officeOrder = await scheduledOrder(s, office, today);
      await s.as(office);
      expect(Number((await totals(s, officeOrder.id)).rows[0].subtotal_cents)).toBe(60000);

      // Quotes: same rule (the default dispatcher has quotes.view).
      await s.as(office);
      const q = await saveQuote(s, { customer_id: ids.customerId, quote_date: today, valid_until: addDays(today, 30), lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "10", unit_rate_cents: 1000 }] });
      expect(Number((await s.query<{ total_cents: string }>("select total_cents from public.quote_totals(array[$1::uuid])", [q.version_id])).rows[0].total_cents)).toBeGreaterThan(0);
      await s.as(dispatcher);
      expect((await s.query("select unit_rate_cents::int as r from public.quote_lines where quote_version_id = $1", [q.version_id])).rows).toEqual([{ r: 1000 }]);
      expect((await pgError(s.query("select total_cents from public.quote_versions where id = $1", [q.version_id]))).code).toBe("42501");
      expect((await pgError(s.query("select amount_cents from public.quote_lines where quote_version_id = $1", [q.version_id]))).code).toBe("42501");
      expect((await pgError(s.query("select * from public.quote_totals(array[$1::uuid])", [q.version_id]))).code).toBe("42501");
      expect((await s.query("select total_cents from public.quote_list where id = $1", [q.quote_id])).rows).toEqual([{ total_cents: null }]);
      const qh = (await s.query<{ summary: string }>("select summary from public.sales_history('quote', $1) where action = 'quote.created'", [q.quote_id])).rows[0];
      expect(qh.summary).not.toMatch(/total/);

      // A billing person of another company never reads them.
      const other = await s.createCompany(`Totals Other ${randomUUID().slice(0, 6)} (test)`);
      await s.as(await s.createUser("office", { companyId: other }));
      expect((await totals(s, mine)).rowCount).toBe(0);
      expect((await s.query("select * from public.sales_history('order', $1)", [mine])).rowCount).toBe(0);

      // The permission decides, not the role name: the office without billing.view and pricing.edit sees no totals.
      await s.asAdmin();
      await s.query("delete from public.role_permissions where company_id = $1 and role = 'office' and permission in ('billing.view', 'billing.manage', 'pricing.edit', 'pricing.override')", [TOP_LINE]);
      await s.as(office);
      expect((await pgError(totals(s, mine))).code).toBe("42501");
      expect((await s.query("select total_cents from public.order_list where id = $1", [mine])).rows).toEqual([{ total_cents: null }]);
    });
  });

  it("opportunity values for money access only; sending a priced quote needs it too (owner 2026-11-18)", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(office);
      const opp = (await s.query<{ id: string }>("insert into public.crm_opportunities (customer_id, title, stage, value_cents) values ($1, 'Next phase (test)', 'quoting', 1250000) returning id", [ids.customerId])).rows[0].id;
      expect((await s.query("select value_cents::int as v from public.crm_opportunity_values(array[$1::uuid])", [opp])).rows).toEqual([{ v: 1250000 }]);
      expect((await pgError(s.query("select value_cents from public.crm_opportunities where id = $1", [opp]))).code).toBe("42501");
      // A dispatcher reads the opportunity, its stage and follow-up, never its value.
      await s.as(dispatcher);
      expect((await s.query("select title, stage from public.crm_opportunities where id = $1", [opp])).rows).toEqual([{ title: "Next phase (test)", stage: "quoting" }]);
      expect((await pgError(s.query("select value_cents from public.crm_opportunities where id = $1", [opp]))).code).toBe("42501");
      expect((await pgError(s.query("select * from public.crm_opportunities where id = $1", [opp]))).code).toBe("42501");
      expect((await pgError(s.query("select * from public.crm_opportunity_values(array[$1::uuid])", [opp]))).code).toBe("42501");
      // Someone who may edit customers but has no money access cannot set or change a value; other fields save.
      await s.asAdmin();
      await s.query("delete from public.role_permissions where company_id = $1 and role = 'office' and permission in ('billing.view', 'billing.manage', 'pricing.edit', 'pricing.override')", [TOP_LINE]);
      await s.as(office);
      expect((await pgError(s.query("update public.crm_opportunities set value_cents = 1 where id = $1", [opp]))).code).toBe("42501");
      await s.query("update public.crm_opportunities set next_action = 'Call back (test)' where id = $1", [opp]);
      expect((await pgError(s.query("insert into public.crm_opportunities (customer_id, title, value_cents) values ($1, 'X (test)', 5)", [ids.customerId]))).code).toBe("42501");
      // Sending a quote with its prices: the office without money access is refused (quotes.send alone is not enough).
      const today = await businessToday(s);
      await s.asAdmin();
      const q = await (async () => { await s.as(await s.createUser("owner")); return saveQuote(s, { customer_id: ids.customerId, quote_date: today, valid_until: addDays(today, 30), lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "5", unit_rate_cents: 1000 }] }); })();
      await s.as(office);
      const refused = await pgError(s.query("select public.issue_quote_version($1, $2)", [q.quote_id, q.edit_seq]));
      expect(refused).toEqual({ code: "42501", message: "Quotes with prices are sent by the office." });
      expect((await pgError(s.query("select public.record_quote_delivery($1, $2, 'failed', '{}', '{}', 's', 'b', 'preview', null, 'x', null)", [q.quote_id, q.version_id]))).code).toBe("42501");
    });
  });

  it("every order and quote column but the totals is readable (a column added later needs its own grant)", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const closed = async (t: string) => (await s.query<{ attname: string }>(
        "select a.attname from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and not has_column_privilege('authenticated', $1, a.attname, 'select') order by a.attname", [`public.${t}`])).rows.map((r) => r.attname);
      expect(await closed("orders")).toEqual(["discount_cents", "subtotal_cents", "tax_cents", "taxable_cents", "total_cents"]);
      expect(await closed("order_lines")).toEqual(["amount_cents"]);
      expect(await closed("quote_versions")).toEqual(["discount_cents", "subtotal_cents", "tax_cents", "taxable_cents", "total_cents"]);
      expect(await closed("quote_lines")).toEqual(["amount_cents"]);
      expect(await closed("crm_opportunities")).toEqual(["value_cents"]);
    });
  });
});

// The same through the REST API the app uses, with real signed tokens (local stack only).
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
if (existsSync(".dev-stack/keys.env")) {
  for (const line of readFileSync(".dev-stack/keys.env", "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const restUp = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_) && Boolean(env.DEV_JWT_SECRET && env.DEV_ANON_KEY) &&
  (await fetch(`${URL_}/rest/v1/`, { headers: { apikey: env.DEV_ANON_KEY ?? "" } }).then((r) => r.status < 500).catch(() => false));
if (!restUp) console.warn("Local Supabase API is not running: the REST checks for order totals are skipped (scripts/dev-stack/stack.sh up).");

function token(sub: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", aud: "authenticated", aal: "aal2", iat: now, exp: now + 600 })}`;
  return `${head}.${createHmac("sha256", env.DEV_JWT_SECRET).update(head).digest("base64url")}`;
}
const rest = (sub: string) => createClient(URL_, env.DEV_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token(sub)}` } } });

describe.skipIf(!restUp)("order and quote totals through the REST API (SEC7)", () => {
  it("a dispatcher gets rates and an empty total; the office gets the totals from the functions", async () => {
    // Committed test people in Top Line (the API cannot see an open test transaction); removed afterwards.
    const people: Record<string, string> = {};
    const client = await pool.connect();
    try {
      for (const role of ["dispatcher", "office", "owner"]) {
        const id = randomUUID();
        await client.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, `order-totals-${role}-${id.slice(0, 8)}@test.example`]);
        await client.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, $3, true)", [TOP_LINE, id, role]);
        people[role] = id;
      }
      // The test's own committed order (a freshly built database has no Top Line orders yet), entered by an owner (who
      // may type a price that differs from the price list).
      const cust = (await client.query<{ id: string }>("select id from public.customers where company_id = $1 and active order by created_at limit 1", [TOP_LINE])).rows[0].id;
      const mat = (await client.query<{ id: string }>("select id from public.materials where company_id = $1 and active order by created_at limit 1", [TOP_LINE])).rows[0].id;
      const created = await rest(people.owner).rpc("save_order_draft", { p_payload: {
        customer_id: cust, site_line1: "9 Rest Rd (test)", order_date: new Date().toISOString().slice(0, 10),
        lines: [{ kind: "material", calc_method: "per_unit", material_id: mat, description: "Gravel (test)", unit_code: "ton", quantity: "10", unit_rate_cents: 1200, taxable: true }],
      } });
      expect(created.error).toBeNull();
      const d = rest(people.dispatcher);
      for (const [table, cols] of [["orders", "id, total_cents"], ["orders", "*"], ["order_lines", "id, amount_cents"], ["quote_versions", "id, total_cents"], ["quote_lines", "*"]] as const) {
        expect((await d.from(table).select(cols).limit(1)).error?.code, `${table} ${cols}`).toBe("42501");
      }
      const rates = await d.from("order_lines").select("id, order_id, unit_rate_cents, quantity").limit(5);
      expect(rates.error).toBeNull();
      expect((rates.data ?? []).length).toBeGreaterThan(0);
      const list = await d.from("order_list").select("id, total_cents").limit(20);
      expect(list.error).toBeNull();
      expect((list.data ?? []).every((r) => r.total_cents === null)).toBe(true);
      const ids = (list.data ?? []).map((r) => r.id);
      expect((await d.rpc("order_totals", { p_orders: ids })).error?.code).toBe("42501");

      const o = rest(people.office);
      expect((await o.from("orders").select("total_cents").limit(1)).error?.code).toBe("42501");
      const fn = await o.rpc("order_totals", { p_orders: ids });
      expect(fn.error).toBeNull();
      expect((fn.data ?? []).length).toBe(ids.length);
      const officeList = await o.from("order_list").select("id, total_cents").in("id", ids);
      expect((officeList.data ?? []).every((r) => r.total_cents !== null)).toBe(true);
    } finally {
      // The test people stay as inactive members: the order the owner created still names them in its history.
      for (const id of Object.values(people)) await client.query("update public.company_memberships set active = false where user_id = $1", [id]);
      client.release();
    }
  });
});
