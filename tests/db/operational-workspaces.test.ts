import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

// Operational workspaces: driver membership follows committed dispatch changes.

async function setup(s: Session) {
  const today = await businessToday(s);
  const day = addDays(today, 1);
  const owner = await s.createUser("owner");
  const dispatcher = await s.createUser("dispatcher");
  const f = await fleet(s, owner, day);
  const users: Record<string, string> = {};
  await s.asAdmin();
  for (const [k, d] of Object.entries({ c: f.d1, d: f.d2, e: f.d3 })) {
    users[k] = await s.createUser("driver");
    await s.asAdmin();
    await s.query("update public.drivers set user_id = $1, name = $2 where id = $3", [users[k], `Driver ${k.toUpperCase()}`, d]);
    await s.query("update public.profiles set full_name = $2 where id = $1", [users[k], `Driver ${k.toUpperCase()}`]);
  }
  const order = await scheduledOrder(s, owner, today, addDays(today, 5));
  const l1 = await planLoad(s, order.id, day, "08:00", "09:00");
  const l2 = await planLoad(s, order.id, day, "10:00", "11:00");
  await s.as(dispatcher);
  return { today, day, owner, dispatcher, f, users, order, l1, l2 };
}

const members = async (s: Session, c: string) => {
  await s.asAdmin();
  return (await s.query<{ user_id: string }>("select user_id from public.conversation_members where conversation_id = $1 and left_at is null and source = 'dispatch' order by user_id", [c])).rows.map((r) => r.user_id).sort();
};
const send = (s: Session, c: string, body: string) => s.query<{ r: { id: string } }>("select public.comm_send($1, $2) as r", [c, body]).then((r) => r.rows[0].r);
const visible = (s: Session, c: string) =>
  s.query<{ body: string }>("select body from public.messages where conversation_id = $1 and kind = 'text' order by created_at", [c]).then((r) => r.rows.map((x) => x.body));

describe("dispatch-linked membership", () => {
  it("a project workspace follows assignments: replacement hands off pinned context only; the old driver keeps history but gets nothing new", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      const a1 = await assign(s, w.l1.load_id, w.f.t1, null, w.f.d1); // Driver C
      await assign(s, w.l2.load_id, w.f.t2, null, w.f.d3); // Driver E
      const preview = (await s.query<{ r: { drivers: Array<{ name: string }> } }>("select public.comm_operation_preview($1::jsonb) as r", [JSON.stringify({ scope_type: "project", order_ids: [w.order.id] })])).rows[0].r;
      expect(preview.drivers.map((d) => d.name).sort()).toEqual(["Driver C", "Driver E"]);
      const ws = (await s.query<{ id: string }>("select public.comm_create_operation('Main St job', $1::jsonb, '{}') as id", [JSON.stringify({ scope_type: "project", order_ids: [w.order.id] })])).rows[0].id;
      expect(await members(s, ws)).toEqual([w.users.c, w.users.e].sort());

      await s.as(w.dispatcher);
      const pin = await send(s, ws, "Use the north gate; site contact is on the order");
      await s.query("select public.comm_pin_message($1, true)", [pin.id]);
      await send(s, ws, "Chatter before the change");

      // Replace C by D on load 1 (one committed dispatch change).
      await assign(s, w.l1.load_id, w.f.t1, null, w.f.d2, a1);
      expect(await members(s, ws)).toEqual([w.users.d, w.users.e].sort());
      await s.as(w.dispatcher);
      await send(s, ws, "After the handoff");

      await s.as(w.users.d);
      expect(await visible(s, ws)).toEqual(["Use the north gate; site contact is on the order", "After the handoff"]);
      await s.as(w.users.c);
      expect(await visible(s, ws)).toEqual(["Use the north gate; site contact is on the order", "Chatter before the change"]);
      expect((await pgError(send(s, ws, "Am I still in?"))).code).toBe("42501");

      await s.asAdmin();
      const sys = (await s.query<{ body: string }>("select body from public.messages where conversation_id = $1 and kind = 'system' order by created_at", [ws])).rows.map((r) => r.body).join(" | ");
      expect(sys).toMatch(/Driver D joined .* replaces Driver C/);
      const ev = await s.query<{ details: { reason: string; trigger: string } }>("select details from public.conversation_events where conversation_id = $1 and kind in ('member_added', 'member_removed') and user_id in ($2, $3)", [ws, w.users.c, w.users.d]);
      const changes = ev.rows.filter((e) => e.details.trigger !== "created");
      expect(changes.length).toBe(2);
      expect(changes.every((e) => e.details.reason === "dispatch" && e.details.trigger.startsWith("dispatch_assignments"))).toBe(true);
    });
  });

  it("canceling a load and changing the destination remove drivers; processing the same change twice adds nothing", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await assign(s, w.l1.load_id, w.f.t1, null, w.f.d1);
      await assign(s, w.l2.load_id, w.f.t2, null, w.f.d2);
      const ws = (await s.query<{ id: string }>("select public.comm_create_operation('Deliveries to 100 Test Site', $1::jsonb, '{}') as id",
        [JSON.stringify({ scope_type: "destination", site: "100 Test Site Rd (test)", date: w.day })])).rows[0].id;
      expect(await members(s, ws)).toEqual([w.users.c, w.users.d].sort());
      await s.as(w.dispatcher);
      await s.query("select public.cancel_order_load($1, 'Customer canceled')", [w.l2.load_id]);
      expect(await members(s, ws)).toEqual([w.users.c]);
      await s.as(w.dispatcher);
      await s.query("select public.comm_operation_resync($1)", [ws]);
      await s.query("select public.comm_operation_resync($1)", [ws]);
      await s.asAdmin();
      expect((await s.query("select count(*)::int as n from public.conversation_members where conversation_id = $1 and user_id = $2", [ws, w.users.c])).rows[0].n).toBe(1);
      // The order's delivery site moves: the remaining driver leaves the destination workspace.
      await s.query("update public.orders set site_line1 = '200 Other Rd (test)' where id = $1", [w.order.id]);
      expect(await members(s, ws)).toEqual([]);
    });
  });

  it("a failed synchronization never blocks dispatch, pauses posting, and is recovered by a resync", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      const a1 = await assign(s, w.l1.load_id, w.f.t1, null, w.f.d1);
      const ws = (await s.query<{ id: string }>("select public.comm_create_operation('Job', $1::jsonb, '{}') as id", [JSON.stringify({ scope_type: "loads", load_ids: [w.l1.load_id] })])).rows[0].id;
      await s.asAdmin();
      await s.query("select set_config('tlt.comm_sync_fail', 'on', true)");
      await s.as(w.dispatcher);
      await s.query("select public.cancel_assignment($1, 'Truck broke down')", [a1]); // dispatch still commits
      await s.asAdmin();
      expect((await s.query("select status from public.dispatch_assignments where id = $1", [a1])).rows[0].status).toBe("canceled");
      expect((await s.query("select sync_status, sync_error from public.operation_workspaces where conversation_id = $1", [ws])).rows[0]).toMatchObject({ sync_status: "failed", sync_error: "Simulated synchronization failure" });
      await s.as(w.dispatcher);
      expect((await pgError(send(s, ws, "Anyone?"))).message).toMatch(/Posting is paused/);
      await s.asAdmin();
      await s.query("select set_config('tlt.comm_sync_fail', 'off', true)");
      await s.as(w.dispatcher);
      await s.query("select public.comm_operation_resync($1)", [ws]);
      expect(await members(s, ws)).toEqual([]); // the canceled driver is out
      await s.as(w.dispatcher);
      await send(s, ws, "Back to normal");
      await s.asAdmin();
      expect((await s.query<{ kind: string }>("select kind from public.conversation_events where conversation_id = $1 and kind like 'sync%' order by created_at", [ws])).rows.map((r) => r.kind)).toEqual(["sync_failed", "sync_recovered"]);
    });
  });

  it("closing ends drivers' access; reopening recalculates from current assignments; finished work archives after the delay", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      const a1 = await assign(s, w.l1.load_id, w.f.t1, null, w.f.d1);
      const ws = (await s.query<{ id: string }>("select public.comm_create_operation('Job', $1::jsonb, '{}') as id", [JSON.stringify({ scope_type: "loads", load_ids: [w.l1.load_id] })])).rows[0].id;
      await s.query("select public.comm_operation_close($1, 'Done for today')", [ws]);
      expect(await members(s, ws)).toEqual([]);
      await s.as(w.dispatcher);
      expect((await pgError(send(s, ws, "Closed?"))).message).toMatch(/closed/);
      await s.query("select public.cancel_assignment($1, 'Swap')", [a1]);
      await assign(s, w.l1.load_id, w.f.t1, null, w.f.d2); // D now holds the load
      await s.query("select public.comm_operation_reopen($1)", [ws]);
      expect(await members(s, ws)).toEqual([w.users.d]); // C does not come back

      // All loads finished (canceled) → archived after the company's delay (0 hours here).
      await s.as(w.owner);
      await s.query("select public.comm_save_settings('{\"workspace_archive_hours\": 0}'::jsonb)");
      await s.as(w.dispatcher);
      await s.query("select public.cancel_order_load($1, 'Weather')", [w.l1.load_id]);
      await s.asAdmin();
      await s.query("delete from public.comm_housekeeping_runs");
      await s.as(w.dispatcher);
      expect((await s.query<{ r: { archived: number } }>("select public.comm_housekeeping() as r")).rows[0].r.archived).toBeGreaterThanOrEqual(1);
      await s.asAdmin();
      expect((await s.query("select status from public.conversations where id = $1", [ws])).rows[0].status).toBe("archived");
    });
  });

  it("only comms.operations creates workspaces, and only from the caller's company", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      const driverUser = w.users.c;
      await s.as(driverUser);
      expect((await pgError(s.query("select public.comm_create_operation('X', $1::jsonb, '{}')", [JSON.stringify({ scope_type: "project", order_ids: [w.order.id] })]))).code).toBe("42501");
      const other = await s.createCompany(`Other ${Math.random().toString(36).slice(2, 6)}`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await pgError(s.query("select public.comm_operation_preview($1::jsonb)", [JSON.stringify({ scope_type: "project", order_ids: [w.order.id] })]))).code).toBe("P0002");
    });
  });
});
