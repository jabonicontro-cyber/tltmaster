import { afterAll, describe, expect, it } from "vitest";
import { insert } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

// Maintenance crews, labor time and task checklists (20261120002900).

const tag = () => Math.random().toString(36).slice(2, 7);

async function setup(s: Session) {
  const owner = await s.createUser("owner");
  const lead = await s.createUser("mechanic");
  const helper = await s.createUser("mechanic");
  const driver = await s.createUser("driver");
  await s.as(owner);
  const truck = await insert(s, "trucks", { unit_number: `C-${tag()}`, truck_type: "tri_axle_dump" });
  const wo = (await s.query<{ r: { id: string } }>("select public.maintenance_create_work_order($1::jsonb) r",
    [JSON.stringify({ truck_id: truck, title: "Replace brake chamber", category: "brakes", assigned_to: lead })])).rows[0].r.id;
  return { owner, lead, helper, driver, truck, wo };
}

const q1 = async <T,>(s: Session, sql: string, p: unknown[] = []) => (await s.query(sql, p)).rows[0] as T;
const crew = (s: Session, wo: string) => s.query<{ user_id: string; role: string; status: string }>(
  "select user_id, role, status from public.work_order_mechanics where work_order_id = $1 order by role desc", [wo]);

describe("maintenance crews", () => {
  it("the lead follows the assigned mechanic; helpers join; people who cannot do maintenance are refused", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.owner);
      expect((await crew(s, w.wo)).rows).toEqual([{ user_id: w.lead, role: "lead", status: "assigned" }]);
      await s.query("select public.maintenance_add_mechanic($1, $2)", [w.wo, w.helper]);
      expect((await pgError(s.query("select public.maintenance_add_mechanic($1, $2)", [w.wo, w.driver]))).message).toMatch(/cannot work on maintenance/);
      // Making the helper the lead moves the lead role and work_orders.assigned_to together.
      await s.query("select public.maintenance_add_mechanic($1, $2, true)", [w.wo, w.helper]);
      const rows = (await crew(s, w.wo)).rows;
      expect(rows.find((r) => r.role === "lead")?.user_id).toBe(w.helper);
      expect(rows.find((r) => r.user_id === w.lead)?.role).toBe("assist");
      expect((await q1<{ assigned_to: string }>(s, "select assigned_to from public.work_orders where id = $1", [w.wo])).assigned_to).toBe(w.helper);
      await s.as(w.driver);
      expect((await pgError(s.query("select public.maintenance_add_task($1, 'Not mine')", [w.wo]))).code).toBe("42501");
      expect((await crew(s, w.wo)).rowCount).toBe(0); // no maintenance.view
    });
  });

  it("time cannot overlap for one person, one timer runs at a time, and labor hours come from the entries", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.lead);
      expect((await pgError(s.query("select public.maintenance_start_timer($1)", [w.wo]))).message).toMatch(/In progress/);
      await s.query("select public.maintenance_set_status($1, 'in_progress')", [w.wo]);
      await s.query("select public.maintenance_start_timer($1, 'Pulling the wheel')", [w.wo]);
      expect((await pgError(s.query("select public.maintenance_start_timer($1)", [w.wo]))).message).toMatch(/already running/);
      expect((await crew(s, w.wo)).rows[0].status).toBe("working");
      // The running timer blocks sending the work order on and logging overlapping time.
      expect((await pgError(s.query("select public.maintenance_set_status($1, 'completed')", [w.wo]))).message).toMatch(/timer running/);
      expect((await pgError(s.query("select public.maintenance_add_time($1, $2, now() - interval '30 minutes', now() + interval '2 minutes')", [w.wo, w.lead]))).message)
        .toMatch(/already has time logged/);
      await s.query("select public.maintenance_stop_timer('Chamber replaced')");
      expect((await pgError(s.query("select public.maintenance_stop_timer()"))).message).toMatch(/no timer/);

      // Two hours yesterday for the helper (who must be on the crew first), then the same hours again is refused.
      await s.as(w.owner);
      expect((await pgError(s.query("select public.maintenance_add_time($1, $2, now() - interval '26 hours', now() - interval '24 hours')", [w.wo, w.helper]))).message)
        .toMatch(/Add that person to the crew/);
      await s.query("select public.maintenance_add_mechanic($1, $2)", [w.wo, w.helper]);
      const entry = (await q1<{ id: string }>(s, "select public.maintenance_add_time($1, $2, now() - interval '26 hours', now() - interval '24 hours', 'Diagnosis') id", [w.wo, w.helper])).id;
      expect((await pgError(s.query("select public.maintenance_add_time($1, $2, now() - interval '25 hours', now() - interval '23 hours')", [w.wo, w.helper]))).message)
        .toMatch(/already has time logged/);
      expect((await pgError(s.query("select public.maintenance_add_time($1, $2, now() - interval '20 hours', now() + interval '2 hours')", [w.wo, w.helper]))).message)
        .toMatch(/future/);
      const hours = async () => Number((await q1<{ labor_hours: string }>(s, "select labor_hours from public.work_orders where id = $1", [w.wo])).labor_hours);
      expect(await hours()).toBeCloseTo(2, 1);

      // A wrong entry is voided with a reason, never deleted, and stops counting.
      expect((await pgError(s.query("select public.maintenance_void_time($1, '')", [entry]))).message).toMatch(/why/);
      await s.query("select public.maintenance_void_time($1, 'Logged on the wrong truck')", [entry]);
      expect(await hours()).toBeCloseTo(0, 1);
      expect((await s.query("select 1 from public.work_order_time_entries where id = $1 and voided_at is not null", [entry])).rowCount).toBe(1);

      // With no timer running, the work order can move on.
      await s.query("select public.maintenance_set_status($1, 'completed')", [w.wo]);
      const kinds = (await s.query<{ kind: string }>("select kind from public.work_order_events where work_order_id = $1", [w.wo])).rows.map((r) => r.kind);
      expect(kinds).toEqual(expect.arrayContaining(["crew", "time"]));
    });
  });

  it("a mechanic's timer is for one job at a time across work orders", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.owner);
      const other = (await q1<{ r: { id: string } }>(s, "select public.maintenance_create_work_order($1::jsonb) r",
        [JSON.stringify({ truck_id: w.truck, title: "Check lights", category: "electrical" })])).r.id;
      await s.as(w.lead);
      for (const id of [w.wo, other]) await s.query("select public.maintenance_set_status($1, 'in_progress')", [id]);
      await s.query("select public.maintenance_start_timer($1)", [w.wo]);
      expect((await pgError(s.query("select public.maintenance_start_timer($1)", [other]))).message).toMatch(/already running on/);
    });
  });

  it("task checklists, and another company sees none of it", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.lead);
      const t1 = (await q1<{ id: string }>(s, "select public.maintenance_add_task($1, 'Cage the spring brake') id", [w.wo])).id;
      await s.query("select public.maintenance_add_task($1, 'Torque the mounting nuts')", [w.wo]);
      await s.query("select public.maintenance_set_task($1, 'done')", [t1]);
      const tasks = (await s.query<{ position: number; status: string }>("select position, status from public.work_order_tasks where work_order_id = $1 order by position", [w.wo])).rows;
      expect(tasks).toEqual([{ position: 1, status: "done" }, { position: 2, status: "open" }]);

      const otherCompany = await s.createCompany(`Other ${tag()}`);
      const outsider = await s.createUser("owner", { companyId: otherCompany });
      await s.asAdmin();
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [otherCompany, outsider]);
      await s.as(outsider);
      for (const table of ["work_order_mechanics", "work_order_tasks", "work_order_time_entries"]) {
        expect((await s.query(`select 1 from public.${table} where work_order_id = $1`, [w.wo])).rowCount).toBe(0);
      }
      expect((await pgError(s.query("select public.maintenance_add_task($1, 'Sneaky')", [w.wo]))).code).toBe("P0002");
    });
  });
});
