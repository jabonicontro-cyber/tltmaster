// Per-person dispatch base access on the records attached to orders and equipment (20261120001800): a person limited
// to one base cannot read, or act through the app's functions on, another base's order lines, loads, assignments,
// delivery tickets or work orders; owners and other companies are unaffected or see nothing respectively.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function world(s: Session) {
  const today = await businessToday(s);
  const day = addDays(today, -1);
  // Top Line on a two-base plan (rolled back with the session).
  const v = (await s.query<{ id: string }>("select id from private.platform_plan_versions where plan_key = 'growth' order by version desc limit 1")).rows[0].id;
  await s.query("insert into private.company_lifecycle (company_id, plan_version_id) values ($1, $2) on conflict (company_id) do update set plan_version_id = excluded.plan_version_id", [TOP_LINE, v]);
  const owner = await s.createUser("owner");
  const dispatcher = await s.createUser("dispatcher");
  await s.as(owner);
  const main = (await s.query<{ id: string }>("select id from public.dispatch_bases where is_default")).rows[0].id;
  const north = (await s.query<{ id: string }>("insert into public.dispatch_bases (code, name, timezone) values ($1, 'North (test)', 'America/Chicago') returning id", [`N${randomUUID().slice(0, 5)}`])).rows[0].id;

  const f = await fleet(s, owner, day);
  await s.query("update public.trucks set base_id = $1 where id = $2", [north, f.t2]);
  await s.query("update public.drivers set base_id = $1 where id = $2", [north, f.d2]);
  const oMain = await scheduledOrder(s, owner, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  const oNorth = await scheduledOrder(s, owner, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  await s.query("select public.set_order_base($1, $2)", [oNorth.id, north]);
  // Different hours, so the write checks below are refused for the base, not for a schedule conflict.
  const lMain = await planLoad(s, oMain.id, day, "10:00", "12:00", { planned_quantity: "20", unit_code: "ton" });
  const lNorth = await planLoad(s, oNorth.id, day, "07:00", "09:00", { planned_quantity: "20", unit_code: "ton" });
  const aMain = await assign(s, lMain.load_id, f.t1, null, f.d1);
  const aNorth = await assign(s, lNorth.load_id, f.t2, null, f.d2);
  const ticket = async (load: string, line: string) =>
    (await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
      load_id: load, order_line_id: line, delivered_date: day, delivered_time: "08:30", quantity: "20", unit_code: "ton",
      external_reference: `BS-${randomUUID().slice(0, 8)}`,
    })])).rows[0].r.ticket_id;
  const tMain = await ticket(lMain.load_id, oMain.materialLine);
  const tNorth = await ticket(lNorth.load_id, oNorth.materialLine);
  const wo = async (truck: string) =>
    (await s.query<{ r: { id: string } }>("select public.maintenance_create_work_order($1::jsonb) as r", [JSON.stringify({ truck_id: truck, title: "Base scope check", category: "brakes", urgency: "normal" })])).rows[0].r.id;
  const woMain = await wo(f.t1);
  const woNorth = await wo(f.t2);
  await s.query("select public.set_person_bases($1, $2::uuid[])", [dispatcher, [north]]);
  return { day, owner, dispatcher, main, north, f, oMain, oNorth, lMain, lNorth, aMain, aNorth, tMain, tNorth, woMain, woNorth };
}

const ids = async (s: Session, table: string, col: string, among: string[]) =>
  (await s.query<{ v: string }>(`select ${col}::text as v from public.${table} where ${col} = any($1::uuid[])`, [among])).rows.map((r) => r.v).sort();

// Each test builds a two-base world (orders, loads, assignments, tickets, work orders) through the app's functions.
const SETUP_HEAVY = 60_000;
// The base guard's refusal (not a missing permission, a schedule conflict or a validation error).
const BASE_REFUSAL = { code: "42501", message: "You can only work with records at your dispatch bases." };
const refusal = (e: { code: string; message: string }) => ({ code: e.code, message: e.message });

describe("dispatch base access on attached records", () => {
  it("a base-limited person reads only their base's order lines, loads, assignments, tickets and work orders; the owner reads all", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const orders = [w.oMain.id, w.oNorth.id];
      const check = async (expectMain: boolean) => {
        const want = (mainId: string, northId: string) => (expectMain ? [mainId, northId] : [northId]).sort();
        expect(await ids(s, "order_lines", "order_id", orders)).toEqual(expectMain ? [w.oMain.id, w.oMain.id, w.oNorth.id, w.oNorth.id].sort() : [w.oNorth.id, w.oNorth.id]);
        expect(await ids(s, "order_loads", "id", [w.lMain.load_id, w.lNorth.load_id])).toEqual(want(w.lMain.load_id, w.lNorth.load_id));
        expect(await ids(s, "dispatch_assignments", "id", [w.aMain, w.aNorth])).toEqual(want(w.aMain, w.aNorth));
        expect(await ids(s, "delivery_tickets", "id", [w.tMain, w.tNorth])).toEqual(want(w.tMain, w.tNorth));
        expect(await ids(s, "work_orders", "id", [w.woMain, w.woNorth])).toEqual(want(w.woMain, w.woNorth));
        // The views the pages read follow the same rule (they run as the person).
        expect(await ids(s, "billing_load_status", "load_id", [w.lMain.load_id, w.lNorth.load_id])).toEqual(want(w.lMain.load_id, w.lNorth.load_id));
      };
      await s.as(w.dispatcher);
      await check(false);
      await s.as(w.owner);
      await check(true);
    });
  }, SETUP_HEAVY);

  it("a base-limited person cannot plan, assign, cancel, ticket or open work on another base's records through the app's functions", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.dispatcher);
      // Another base's order, load and assignment.
      expect(refusal(await pgError(planLoad(s, w.oMain.id, w.day, "13:00", "14:00")))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(s.query("select public.cancel_order_load($1, 'test')", [w.lMain.load_id])))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(s.query("select public.cancel_assignment($1, 'test')", [w.aMain])))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(assign(s, w.lMain.load_id, w.f.t2, null, w.f.d2, w.aMain)))).toEqual(BASE_REFUSAL);
      // Their own load with another base's truck or driver, picked by id.
      expect(refusal(await pgError(assign(s, w.lNorth.load_id, w.f.t1, null, w.f.d2, w.aNorth)))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(assign(s, w.lNorth.load_id, w.f.t2, null, w.f.d1, w.aNorth)))).toEqual(BASE_REFUSAL);
      // A ticket against another base's load (duplicate confirmed, so the call reaches the insert).
      expect(refusal(await pgError(s.query("select public.submit_delivery_ticket($1::jsonb)", [JSON.stringify({
        load_id: w.lMain.load_id, order_line_id: w.oMain.materialLine, delivered_date: w.day, delivered_time: "11:00", quantity: "5", unit_code: "ton",
        external_reference: `BS-${randomUUID().slice(0, 8)}`, confirm_duplicate: true,
      })])))).toEqual(BASE_REFUSAL);
      // Work on another base's truck, with the permission to open work orders (so only the base rule can stop it).
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'dispatcher', 'maintenance.manage') on conflict do nothing", [TOP_LINE]);
      await s.as(w.dispatcher);
      expect(refusal(await pgError(s.query("select public.maintenance_create_work_order($1::jsonb)", [JSON.stringify({ truck_id: w.f.t1, title: "Not mine", category: "brakes", urgency: "normal" })])))).toEqual(BASE_REFUSAL);
      // Their own base still works.
      const extra = await planLoad(s, w.oNorth.id, w.day, "13:00", "14:00");
      expect(extra.load_id).toBeTruthy();
      await s.query("select public.cancel_order_load($1, 'test')", [extra.load_id]);
      // Nothing of Main's changed.
      await s.as(w.owner);
      expect((await s.query<{ status: string }>("select status from public.dispatch_assignments where id = $1", [w.aMain])).rows[0].status).toBe("active");
      expect((await s.query<{ status: string }>("select status from public.order_loads where id = $1", [w.lMain.load_id])).rows[0].status).toBe("planned");
    });
  }, SETUP_HEAVY);

  it("another company sees none of these records, restricted or not", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const other = await s.createCompany(`Other Hauling ${randomUUID().slice(0, 6)} (test)`);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect(await ids(s, "order_loads", "id", [w.lMain.load_id, w.lNorth.load_id])).toEqual([]);
      expect(await ids(s, "dispatch_assignments", "id", [w.aMain, w.aNorth])).toEqual([]);
      expect(await ids(s, "delivery_tickets", "id", [w.tMain, w.tNorth])).toEqual([]);
      expect(await ids(s, "work_orders", "id", [w.woMain, w.woNorth])).toEqual([]);
      expect((await pgError(s.query("select public.cancel_assignment($1, 'test')", [w.aNorth]))).message).toMatch(/not found/i);
    });
  }, SETUP_HEAVY);
});
