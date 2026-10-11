import { afterAll, describe, expect, it } from "vitest";
import { insert } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

const tag = () => Math.random().toString(36).slice(2, 7);

describe("employees", () => {
  it("is a directory for people with employees.view; drivers see only their own record", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const driverUser = await s.createUser("driver");
      await s.as(owner);
      const e1 = await insert(s, "employees", { full_name: `Shop Hand ${tag()}`, department: "shop" });

      for (const role of ["office", "dispatcher", "mechanic"] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await s.query("select id from public.employees where id = $1", [e1])).rowCount, role).toBe(1);
      }
      await s.asAdmin();
      const own = await s.query<{ id: string }>("insert into public.employees (company_id, user_id, full_name) select company_id, user_id, 'Me Driver' from public.company_memberships where user_id = $1 returning id", [driverUser]);
      await s.as(driverUser);
      const seen = await s.query<{ id: string }>("select id from public.employees");
      expect(seen.rows.map((r) => r.id)).toEqual([own.rows[0].id]);
    });
  });

  it("only employees.edit may add or change records, and nobody can delete them", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(office);
      const id = await insert(s, "employees", { full_name: `New Hire ${tag()}`, job_title: "Loader operator", hire_date: "2026-09-01" });
      await s.query("update public.employees set status = 'on_leave' where id = $1", [id]);

      await s.as(dispatcher);
      expect((await pgError(insert(s, "employees", { full_name: "Not allowed" }))).code).toBe("42501");
      const upd = await s.query("update public.employees set job_title = 'Boss' where id = $1", [id]);
      expect(upd.rowCount).toBe(0);

      await s.as(office);
      expect((await pgError(s.query("delete from public.employees where id = $1", [id]))).code).toBe("42501");
      // Terminated needs an end date.
      expect((await pgError(s.query("update public.employees set status = 'terminated' where id = $1", [id]))).code).toBe("23514");
    });
  });

  it("keeps pay confidential: only employees.compensation can see or change it, and the audit log has no amounts", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const id = await insert(s, "employees", { full_name: `Paid Person ${tag()}` });
      await s.query("insert into public.employee_compensation (employee_id, pay_type, rate_cents, effective_date) values ($1, 'hourly', 2875, '2026-10-01')", [id]);
      expect((await s.query("select rate_cents from public.employee_compensation where employee_id = $1", [id])).rows[0].rate_cents).toBe("2875");

      for (const role of ["office", "dispatcher", "mechanic", "driver"] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await s.query("select * from public.employee_compensation where employee_id = $1", [id])).rowCount, role).toBe(0);
        const err = await pgError(s.query("insert into public.employee_compensation (employee_id, pay_type, rate_cents) values ($1, 'hourly', 1)", [id]));
        expect(err.code, role).toBe("42501");
      }
      await s.asAdmin();
      const audit = await s.query<{ details: unknown; summary: string }>("select details, summary from public.audit_events where entity_type = 'employee' and entity_id = $1 and action like 'compensation_%'", [id]);
      expect(audit.rowCount).toBe(1);
      expect(JSON.stringify(audit.rows[0])).not.toContain("2875");
    });
  });

  it("keeps companies apart", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const id = await insert(s, "employees", { full_name: `Top Line Person ${tag()}` });
      const other = await s.createCompany("Elsewhere (test)");
      const stranger = await s.createUser("owner", { companyId: other });
      await s.asAdmin();
      await s.query("update public.profiles set active_company_id = $2 where id = $1", [stranger, other]);
      await s.as(stranger);
      expect((await s.query("select * from public.employees where id = $1", [id])).rowCount).toBe(0);
      expect((await s.query("update public.employees set notes = 'x' where id = $1", [id])).rowCount).toBe(0);
      // A record cannot be created in another company either.
      expect((await pgError(s.query("insert into public.employees (company_id, full_name) values ('00000000-0000-4000-8000-000000000001', 'Sneaky')"))).code).toBe("42501");
    });
  });
});

describe("primary trucks", () => {
  it("need fleet.assign, are one per truck, and are not changed by fleet.edit alone", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const truck = await insert(s, "trucks", { unit_number: `PT-${tag()}`, truck_type: "tri_axle_dump" });
      const d1 = await insert(s, "drivers", { name: `Driver One ${tag()}` });
      const d2 = await insert(s, "drivers", { name: `Driver Two ${tag()}` });

      const dispatcher = await s.createUser("dispatcher"); // fleet.assign by default
      await s.as(dispatcher);
      await s.query("select public.set_driver_primary_truck($1, $2)", [d1, truck]);
      const taken = await pgError(s.query("select public.set_driver_primary_truck($1, $2)", [d2, truck]));
      expect(taken.message).toMatch(/already the primary truck of Driver One/);

      const office = await s.createUser("office"); // fleet.edit, no fleet.assign
      await s.as(office);
      expect((await pgError(s.query("select public.set_driver_primary_truck($1, null)", [d1]))).code).toBe("42501");
      expect((await pgError(s.query("update public.drivers set primary_truck_id = null where id = $1", [d1]))).code).toBe("42501");
      // Other edits to the driver still work.
      await s.query("update public.drivers set notes = 'Prefers early starts' where id = $1", [d1]);

      await s.as(dispatcher);
      await s.query("select public.set_driver_primary_truck($1, null)", [d1]);
      await s.query("select public.set_driver_primary_truck($1, $2)", [d2, truck]);
      await s.asAdmin();
      const rows = await s.query("select id, primary_truck_id from public.drivers where id = any($1) order by name", [[d1, d2]]);
      expect(rows.rows.map((r) => r.primary_truck_id)).toEqual([null, truck]);
    });
  });
});
