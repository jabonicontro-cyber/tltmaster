// Owner decisions 2026-11-16/17 (WK3), database side:
//  * 20261120024600: a stop added to a load already assigned tells its driver in the app (once per save, the new stops
//    named); editing or removing a stop, unassigned loads and other drivers get nothing. Rollback removes the trigger.
//  * 20261120024610: "At risk" from 3 unplanned repairs by default; only companies that never set their rules move.
//  * 20261120024620: demo sample repairs spread over months so only one or two demo trucks read At risk; demos only.
//  * 20261120024630: a demo job scheduled before its part arrives; demos only, once.
//  * "Move to <arrival date>": the existing reschedule changes only the date (maintenance.manage), recorded in history.
// Fictional data, rolled back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const sql = (dir: string, n: string) => readFileSync(join(__dirname, `../../supabase/${dir}/${n}`), "utf8").replace(/^\s*begin;\s*$/m, "").replace(/^\s*commit;\s*$/m, "");
const tag = () => Math.random().toString(36).slice(2, 7);
const MARK = "Demo: a completed job, so maintenance estimates have history.";

// The notice is raised when the save commits (a deferred trigger); the tests fire pending notices as commit would.
async function stopNotices(s: Session, user: string) {
  await s.asAdmin();
  await s.query("set constraints all immediate");
  const rows = (await s.query<{ title: string; detail: string }>(
    `select a.title, a.detail from public.alerts a join public.alert_recipients r on r.alert_id = a.id
      where r.user_id = $1 and a.event_type = 'dispatch.stop_added' order by a.created_at, a.title`, [user])).rows;
  await s.query("set constraints all deferred");
  return rows;
}
const saveStops = (s: Session, order: string, list: unknown[]) => s.query("select public.save_order_stops($1, $2::jsonb)", [order, JSON.stringify(list)]);

/** An office person, a load tomorrow assigned to driver 1 (with a login), an order nobody is assigned to, driver 2. */
async function stopWorld(s: Session) {
  const today = await businessToday(s);
  const office = await s.createUser("office");
  const f = await fleet(s, office, today);
  const order = await scheduledOrder(s, office, today, addDays(today, 3));
  const load = await planLoad(s, order.id, addDays(today, 1), "07:00", "14:00");
  await assign(s, load.load_id, f.t1, null, f.d1);
  const open = await scheduledOrder(s, office, today, addDays(today, 3));
  await planLoad(s, open.id, addDays(today, 1), "07:00", "14:00");
  await s.asAdmin();
  const u1 = await s.createUser("driver");
  const u2 = await s.createUser("driver");
  await s.query("update public.drivers set user_id = $1 where id = $2", [u1, f.d1]);
  await s.query("update public.drivers set user_id = $1 where id = $2", [u2, f.d2]);
  await s.query("set constraints all deferred");
  await s.as(office);
  return { today, office, order, open, u1, u2 };
}
const twoStops = (today: string) => [
  { kind: "pickup", name: "Midwest Steel", city: "Portage", state: "IN" },
  { kind: "delivery", name: "Lakeside Build", city: "Gary", state: "IN", appointment_date: addDays(today, 1), window_start: "15:00", window_end: "16:00" },
];

describe("a stop added to an assigned load tells the driver", () => {
  it("notifies the assigned driver once per save, naming the new stops; edits, unassigned loads and other drivers get nothing", async () => {
    await withSession(async (s) => {
      const w = await stopWorld(s);
      await saveStops(s, w.order.id, twoStops(w.today));
      const n = await stopNotices(s, w.u1);
      expect(n).toHaveLength(1);
      expect(n[0].title).toMatch(new RegExp(`^2 stops added: ${w.order.number} load 1 on .*, 7:00–14:00$`));
      expect(n[0].detail).toMatch(/^Pickup at Midwest Steel \(Portage, IN\); Delivery at Lakeside Build \(Gary, IN\), \w{3} \w{3} \d+ 15:00–16:00\. Check My Day\.$/);

      // An order nobody is assigned to: nobody is told. The other driver never hears about this load.
      await s.as(w.office);
      await saveStops(s, w.open.id, twoStops(w.today));
      expect(await stopNotices(s, w.u2)).toHaveLength(0);
      expect(await stopNotices(s, w.u1)).toHaveLength(1);

      // The driver reads their own notice (row-level security), with its detail.
      await s.as(w.u1);
      expect((await s.query<{ detail: string }>("select detail from public.alerts where event_type = 'dispatch.stop_added'")).rows).toHaveLength(1);
      await s.as(w.u2);
      expect((await s.query("select 1 from public.alerts where event_type = 'dispatch.stop_added'")).rows).toHaveLength(0);
    });
  });

  it("a later save that adds one delivery is one more notice naming it; an edit or removal is none", async () => {
    await withSession(async (s) => {
      const w = await stopWorld(s);
      // Stops saved before (another day's save): as if committed earlier, without telling anyone now.
      await s.asAdmin();
      await s.query("alter table public.order_stops disable trigger alerts_new_stops");
      await s.as(w.office);
      await saveStops(s, w.order.id, twoStops(w.today));
      await s.asAdmin();
      await s.query("alter table public.order_stops enable trigger alerts_new_stops");
      await s.query("update public.order_stops set created_at = created_at - interval '1 day' where order_id = $1", [w.order.id]);
      await s.query("set constraints all deferred");
      await s.as(w.office);
      const kept = (await s.query<{ id: string; kind: string; name: string }>("select id, kind, name from public.order_stops where order_id = $1 and removed_at is null order by seq", [w.order.id])).rows;

      // Edit (same ids) and remove one: nothing is told.
      await saveStops(s, w.order.id, kept.map((k) => ({ ...k, reference: "PO-1" })));
      expect(await stopNotices(s, w.u1)).toHaveLength(0);

      await s.as(w.office);
      await saveStops(s, w.order.id, [kept[0], { kind: "delivery", name: "Dune Acres Depot" }, kept[1]]);
      const n = await stopNotices(s, w.u1);
      expect(n).toHaveLength(1);
      expect(n[0].title).toMatch(new RegExp(`^Stop added: ${w.order.number} load 1 on `));
      expect(n[0].detail).toBe("Delivery at Dune Acres Depot. Check My Day.");
    });
  });

  it("the rollback removes the notice: a new stop tells nobody", async () => {
    await withSession(async (s) => {
      const w = await stopWorld(s);
      await s.asAdmin();
      await s.query(sql("rollbacks", "20261120024600_stop_added_notice.down.sql"));
      await s.as(w.office);
      await saveStops(s, w.order.id, twoStops(w.today));
      expect(await stopNotices(s, w.u1)).toHaveLength(0);
    });
  });
});

describe("truck health default (At risk from 3)", () => {
  it("new companies get 3; only companies that never set their rules move to 3; the rollback goes back", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const def = await s.query<{ d: string }>("select column_default d from information_schema.columns where table_schema = 'public' and table_name = 'company_settings' and column_name = 'truck_health_rules'");
      expect(def.rows[0].d).toContain('"at_risk_repairs": 3');
      const untouched = await s.createCompany(`Health A ${tag()}`);
      const chosen = await s.createCompany(`Health B ${tag()}`);
      const rules = async (c: string) => (await s.query<{ r: { at_risk_repairs: number } }>("select truck_health_rules r from public.company_settings where company_id = $1", [c])).rows[0].r.at_risk_repairs;
      expect(await rules(untouched)).toBe(3);

      // A company with the old default that nobody changed (as before the update): set without an audit entry.
      await s.query("alter table public.company_settings disable trigger company_settings_audit");
      await s.query(`update public.company_settings set truck_health_rules = '{"at_risk_repairs": 2, "watch_repairs": 1, "watch_open": 2, "service_overdue": "watch"}' where company_id = $1`, [untouched]);
      await s.query("alter table public.company_settings enable trigger company_settings_audit");
      // A company whose owner chose 2 in Settings: audited, kept.
      const owner = await s.createUser("owner", { companyId: chosen });
      await s.as(owner);
      await s.query(`update public.company_settings set truck_health_rules = '{"at_risk_repairs": 2, "watch_repairs": 1, "watch_open": 2, "service_overdue": "watch"}' where company_id = $1`, [chosen]);
      await s.asAdmin();
      expect(await rules(chosen)).toBe(2);

      await s.query(sql("migrations", "20261120024610_truck_health_default_three.sql"));
      expect(await rules(untouched)).toBe(3);
      expect(await rules(chosen)).toBe(2);

      await s.query(sql("rollbacks", "20261120024610_truck_health_default_three.down.sql"));
      expect(await rules(untouched)).toBe(2);
      expect(await rules(chosen)).toBe(2);
      expect((await s.query<{ d: string }>("select column_default d from information_schema.columns where table_schema = 'public' and table_name = 'company_settings' and column_name = 'truck_health_rules'")).rows[0].d).toContain('"at_risk_repairs": 2');
    });
  });
});

/** A company with an owner and `n` trucks; returns ids. */
async function shop(s: Session, n: number) {
  const company = await s.createCompany(`WK3 shop ${tag()}`);
  const owner = await s.createUser("owner", { companyId: company });
  await s.as(owner);
  const trucks: string[] = [];
  for (let i = 0; i < n; i++) trucks.push(await insert(s, "trucks", { unit_number: `W${i}-${tag()}`, truck_type: "tri_axle_dump" }));
  return { company, owner, trucks };
}
const createWo = (s: Session, p: Record<string, unknown>) => s.query<{ r: { id: string } }>("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify(p)]).then((r) => r.rows[0].r.id);

describe("demo repair history", () => {
  it("spreads sample repairs over months so one truck at most reaches 3 recent repairs; demos only, once", async () => {
    await withSession(async (s) => {
      const { company, owner, trucks } = await shop(s, 4);
      // Six completed sample jobs today (as the demo seed makes them): 3 on the first truck, 2 on the second, 1 on the third;
      // the second truck also has an open repair of its own.
      const plan = [0, 0, 0, 1, 1, 2];
      const ids: string[] = [];
      for (const t of plan) {
        const id = await createWo(s, { truck_id: trucks[t], title: "Replace brake shoes", category: "brakes", description: MARK });
        await s.query("select public.maintenance_set_status($1, 'in_progress', '')", [id]);
        await s.query("select public.maintenance_set_status($1, 'completed', '')", [id]);
        ids.push(id);
      }
      await createWo(s, { truck_id: trucks[1], title: "Dash light", category: "electrical" });
      const t = await businessToday(s);
      await s.as(owner);
      await s.query("select public.maintenance_add_mechanic($1, $2, true)", [ids[3], owner]);
      const started = new Date(`${addDays(t, -8)}T13:00:00Z`);
      await s.query("select public.maintenance_add_time($1, $2, $3, $4, 'Demo')", [ids[3], owner, started.toISOString(), new Date(started.getTime() + 3_600_000).toISOString()]);
      // The owner already has recorded time on another job on the first day the move would pick: that day is skipped.
      const other = await createWo(s, { truck_id: trucks[3], title: "Old job", category: "preventive" });
      await s.query("select public.maintenance_set_status($1, 'in_progress', '')", [other]);
      await s.query("select public.maintenance_add_mechanic($1, $2, true)", [other, owner]);
      const busy = new Date(`${addDays(t, -130)}T13:30:00Z`);
      await s.query("select public.maintenance_add_time($1, $2, $3, $4, 'Earlier work')", [other, owner, busy.toISOString(), new Date(busy.getTime() + 3_600_000).toISOString()]);

      // A real company: refused, nothing moves.
      expect((await pgError(s.query("select public.demo_repair_history()"))).code).toBe("42501");
      expect((await pgError(s.query("select public.demo_part_arrival_sample()"))).code).toBe("42501");

      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [company]);
      await s.as(owner);
      const moved = (await s.query<{ n: number }>("select public.demo_repair_history() n")).rows[0].n;
      // The first truck keeps all three (it shows the rule); the others keep no recent sample repair (the second keeps its
      // own open repair: Watch; the third is Good).
      expect(moved).toBe(3);
      expect((await s.query<{ n: number }>("select public.demo_repair_history() n")).rows[0].n).toBe(0);

      await s.asAdmin();
      const recent = await s.query<{ truck_id: string; n: string }>(
        `select truck_id, count(*) n from public.work_orders where company_id = $1 and status <> 'canceled'
           and created_at >= ($2::date - 90)::timestamptz group by truck_id`, [company, t]);
      const by = new Map(recent.rows.map((r) => [r.truck_id, Number(r.n)]));
      expect(by.get(trucks[0])).toBe(3); // the one truck that shows the "3 unplanned repairs" rule
      expect(by.get(trucks[1])).toBe(1);
      expect(by.get(trucks[2])).toBeUndefined();
      expect([...by.values()].filter((n) => n >= 3)).toHaveLength(1);
      // A moved job moved as a whole: opened, completed and worked in the past, in order, inside the estimates' year.
      const j = (await s.query<{ created: string; completed: string; worked: string | null }>(
        `select w.created_at::date::text created, w.completed_at::date::text completed,
                (select min(e.started_at)::date::text from public.work_order_time_entries e where e.work_order_id = w.id) worked
           from public.work_orders w where w.id = $1`, [ids[3]])).rows[0];
      expect(j.created < addDays(t, -90)).toBe(true);
      expect(j.created >= addDays(t, -365)).toBe(true);
      expect(j.worked).not.toBeNull();
      expect(j.worked).not.toBe(addDays(t, -130)); // not on top of the owner's earlier work
      expect(j.worked! <= j.completed && j.worked! >= addDays(t, -365)).toBe(true);
    });
  });
});

describe("a shop job scheduled before its part arrives", () => {
  it("the demo sample is a scheduled job with its part expected later; once per demo", async () => {
    await withSession(async (s) => {
      const t = await businessToday(s);
      const { company, owner } = await shop(s, 2);
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [company]);
      await s.as(owner);
      expect((await s.query<{ n: number }>("select public.demo_part_arrival_sample() n")).rows[0].n).toBe(1);
      expect((await s.query<{ n: number }>("select public.demo_part_arrival_sample() n")).rows[0].n).toBe(0);
      const wo = (await s.query<{ id: string; status: string; scheduled_for: string; assigned_to: string }>(
        "select id, status, scheduled_for::text, assigned_to from public.work_orders where title = 'Replace wiper motor (demo)'")).rows[0];
      expect(wo).toMatchObject({ status: "scheduled", scheduled_for: addDays(t, 2), assigned_to: owner });
      const parts = (await s.query<{ expected_on: string; status: string }>("select expected_on::text, status from public.part_waits($1)", [wo.id])).rows;
      expect(parts).toEqual([{ expected_on: addDays(t, 5), status: "waiting" }]);
    });
  });

  it("moving to the arrival day changes only the date, is recorded, and needs maintenance.manage", async () => {
    await withSession(async (s) => {
      const t = await businessToday(s);
      const { company, owner, trucks } = await shop(s, 1);
      const id = await createWo(s, { truck_id: trucks[0], title: "Wiper motor", category: "electrical", urgency: "high", scheduled_for: addDays(t, 1), description: "Keep me" });
      await s.query("select public.part_wait_add($1, $2::jsonb)", [id, JSON.stringify({ description: "Wiper motor", expected_on: addDays(t, 4) })]);
      const seq = (await s.query<{ edit_seq: number }>("select edit_seq from public.work_orders where id = $1", [id])).rows[0].edit_seq;

      // Someone who sees the shop but does not plan it cannot move it.
      const viewer = await s.createUser("driver", { companyId: company });
      await s.as(viewer);
      expect((await pgError(s.query("select public.maintenance_update_work_order($1, $2, $3::jsonb)", [id, seq, JSON.stringify({ scheduled_for: addDays(t, 4) })]))).code).toBe("42501");

      await s.as(owner);
      await s.query("select public.maintenance_update_work_order($1, $2, $3::jsonb)", [id, seq, JSON.stringify({ scheduled_for: addDays(t, 4) })]);
      const after = (await s.query<{ scheduled_for: string; status: string; urgency: string; description: string; title: string }>(
        "select scheduled_for::text, status, urgency, description, title from public.work_orders where id = $1", [id])).rows[0];
      expect(after).toEqual({ scheduled_for: addDays(t, 4), status: "scheduled", urgency: "high", description: "Keep me", title: "Wiper motor" });
      const ev = (await s.query<{ kind: string; details: { from: string; scheduled_for: string } }>(
        "select kind, details from public.work_order_events where work_order_id = $1 and kind = 'rescheduled'", [id])).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0].details).toEqual({ from: addDays(t, 1), scheduled_for: addDays(t, 4) });
    });
  });
});
