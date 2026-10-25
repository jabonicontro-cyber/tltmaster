// Ask Taviron reads only what the signed-in person may see (docs/AI.md §12–§14). The assistant's data source
// (src/server/data/assistant.ts) uses the person's own session for every read; this file runs those same reads — the
// tables, views and functions it calls, with the same filters — as a person limited to one dispatch base and as a
// person of another company, so authorization is decided before anything could reach the model. It also covers the
// per-person usage summary and the platform pause switch (20261120002400).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function world(s: Session) {
  const today = await businessToday(s);
  const day = addDays(today, -1);
  const v = (await s.query<{ id: string }>("select id from private.platform_plan_versions where plan_key = 'growth' order by version desc limit 1")).rows[0].id;
  await s.query("insert into private.company_lifecycle (company_id, plan_version_id) values ($1, $2) on conflict (company_id) do update set plan_version_id = excluded.plan_version_id", [TOP_LINE, v]);
  const owner = await s.createUser("owner");
  const dispatcher = await s.createUser("dispatcher");
  await s.as(owner);
  const north = (await s.query<{ id: string }>("insert into public.dispatch_bases (code, name, timezone) values ($1, 'North (test)', 'America/Chicago') returning id", [`N${randomUUID().slice(0, 5)}`])).rows[0].id;
  const f = await fleet(s, owner, day);
  await s.query("update public.trucks set base_id = $1 where id = $2", [north, f.t2]);
  await s.query("update public.drivers set base_id = $1 where id = $2", [north, f.d2]);
  const oMain = await scheduledOrder(s, owner, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  const oNorth = await scheduledOrder(s, owner, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  await s.query("select public.set_order_base($1, $2)", [oNorth.id, north]);
  const lMain = await planLoad(s, oMain.id, day, "10:00", "12:00", { planned_quantity: "20", unit_code: "ton" });
  const lNorth = await planLoad(s, oNorth.id, day, "07:00", "09:00", { planned_quantity: "20", unit_code: "ton" });
  // An unassigned load at each base for the attention queue, today.
  const qMain = await planLoad(s, oMain.id, today, "13:00", "14:00", { planned_quantity: "20", unit_code: "ton" });
  const qNorth = await planLoad(s, oNorth.id, today, "15:00", "16:00", { planned_quantity: "20", unit_code: "ton" });
  await assign(s, lMain.load_id, f.t1, null, f.d1);
  await assign(s, lNorth.load_id, f.t2, null, f.d2);
  const ticket = async (load: string, line: string) => (await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
    load_id: load, order_line_id: line, delivered_date: day, delivered_time: "08:30", quantity: "20", unit_code: "ton", external_reference: `AI-${randomUUID().slice(0, 8)}`,
  })])).rows[0].r.ticket_id;
  await ticket(lMain.load_id, oMain.materialLine);
  await ticket(lNorth.load_id, oNorth.materialLine);
  await s.query("select public.set_person_bases($1, $2::uuid[])", [dispatcher, [north]]);
  const numbers = (await s.query<{ id: string; order_number: string }>("select id, order_number from public.orders where id = any($1::uuid[])", [[oMain.id, oNorth.id]])).rows;
  const num = (id: string) => numbers.find((r) => r.id === id)!.order_number;
  return { today, day, owner, dispatcher, north, f, oMain, oNorth, mainNumber: num(oMain.id), northNumber: num(oNorth.id), qMain, qNorth };
}

// The reads in src/server/data/assistant.ts, as SQL.
const orderById = (s: Session, id: string) => s.query("select id, order_number, status, requested_date, customer_id from public.orders where id = $1", [id]);
const orderByNumber = (s: Session, n: string) => s.query("select id from public.orders where order_number = $1 limit 2", [n]);
const queueLoadIds = async (s: Session) => {
  const r = (await s.query<{ r: { items: Array<{ load_id: string | null }> } }>("select public.command_center_exceptions(null, false, 200, 0, false) r")).rows[0].r;
  return r.items.map((i) => i.load_id).filter(Boolean) as string[];
};
const report = async (s: Session, from: string, to: string) => (await s.query<{ r: { deliveries?: { tickets: number }; fleet?: Array<{ unit_number: string }> } }>("select public.report_operations($1, $2) r", [from, to])).rows[0].r;

const SETUP_HEAVY = 60_000;

describe("Ask Taviron reads within the person's company and dispatch bases", () => {
  it("a person limited to one base sees only that base's orders, loads, queue items, trucks and report totals", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.dispatcher);
      // order_status: another base's order resolves to nothing, by id or by its reference.
      expect((await orderById(s, w.oMain.id)).rows).toEqual([]);
      expect((await orderByNumber(s, w.mainNumber)).rows).toEqual([]);
      expect((await orderById(s, w.oNorth.id)).rows).toHaveLength(1);
      expect((await s.query("select status from public.order_loads where order_id = $1", [w.oMain.id])).rows).toEqual([]);
      expect((await s.query("select order_id from public.order_fulfillment where order_id = $1", [w.oMain.id])).rows).toEqual([]);
      // attention_queue: the other base's unassigned load is not an item.
      const queue = await queueLoadIds(s);
      expect(queue).not.toContain(w.qMain.load_id);
      expect(queue).toContain(w.qNorth.load_id);
      // week_outlook and maintenance read trucks through the session: only this base's.
      const trucks = (await s.query<{ id: string }>("select id from public.trucks where id = any($1::uuid[])", [[w.f.t1, w.f.t2]])).rows.map((r) => r.id);
      expect(trucks).toEqual([w.f.t2]);
      // period_report: totals count this base's tickets and trucks only.
      const mine = await report(s, w.day, w.day);
      await s.as(w.owner);
      const all = await report(s, w.day, w.day);
      expect(all.deliveries!.tickets).toBeGreaterThanOrEqual(2);
      // The new base has exactly its own ticket; the company total also counts any other tickets on that day
      // (earlier test runs may have left some in the shared test company).
      expect(mine.deliveries!.tickets).toBe(1);
      expect(all.deliveries!.tickets).toBeGreaterThan(mine.deliveries!.tickets);
      expect(mine.fleet!.length).toBeLessThan(all.fleet!.length);
      expect((await orderByNumber(s, w.mainNumber)).rows).toHaveLength(1);
    });
  }, SETUP_HEAVY);

  it("a person of another company sees none of these records and an empty report", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const other = await s.createCompany("Other Haulers (test)");
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await orderById(s, w.oNorth.id)).rows).toEqual([]);
      expect((await orderByNumber(s, w.northNumber)).rows).toEqual([]);
      expect((await s.query("select id from public.customers")).rows.length).toBe(0);
      expect((await s.query("select id from public.employees where company_id = $1", [TOP_LINE])).rows).toEqual([]);
      const queue = await queueLoadIds(s);
      expect(queue).not.toContain(w.qMain.load_id);
      expect(queue).not.toContain(w.qNorth.load_id);
      const r = await report(s, w.day, w.day);
      expect(r.deliveries?.tickets ?? 0).toBe(0);
      expect(r.fleet ?? []).toEqual([]);
    });
  }, SETUP_HEAVY);
});

describe("AI per-person limits and the pause switch", () => {
  const record = (key: string, inTok: number, outTok: number, cost: number | null) =>
    ["select public.record_ai_usage($1, 'ops_assistant', 'openai', 'test-model-2030', 'ok', null, $2, $3, $4, 120)", [key, inTok, outTok, cost]] as [string, unknown[]];

  it("reports the company's and the caller's own usage separately, never another company's", () => withSession(async (s) => {
    const other = await s.createCompany("Other Haulers (test)");
    const a = await s.createUser("dispatcher");
    const b = await s.createUser("office");
    const outsider = await s.createUser("owner", { companyId: other });
    await s.as(a);
    await s.query(...record("lim_aaaaaaaa", 900, 100, 2600));
    await s.query(...record("lim_bbbbbbbb", 500, 50, null));
    await s.as(b);
    await s.query(...record("lim_cccccccc", 300, 30, 840));
    await s.as(outsider);
    await s.query(...record("lim_dddddddd", 99_000, 1000, 9_999_999));

    await s.as(a);
    const mine = (await s.query("select * from public.ai_usage_limits()")).rows[0];
    expect(Number(mine.user_tokens_this_month)).toBe(1550);
    expect(mine.user_calls_last_minute).toBe(2);
    expect(mine.user_calls_today).toBe(2);
    expect(Number(mine.tokens_this_month)).toBeGreaterThanOrEqual(1880);
    expect(Number(mine.tokens_this_month)).toBeLessThan(99_000); // the other company's usage is not counted
    expect(Number(mine.cost_this_month_micro_usd)).toBeGreaterThanOrEqual(3440);
    expect(Number(mine.cost_this_month_micro_usd)).toBeLessThan(9_999_999);
    expect(mine.unpriced_calls_this_month).toBeGreaterThanOrEqual(1);
    expect(mine.paused).toBe(false);

    await s.as(b);
    const theirs = (await s.query("select * from public.ai_usage_limits()")).rows[0];
    expect(Number(theirs.user_tokens_this_month)).toBe(330);
    expect(theirs.user_calls_today).toBe(1);
  }));

  it("the pause switch is visible to every session at once and only the database owner can change it", () => withSession(async (s) => {
    const owner = await s.createUser("owner");
    await s.as(owner);
    await expect(s.query("select * from private.ai_controls")).rejects.toThrow(/permission denied/);
    await expect(s.query("update private.ai_controls set paused = true")).rejects.toThrow(/permission denied/);
    await s.asAdmin();
    await s.query("update private.ai_controls set paused = true, reason = 'test'");
    await s.as(owner);
    expect((await s.query("select paused from public.ai_usage_limits()")).rows[0].paused).toBe(true);
    await s.as(null);
    await expect(s.query("select * from public.ai_usage_limits()")).rejects.toThrow(/permission denied/);
  }));
});
