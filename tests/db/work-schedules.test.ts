import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

// Work schedules (migration 20261114000300): full-day time off counts the employee's scheduled hours; only an
// approver may enter different hours; days with no scheduled hours are refused; without a schedule nothing changes.
// Fictional data; every test runs in a rolled-back transaction.

afterAll(() => pool.end());

async function employee(s: Session, userId: string | null, companyId = TOP_LINE) {
  await s.asAdmin();
  return (await s.query<{ id: string }>(
    "insert into public.employees (company_id, user_id, full_name, employment_type, hire_date) values ($1, $2, 'Schedule Person', 'full_time', '2020-01-01') returning id",
    [companyId, userId])).rows[0].id;
}
const json = <T>(s: Session, sql: string, p: unknown[]) => s.query<{ r: T }>(sql, p).then((r) => r.rows[0].r);
const save = (s: Session, p: Record<string, unknown>) => json<{ id: string }>(s, "select public.time_off_save($1::jsonb) as r", [JSON.stringify(p)]);
const hours = (s: Session, id: string) => s.query<{ h: string }>("select hours::text as h from public.time_off_requests where id = $1", [id]).then((r) => Number(r.rows[0].h));
/** The Monday at least a week ahead (ISO weekday 1). */
async function nextMonday(s: Session) {
  const today = await businessToday(s);
  const d = new Date(`${addDays(today, 7)}T12:00:00Z`);
  return addDays(addDays(today, 7), (8 - (d.getUTCDay() || 7)) % 7);
}
const WEEK = { mon_hours: 8, tue_hours: 8, wed_hours: 8, thu_hours: 8, fri_hours: 10, sat_hours: 4, sun_hours: 0 };

describe("work schedules and full-day time off", () => {
  it("a full day counts the scheduled hours; the employee cannot under-count; an approver may correct", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const driver = await s.createUser("driver");
      const emp = await employee(s, driver);
      await s.as(owner);
      await s.query("insert into public.employee_work_schedules (employee_id, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours) values ($1, $2, $3, $4, $5, $6, $7, $8)",
        [emp, WEEK.mon_hours, WEEK.tue_hours, WEEK.wed_hours, WEEK.thu_hours, WEEK.fri_hours, WEEK.sat_hours, WEEK.sun_hours]);
      const mon = await nextMonday(s); // (switches to the admin role; set the user after)

      await s.as(driver);
      const week = await save(s, { category: "vacation", start_date: mon, end_date: addDays(mon, 6), full_day: true, hours: "1" });
      expect(await hours(s, week.id)).toBe(46); // 8+8+8+8+10+4+0; the typed 1 h is ignored for the employee
      const fri = await save(s, { category: "personal", start_date: addDays(mon, 11), full_day: true });
      expect(await hours(s, fri.id)).toBe(10); // the Friday after
      expect((await pgError(save(s, { category: "personal", start_date: addDays(mon, 13), full_day: true }))).message).toMatch(/no scheduled hours/);

      await s.as(owner);
      const corrected = await save(s, { employee_id: emp, category: "sick", start_date: addDays(mon, 14), full_day: true, hours: "6" });
      expect(await hours(s, corrected.id)).toBe(6); // approvers may enter a correction
    });
  });

  it("without a schedule a full day keeps its entered hours; partial days keep using their times", async () => {
    await withSession(async (s) => {
      const driver = await s.createUser("driver");
      await employee(s, driver);
      const mon = await nextMonday(s); // (switches to the admin role; set the user after)
      await s.as(driver);
      const day = await save(s, { category: "vacation", start_date: mon, full_day: true, hours: "7.5" });
      expect(await hours(s, day.id)).toBe(7.5);
      const part = await save(s, { category: "personal", start_date: addDays(mon, 1), full_day: false, start_time: "13:00", end_time: "15:30" });
      expect(await hours(s, part.id)).toBe(2.5);
    });
  });

  it("schedules are private to the company, readable by the employee, and changed only with employees.edit", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const driver = await s.createUser("driver");
      const other = await s.createUser("driver");
      const emp = await employee(s, driver);
      const otherEmp = await employee(s, other);
      await s.as(owner);
      await s.query("insert into public.employee_work_schedules (employee_id, mon_hours) values ($1, 8), ($2, 9)", [emp, otherEmp]);

      await s.as(driver);
      const seen = (await s.query<{ employee_id: string }>("select employee_id from public.employee_work_schedules")).rows.map((r) => r.employee_id);
      expect(seen).toEqual([emp]); // own schedule only (drivers do not have employees.view)
      expect((await s.query("update public.employee_work_schedules set mon_hours = 1 where employee_id = $1", [emp])).rowCount).toBe(0);
      expect((await pgError(s.query("insert into public.employee_work_schedules (employee_id, tue_hours) values ($1, 4)", [emp]))).code).toBe("42501");

      const B = await s.createCompany("Schedules Elsewhere (test)");
      const bOwner = await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      expect((await s.query("select 1 from public.employee_work_schedules")).rowCount).toBe(0);
      expect((await pgError(s.query("insert into public.employee_work_schedules (employee_id, company_id, mon_hours) values ($1, $2, 8)", [emp, TOP_LINE]))).code).toBe("42501");

      await s.asAdmin();
      expect((await pgError(s.query("update public.employee_work_schedules set mon_hours = 25 where employee_id = $1", [emp]))).code).toBe("23514");
    });
  });
});
