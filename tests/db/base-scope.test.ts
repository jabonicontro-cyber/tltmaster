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
      // The dispatch board's shop schedule (elevated rights) follows the same rule.
      await s.asAdmin();
      await s.query("update public.work_orders set scheduled_for = $2 where id = any($1::uuid[])", [[w.woMain, w.woNorth], w.day]);
      const shop = async () => (await s.query<{ r: Array<{ work_order_id: string }> }>("select public.dispatch_shop_schedule($1, $1) r", [w.day])).rows[0].r
        .map((x) => x.work_order_id).filter((id) => id === w.woMain || id === w.woNorth).sort();
      await s.as(w.dispatcher);
      expect(await shop()).toEqual([w.woNorth]);
      await s.as(w.owner);
      expect(await shop()).toEqual([w.woMain, w.woNorth].sort());
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

  it("a base-limited person cannot change another base's orders, trucks or drivers, cannot read their history, and creates records at their own base", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      // History and documents attached to Main's records (written by the owner).
      await s.as(w.owner);
      await s.query("insert into public.vehicle_documents (truck_id, kind, reference_number, expires_on) values ($1, 'registration', 'MAIN-REG', '2030-01-01'), ($2, 'registration', 'NORTH-REG', '2030-01-01')", [w.f.t1, w.f.t2]);
      await s.query("select public.record_truck_reading($1, 1000, null, 'Main reading')", [w.f.t1]);
      // This company lets dispatchers edit orders and the fleet, so the base rule (not a permission) is what refuses.
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'dispatcher', 'orders.edit'), ($1, 'dispatcher', 'fleet.edit'), ($1, 'dispatcher', 'fleet.service'), ($1, 'dispatcher', 'maintenance.manage') on conflict do nothing", [TOP_LINE]);
      await s.as(w.dispatcher);
      // Changes through the app's functions to another base's order, truck and driver.
      expect(refusal(await pgError(s.query("select public.set_order_status($1, 'in_progress', '')", [w.oMain.id])))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(s.query("select public.flag_order_urgent($1, 'Customer called', null)", [w.oMain.id])))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(s.query("select public.set_equipment_service_status('truck', $1, 'out_of_service', 'Not mine', null)", [w.f.t1])))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(s.query("select public.record_truck_reading($1, 2000, null, 'Not mine')", [w.f.t1])))).toEqual(BASE_REFUSAL);
      // History and documents of another base are not readable.
      expect((await s.query<{ reference_number: string }>("select reference_number from public.vehicle_documents where truck_id = any($1::uuid[]) order by 1", [[w.f.t1, w.f.t2]])).rows.map((r) => r.reference_number)).toEqual(["NORTH-REG"]);
      expect((await s.query("select 1 from public.truck_readings where truck_id = $1", [w.f.t1])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.order_status_events where order_id = $1", [w.oMain.id])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.order_status_events where order_id = $1", [w.oNorth.id])).rowCount).toBeGreaterThan(0);
      expect((await s.query("select 1 from public.driver_qualifications where driver_id = $1", [w.f.d1])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.driver_qualifications where driver_id = $1", [w.f.d2])).rowCount).toBeGreaterThan(0);
      // A truck they add starts at their base (before, it started at the company default and vanished from their list).
      const mine = (await s.query<{ id: string; base_id: string }>("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id, base_id", [`NB-${randomUUID().slice(0, 4)}`])).rows[0];
      expect(mine.base_id).toBe(w.north);
      // Explicitly placing it at another base is refused by the trucks' base policy (a direct write, so RLS applies).
      expect(refusal(await pgError(s.query("insert into public.trucks (unit_number, truck_type, base_id) values ($1, 'tri_axle_dump', $2)", [`NX-${randomUUID().slice(0, 4)}`, w.main]))))
        .toEqual({ code: "42501", message: 'new row violates row-level security policy "trucks_base_access" for table "trucks"' });
      // Their own base still works, and the owner is unaffected.
      await s.query("select public.record_truck_reading($1, 3000, null, 'Mine')", [w.f.t2]);
      await s.as(w.owner);
      await s.query("select public.record_truck_reading($1, 1100, null, 'Owner')", [w.f.t1]);
      expect((await s.query("select 1 from public.vehicle_documents where truck_id = any($1::uuid[])", [[w.f.t1, w.f.t2]])).rowCount).toBe(2);
    });
  }, SETUP_HEAVY);

  it("the write guard checks every row of a statement: bulk updates, deletes, inserts, upserts and merges cannot mix in another base", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      // Act as an elevated-rights function does: the database owner's rights (no RLS) with the person's identity.
      const asFunctionFor = async (user: string) => {
        await s.as(user);
        await s.query("reset role");
      };
      const notes = async () => (await s.query<{ id: string; notes: string | null }>("select id, description as notes from public.work_orders where id = any($1::uuid[])", [[w.woMain, w.woNorth]])).rows;
      await s.asAdmin();
      const before = await notes();
      await s.query("insert into public.vehicle_documents (company_id, truck_id, kind, reference_number) values ($1, $2, 'registration', 'N0'), ($1, $3, 'registration', 'M0')", [TOP_LINE, w.f.t2, w.f.t1]);
      await asFunctionFor(w.dispatcher);
      // One statement touching their base and another: refused as a whole, nothing changes.
      expect(refusal(await pgError(s.query("update public.work_orders set description = 'bulk' where id = any($1::uuid[])", [[w.woNorth, w.woMain]])))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(s.query("update public.work_orders set truck_id = $2 where id = $1", [w.woNorth, w.f.t1])))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(s.query("delete from public.vehicle_documents where truck_id = any($1::uuid[])", [[w.f.t2, w.f.t1]])))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(s.query("insert into public.vehicle_documents (company_id, truck_id, kind, reference_number) values ($1, $2, 'registration', 'N'), ($1, $3, 'registration', 'M')", [TOP_LINE, w.f.t2, w.f.t1])))).toEqual(BASE_REFUSAL);
      // An upsert that lands on another base's row (the update half), and a merge over both bases.
      expect(refusal(await pgError(s.query("insert into public.trucks (id, company_id, unit_number, truck_type) values ($1, $2, 'X', 'tri_axle_dump') on conflict (id) do update set notes = 'upsert'", [w.f.t1, TOP_LINE])))).toEqual(BASE_REFUSAL);
      expect(refusal(await pgError(s.query("merge into public.work_orders t using (select unnest($1::uuid[]) id) x on t.id = x.id when matched then update set description = 'merge'", [[w.woNorth, w.woMain]])))).toEqual(BASE_REFUSAL);
      // Moving their own order to another base is refused too (the new row is checked, not only the old one).
      expect(refusal(await pgError(s.query("update public.orders set base_id = $2 where id = $1", [w.oNorth.id, w.main])))).toEqual(BASE_REFUSAL);
      // Their own base, in bulk, still works.
      await s.query("update public.work_orders set description = 'mine' where id = $1", [w.woNorth]);
      await s.query("insert into public.trucks (id, company_id, unit_number, truck_type) values ($1, $2, 'X', 'tri_axle_dump') on conflict (id) do update set notes = 'upsert'", [w.f.t2, TOP_LINE]);
      // An unrestricted person may change both bases in one statement (cross-base work stays theirs to decide).
      await asFunctionFor(w.owner);
      await s.query("update public.work_orders set description = 'owner bulk' where id = any($1::uuid[])", [[w.woNorth, w.woMain]]);
      await s.asAdmin();
      expect((await s.query("select 1 from public.vehicle_documents where truck_id = any($1::uuid[]) and reference_number in ('N0', 'M0')", [[w.f.t1, w.f.t2]])).rowCount).toBe(2);
      const after = await notes();
      expect(after.map((r) => r.notes)).toEqual(["owner bulk", "owner bulk"]);
      expect(before.every((r) => r.notes !== "owner bulk")).toBe(true);
    });
  }, SETUP_HEAVY);

  it("Command Center counts follow the person's bases", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      // Today's loads at both bases, and a truck out of service at each.
      await s.asAdmin();
      const today = await businessToday(s);
      await s.query("update public.order_loads set load_date = $2 where id = any($1::uuid[])", [[w.lMain.load_id, w.lNorth.load_id], today]);
      await s.query("update public.trucks set service_status = 'out_of_service', out_of_service_reason = 'Test', out_of_service_since = now() where id = any($1::uuid[])", [[w.f.t1, w.f.t2]]);
      // The counts equal what the person's own lists show (the same query, run as the person, so RLS decides).
      const check = async (user: string) => {
        await s.as(user);
        const r = (await s.query<{ r: Record<string, number> }>("select public.command_center_summary() r")).rows[0].r;
        const listed = (await s.query<{ loads: number; assigned: number; orders: number; trucks: number }>(
          `select (select count(*)::int from public.order_loads l join public.orders o on o.id = l.order_id
                   where l.status = 'planned' and l.load_date = $1
                     and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')) loads,
                  (select count(*)::int from public.order_loads l join public.orders o on o.id = l.order_id
                   where l.status = 'planned' and l.load_date = $1
                     and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')
                     and exists (select 1 from public.dispatch_assignments a where a.load_id = l.id and a.status = 'active')) assigned,
                  (select count(*)::int from public.orders o where o.status <> 'canceled'
                     and o.scheduled_start <= $1 and coalesce(o.scheduled_end, o.scheduled_start) >= $1) orders,
                  (select count(*)::int from public.trucks where active and service_status = 'out_of_service') trucks`, [today])).rows[0];
        expect({ loads: r.loads_today, assigned: r.loads_today_assigned, orders: r.orders_today, trucks: r.trucks_out_of_service }).toEqual(listed);
        return listed;
      };
      const owner = await check(w.owner);
      const dispatcher = await check(w.dispatcher);
      // Main's load, assignment, order and truck count for the owner only; North's for both.
      expect(owner.loads - dispatcher.loads).toBeGreaterThanOrEqual(1);
      expect(owner.trucks - dispatcher.trucks).toBeGreaterThanOrEqual(1);
      expect(owner.orders - dispatcher.orders).toBeGreaterThanOrEqual(1);
      expect(dispatcher.loads).toBeGreaterThanOrEqual(1);
      expect(dispatcher.trucks).toBeGreaterThanOrEqual(1);
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
