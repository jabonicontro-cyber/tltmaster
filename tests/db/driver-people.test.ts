import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pool, TOP_LINE, withoutPermission, withSession, type Session } from "./helpers";

// Every driver is in People (owner decision 2026-11-09, master plan WK1; migration 20261120010000): the backfill and
// the trigger give each of the company's own drivers one People record, however the driver is created; hired-truck
// drivers (another company's) get none.
afterAll(() => pool.end());

const tag = () => Math.random().toString(36).slice(2, 7);
const people = async (s: Session, driverId: string) =>
  (await s.query<{ id: string; company_id: string; user_id: string | null; full_name: string; status: string; department: string }>(
    "select id, company_id, user_id, full_name, status, department from public.employees where driver_id = $1", [driverId])).rows;

describe("drivers in People", () => {
  it("a driver inserted directly gets exactly one People record, even for someone who may not edit People", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await withoutPermission(s, "office", "employees.edit");
      await s.as(office);
      const name = `Direct Driver ${tag()}`;
      const d = (await s.query<{ id: string }>("insert into public.drivers (name, phone, hire_date) values ($1, '555-0100', '2025-03-01') returning id", [name])).rows[0].id;
      await s.asAdmin();
      const rows = await people(s, d);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ company_id: TOP_LINE, user_id: null, full_name: name, status: "active", department: "operations" });
      const inactive = (await s.query<{ id: string }>("insert into public.drivers (company_id, name, active) values ($1, $2, false) returning id", [TOP_LINE, `Old Driver ${tag()}`])).rows[0].id;
      expect((await people(s, inactive))[0].status).toBe("inactive");
    });
  });

  it("a driver with a login joins that login's People record instead of adding a second one", async () => {
    await withSession(async (s) => {
      const driverUser = await s.createUser("driver");
      await s.asAdmin();
      const emp = (await s.query<{ id: string }>("insert into public.employees (company_id, user_id, full_name) values ($1, $2, 'Logged In Driver') returning id", [TOP_LINE, driverUser])).rows[0].id;
      const d = (await s.query<{ id: string }>("insert into public.drivers (company_id, user_id) values ($1, $2) returning id", [TOP_LINE, driverUser])).rows[0].id;
      expect((await people(s, d)).map((r) => r.id)).toEqual([emp]);
      expect((await s.query("select 1 from public.employees where user_id = $1", [driverUser])).rowCount).toBe(1);

      // A login without a People record: the new record carries it.
      const other = await s.createUser("driver");
      const d2 = (await s.query<{ id: string }>("insert into public.drivers (company_id, user_id) values ($1, $2) returning id", [TOP_LINE, other])).rows[0].id;
      expect((await people(s, d2)).map((r) => [r.user_id, r.full_name])).toEqual([[other, "Test driver"]]);

      // The login moves to a new driver record (taken off the first in Fleet): the person's record follows the login,
      // and the earlier driver gets its own record, so nobody is listed twice under one login.
      await s.query("update public.drivers set user_id = null, name = 'Earlier Record', active = false where id = $1", [d]);
      const d3 = (await s.query<{ id: string }>("insert into public.drivers (company_id, user_id) values ($1, $2) returning id", [TOP_LINE, driverUser])).rows[0].id;
      expect((await people(s, d3)).map((r) => [r.id, r.user_id])).toEqual([[emp, driverUser]]);
      expect((await people(s, d)).map((r) => [r.user_id, r.full_name, r.status])).toEqual([[null, "Earlier Record", "inactive"]]);
    });
  });

  it("follows renames and deactivation, without overwriting a name changed in People", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const d = (await s.query<{ id: string }>("insert into public.drivers (company_id, name) values ($1, 'Sam  Before') returning id", [TOP_LINE])).rows[0].id;
      expect((await people(s, d))[0].full_name).toBe("Sam Before");
      await s.query("update public.drivers set name = 'Sam After' where id = $1", [d]);
      expect((await people(s, d))[0].full_name).toBe("Sam After");
      await s.query("update public.drivers set active = false where id = $1", [d]);
      expect((await people(s, d))[0].status).toBe("inactive");
      await s.query("update public.drivers set active = true where id = $1", [d]);
      expect((await people(s, d))[0].status).toBe("active");
      // Edited in People: a later Fleet rename leaves it; on leave stays on leave.
      await s.query("update public.employees set full_name = 'Samuel Chosen', status = 'on_leave' where driver_id = $1", [d]);
      await s.query("update public.drivers set name = 'Sam Again', active = false where id = $1", [d]);
      expect((await people(s, d)).map((r) => [r.full_name, r.status])).toEqual([["Samuel Chosen", "on_leave"]]);
    });
  });

  it("hired-truck drivers get no People record", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const hauler = (await s.query<{ id: string }>("insert into public.haulers (company_id, name) values ($1, $2) returning id", [TOP_LINE, `Hauler ${tag()}`])).rows[0].id;
      const d = (await s.query<{ id: string }>("insert into public.drivers (company_id, name, hauler_id) values ($1, 'Hired Hank', $2) returning id", [TOP_LINE, hauler])).rows[0].id;
      expect(await people(s, d)).toEqual([]);
      await s.query("update public.drivers set name = 'Hired Henry', active = false where id = $1", [d]);
      expect(await people(s, d)).toEqual([]);
    });
  });

  it("stays in the driver's own company: another company's people cannot see it", async () => {
    await withSession(async (s) => {
      const other = await s.createCompany(`Other Haul ${tag()}`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      const topOwner = await s.createUser("owner");
      await s.as(otherOwner);
      const d = (await s.query<{ id: string }>("insert into public.drivers (name) values ('Other Driver') returning id")).rows[0].id;
      await s.asAdmin();
      expect((await people(s, d)).map((r) => r.company_id)).toEqual([other]);
      await s.as(topOwner);
      expect((await s.query("select 1 from public.employees where driver_id = $1", [d])).rowCount).toBe(0);
      await s.as(otherOwner);
      expect((await s.query("select 1 from public.employees where driver_id = $1", [d])).rowCount).toBe(1);
    });
  });

  it("the backfill is idempotent: every own driver has one record and running it again adds none", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const sql = readFileSync(join(__dirname, "../../supabase/migrations/20261120010000_driver_people.sql"), "utf8");
      const backfill = sql.slice(sql.indexOf("-- Backfill (idempotent)"));
      const before = Number((await s.query<{ n: string }>("select count(*) as n from public.employees")).rows[0].n);
      await s.query(backfill);
      expect(Number((await s.query<{ n: string }>("select count(*) as n from public.employees")).rows[0].n)).toBe(before);
      const missing = await s.query("select 1 from public.drivers d where d.hauler_id is null and not exists (select 1 from public.employees e where e.company_id = d.company_id and e.driver_id = d.id)");
      expect(missing.rowCount).toBe(0);
      const doubled = await s.query("select driver_id from public.employees where driver_id is not null group by company_id, driver_id having count(*) > 1");
      expect(doubled.rowCount).toBe(0);
    });
  });
});
