import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday, insert } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const tag = () => Math.random().toString(36).slice(2, 7);

async function truck(s: Session, owner: string) {
  await s.as(owner);
  return insert(s, "trucks", { unit_number: `M-${tag()}`, truck_type: "tri_axle_dump" });
}

async function createWo(s: Session, p: Record<string, unknown>) {
  const r = await s.query<{ r: { id: string; number: string; duplicate: boolean } }>(
    "select public.maintenance_create_work_order($1::jsonb) as r", [JSON.stringify(p)]);
  return r.rows[0].r;
}

const status = (s: Session, id: string, to: string, note = "") =>
  s.query("select public.maintenance_set_status($1, $2, $3)", [id, to, note]);

async function woRow(s: Session, id: string) {
  return (await s.query("select * from public.work_orders where id = $1", [id])).rows[0];
}

async function serviceStatus(s: Session, truckId: string) {
  await s.asAdmin();
  return (await s.query<{ v: string }>("select service_status::text as v from public.trucks where id = $1", [truckId])).rows[0].v;
}

describe("maintenance work orders", () => {
  it("mechanics create and work orders; dispatchers only read; drivers and other companies see nothing", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const mechanic = await s.createUser("mechanic");
      const dispatcher = await s.createUser("dispatcher");
      const driver = await s.createUser("driver");
      const t = await truck(s, owner);

      await s.as(mechanic);
      const wo = await createWo(s, { truck_id: t, title: "Air leak at rear axle", category: "brakes", urgency: "high" });
      expect(wo.number).toMatch(/^MWO-\d{4,}$/);
      expect((await woRow(s, wo.id)).status).toBe("reported");

      await s.as(dispatcher);
      expect((await s.query("select id from public.work_orders where id = $1", [wo.id])).rowCount).toBe(1);
      expect((await pgError(createWo(s, { truck_id: t, title: "Not allowed" }))).code).toBe("42501");
      expect((await pgError(status(s, wo.id, "triaged"))).code).toBe("42501");

      await s.as(driver);
      expect((await s.query("select id from public.work_orders")).rowCount).toBe(0);

      const other = await s.createCompany(`Other ${tag()}`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select id from public.work_orders where id = $1", [wo.id])).rowCount).toBe(0);
      expect((await s.query("select id from public.work_order_events where work_order_id = $1", [wo.id])).rowCount).toBe(0);
      // Another company's truck cannot be used, and another company's work order cannot be moved.
      expect((await pgError(createWo(s, { truck_id: t, title: "Cross company" }))).code).toBe("P0002");
      expect((await pgError(status(s, wo.id, "triaged"))).code).toBe("P0002");
    });
  });

  it("a double submit creates one work order", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const t = await truck(s, owner);
      const key = crypto.randomUUID();
      const a = await createWo(s, { truck_id: t, title: "Check lights", submission_key: key });
      const b = await createWo(s, { truck_id: t, title: "Check lights", submission_key: key });
      expect(b.id).toBe(a.id);
      expect(b.duplicate).toBe(true);
    });
  });

  it("allows only valid lifecycle transitions", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const t = await truck(s, owner);
      const wo = await createWo(s, { truck_id: t, title: "Replace wiper motor", category: "electrical" });

      expect((await pgError(status(s, wo.id, "completed"))).message).toMatch(/cannot go from reported to completed/);
      expect((await pgError(status(s, wo.id, "scheduled"))).message).toMatch(/scheduled date/);
      expect((await pgError(status(s, wo.id, "canceled"))).message).toMatch(/reason/);
      await status(s, wo.id, "triaged");
      await status(s, wo.id, "in_progress");
      await status(s, wo.id, "awaiting_parts");
      await status(s, wo.id, "in_progress");
      await status(s, wo.id, "completed");
      await status(s, wo.id, "closed");
      expect((await pgError(status(s, wo.id, "in_progress"))).message).toMatch(/cannot go from closed/);
      expect((await pgError(s.query("select public.maintenance_update_work_order($1, null, '{\"title\":\"Changed\"}')", [wo.id]))).message).toMatch(/closed/);

      const history = await s.query<{ to_status: string }>(
        "select to_status from public.work_order_events where work_order_id = $1 and kind = 'status' order by created_at, id", [wo.id]);
      expect(history.rows.map((r) => r.to_status)).toEqual(
        expect.arrayContaining(["triaged", "in_progress", "awaiting_parts", "completed", "closed"]));
      // Direct writes are not possible: everything goes through the checked functions.
      expect((await pgError(s.query("update public.work_orders set status = 'closed' where id = $1", [wo.id]))).code).toBe("42501");
    });
  });

  it("refuses stale edits", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const t = await truck(s, owner);
      const wo = await createWo(s, { truck_id: t, title: "Hood latch" });
      await s.query("select public.maintenance_update_work_order($1, 1, '{\"findings\":\"Latch bent\"}')", [wo.id]);
      expect((await pgError(s.query("select public.maintenance_update_work_order($1, 1, '{\"findings\":\"Other\"}')", [wo.id]))).code).toBe("PT409");
    });
  });
});

describe("safety-critical defects and clearance", () => {
  it("restricts the truck; it cannot return to service or be dispatch-ready until an authorized inspection passes", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const mechanic = await s.createUser("mechanic");
      const t = await truck(s, owner);

      await s.as(mechanic);
      const wo = await createWo(s, { truck_id: t, title: "Brake chamber cracked", category: "brakes", urgency: "immediate", safety_critical: true });
      expect(await serviceStatus(s, t)).toBe("out_of_service");

      // Nobody can bypass clearance through the fleet page.
      await s.as(owner);
      expect((await pgError(s.query("select public.set_equipment_service_status('truck', $1, 'in_service')", [t]))).message).toMatch(/safety-critical work order/);
      const elig = await s.query<{ r: { blockers: { code: string }[] } }>("select public.check_assignment_eligibility($1, null, null) as r", [t]);
      expect(JSON.stringify(elig.rows[0].r)).toContain("truck_out_of_service");

      await s.as(mechanic);
      await status(s, wo.id, "in_progress");
      expect((await pgError(status(s, wo.id, "completed"))).message).toMatch(/cannot be completed directly/);
      expect((await pgError(status(s, wo.id, "canceled", "Not needed"))).code).toBe("42501");
      expect((await pgError(s.query("select public.maintenance_update_work_order($1, null, '{\"safety_critical\":false}')", [wo.id]))).code).toBe("42501");
      await status(s, wo.id, "awaiting_inspection");
      expect((await woRow(s, wo.id)).clearance_status).toBe("awaiting");
      expect((await pgError(status(s, wo.id, "completed"))).message).toMatch(/waiting for inspection/);
      // A mechanic without maintenance.clear cannot inspect or clear.
      expect((await pgError(s.query("select public.maintenance_record_clearance($1, 'passed', '')", [wo.id]))).code).toBe("42501");

      await s.as(owner);
      await s.query("select public.maintenance_start_inspection($1)", [wo.id]);
      expect((await pgError(s.query("select public.maintenance_record_clearance($1, 'failed', '')", [wo.id]))).message).toMatch(/what failed/);
      await s.query("select public.maintenance_record_clearance($1, 'failed', 'Slack adjuster out of spec')", [wo.id]);
      let row = await woRow(s, wo.id);
      expect([row.status, row.clearance_status]).toEqual(["in_progress", "failed"]);
      expect(await serviceStatus(s, t)).toBe("out_of_service");

      await s.as(mechanic);
      await status(s, wo.id, "awaiting_inspection");
      await s.as(owner);
      const r = await s.query<{ r: { returned_to_service: boolean } }>("select public.maintenance_record_clearance($1, 'passed', 'Brakes adjusted and tested') as r", [wo.id]);
      expect(r.rows[0].r.returned_to_service).toBe(true);
      row = await woRow(s, wo.id);
      expect([row.status, row.clearance_status, row.cleared_by]).toEqual(["completed", "cleared", owner]);
      expect(await serviceStatus(s, t)).toBe("in_service");

      const kinds = await s.query<{ kind: string }>("select kind from public.work_order_events where work_order_id = $1", [wo.id]);
      expect(kinds.rows.map((k) => k.kind)).toEqual(expect.arrayContaining(["restricted", "inspection_started", "inspection_failed", "cleared", "returned_to_service"]));
    });
  });

  it("keeps the truck restricted while another safety-critical work order is open", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const t = await truck(s, owner);
      const a = await createWo(s, { truck_id: t, title: "Steering play", safety_critical: true });
      await createWo(s, { truck_id: t, title: "Tire sidewall cut", safety_critical: true });
      await status(s, a.id, "in_progress");
      await status(s, a.id, "awaiting_inspection");
      const r = await s.query<{ r: { returned_to_service: boolean } }>("select public.maintenance_record_clearance($1, 'passed', 'OK') as r", [a.id]);
      expect(r.rows[0].r.returned_to_service).toBe(false);
      expect(await serviceStatus(s, t)).toBe("out_of_service");
    });
  });
});

describe("costs", () => {
  it("are visible and editable only with maintenance.costs", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const mechanic = await s.createUser("mechanic");
      const t = await truck(s, owner);
      const wo = await createWo(s, { truck_id: t, title: "Replace alternator" });

      await s.as(office);
      await s.query("insert into public.work_order_costs (work_order_id, kind, description, part_number, vendor_name, quantity, unit_cost_cents) values ($1, 'part', 'Alternator', 'ALT-200', 'Parts Co', 1, 41500)", [wo.id]);
      expect((await s.query("select id from public.work_order_costs where work_order_id = $1", [wo.id])).rowCount).toBe(1);

      for (const u of [mechanic, await s.createUser("dispatcher"), await s.createUser("driver")]) {
        await s.as(u);
        expect((await s.query("select id from public.work_order_costs where work_order_id = $1", [wo.id])).rowCount).toBe(0);
        expect((await pgError(s.query("insert into public.work_order_costs (work_order_id, kind, description, unit_cost_cents) values ($1, 'labor', 'Labor', 100)", [wo.id]))).code).toBe("42501");
      }

      await s.as(owner);
      await status(s, wo.id, "canceled", "Duplicate");
      await s.as(office);
      expect((await pgError(s.query("insert into public.work_order_costs (work_order_id, kind, description, unit_cost_cents) values ($1, 'labor', 'Labor', 100)", [wo.id]))).message).toMatch(/canceled/);
    });
  });
});

describe("preventive maintenance", () => {
  it("flags overdue, due soon and unknown; readings never go down", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const t = await truck(s, owner);
      const save = async (p: Record<string, unknown>) =>
        (await s.query<{ id: string }>("select public.maintenance_save_schedule($1::jsonb) as id", [JSON.stringify({ truck_id: t, ...p })])).rows[0].id;
      const days = await save({ name: "Annual DOT inspection", interval_days: 365, last_done_on: addDays(today, -400) });
      const soon = await save({ name: "Grease", interval_days: 30, warn_days: 7, last_done_on: addDays(today, -25) });
      const ok = await save({ name: "Coolant", interval_days: 365, last_done_on: addDays(today, -10) });
      const miles = await save({ name: "Oil and filter", interval_miles: 15000, warn_miles: 1000, last_done_miles: 100000 });
      const never = await save({ name: "Hydraulic filter", interval_hours: 500 });

      const state = async () => Object.fromEntries((await s.query<{ schedule_id: string; state: string; miles_state: string | null }>(
        "select schedule_id, state, miles_state from public.maintenance_pm_status() where truck_id = $1", [t])).rows.map((r) => [r.schedule_id, r]));

      let st = await state();
      expect(st[days].state).toBe("overdue");
      expect(st[soon].state).toBe("due_soon");
      expect(st[ok].state).toBe("ok");
      expect(st[miles].state).toBe("unknown"); // no odometer reading yet: shown as unknown, not as fine
      expect(st[never].state).toBe("unknown"); // never recorded as done

      await s.query("select public.record_truck_reading($1, 114200, null)", [t]);
      st = await state();
      expect(st[miles].state).toBe("due_soon");
      expect((await pgError(s.query("select public.record_truck_reading($1, 114000, null)", [t]))).message).toMatch(/cannot go down/);
      await s.query("select public.record_truck_reading($1, 115000, null)", [t]);
      expect((await state())[miles].state).toBe("overdue");
    });
  });

  it("creates one work order per due schedule, however often it runs, and restarts the schedule when done", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const t = await truck(s, owner);
      const sched = (await s.query<{ id: string }>("select public.maintenance_save_schedule($1::jsonb) as id",
        [JSON.stringify({ truck_id: t, name: "PM service A", interval_days: 90, last_done_on: addDays(today, -95) })])).rows[0].id;

      const first = (await s.query<{ n: number }>("select public.maintenance_generate_due() as n")).rows[0].n;
      expect(first).toBeGreaterThanOrEqual(1);
      expect((await s.query<{ n: number }>("select public.maintenance_generate_due() as n")).rows[0].n).toBe(0);
      const wos = await s.query<{ id: string; urgency: string }>("select id, urgency from public.work_orders where schedule_id = $1", [sched]);
      expect(wos.rowCount).toBe(1);
      expect(wos.rows[0].urgency).toBe("high"); // overdue

      await status(s, wos.rows[0].id, "in_progress");
      await status(s, wos.rows[0].id, "completed");
      const after = await s.query<{ state: string; last_done_on: string }>(
        "select state, last_done_on::text from public.maintenance_pm_status() where schedule_id = $1", [sched]);
      expect(after.rows[0]).toEqual({ state: "ok", last_done_on: today });
      expect((await s.query<{ n: number }>("select public.maintenance_generate_due() as n")).rows[0].n).toBe(0);
    });
  });
});

describe("driver notices", () => {
  it("tell the driver of their primary truck when maintenance is scheduled, rescheduled or canceled", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const driverUser = await s.createUser("driver");
      const t = await truck(s, owner);
      await s.asAdmin();
      const d = (await s.query<{ id: string }>("insert into public.drivers (company_id, user_id, name) select company_id, user_id, 'Notice Driver' from public.company_memberships where user_id = $1 returning id", [driverUser])).rows[0].id;
      await s.as(owner);
      await s.query("select public.set_driver_primary_truck($1, $2)", [d, t]);
      const wo = await createWo(s, { truck_id: t, title: "Annual inspection", category: "inspection", scheduled_for: addDays(today, 3) });

      const notices = async () => {
        await s.as(driverUser);
        const r = (await s.query<{ r: { notice: string; scheduled_for: string }[] }>("select public.driver_maintenance_notices() as r")).rows[0].r;
        await s.as(owner);
        return r;
      };
      expect((await notices()).map((n) => [n.notice, n.scheduled_for])).toEqual([["scheduled", addDays(today, 3)]]);
      await s.query("select public.maintenance_update_work_order($1, null, $2::jsonb)", [wo.id, JSON.stringify({ scheduled_for: addDays(today, 5) })]);
      expect((await notices())[0].notice).toBe("rescheduled");
      await status(s, wo.id, "canceled", "Inspection moved to the dealer");
      expect((await notices())[0].notice).toBe("canceled");

      // Drivers still cannot read work orders themselves.
      await s.as(driverUser);
      expect((await s.query("select id from public.work_orders")).rowCount).toBe(0);
    });
  });
});

describe("lifecycle parity", () => {
  it("the buttons the app shows match the transitions the database allows", async () => {
    const { NEXT_STATUSES, WO_STATUSES } = await import("@/lib/maintenance");
    await withSession(async (s) => {
      await s.asAdmin();
      const all = Object.keys(WO_STATUSES);
      for (const from of all) {
        const allowed = (await s.query<{ to: string }>(
          "select t as to from unnest($1::text[]) t where private.wo_transition_ok($2, t)", [all, from])).rows.map((r) => r.to).sort();
        expect(allowed, from).toEqual([...NEXT_STATUSES[from as keyof typeof NEXT_STATUSES]].sort());
      }
    });
  });
});
