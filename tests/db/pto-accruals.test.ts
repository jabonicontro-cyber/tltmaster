import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

// PTO accruals (20261112000300; owner 2026-10-13): three company-set methods (annual grant, hours worked, per pay
// period) per bank and employment type, posted once per period (a repeated run adds nothing), capped at a maximum
// balance, waiting periods respected, and plan-year forfeiture only after the company confirms it was reviewed.
// Fictional data; every test runs in a rolled-back transaction.

afterAll(() => pool.end());

async function employee(s: Session, opts: { type?: string; hire?: string | null; userId?: string | null } = {}) {
  await s.asAdmin();
  return (await s.query<{ id: string }>(
    "insert into public.employees (company_id, user_id, full_name, employment_type, hire_date) values ('00000000-0000-4000-8000-000000000001', $1, 'Accrual Person', $2, $3) returning id",
    [opts.userId ?? null, opts.type ?? "full_time", opts.hire === undefined ? null : opts.hire],
  )).rows[0].id;
}
const json = <T>(s: Session, sql: string, p: unknown[]) => s.query<{ r: T }>(sql, p).then((r) => r.rows[0].r);
const bank = (s: Session, p: Record<string, unknown> = {}) =>
  json<{ id: string }>(s, "select public.pto_bank_save($1::jsonb) as r", [JSON.stringify({ name: `Accrual bank ${Math.random().toString(36).slice(2, 6)}`, categories: ["bereavement"], employment_types: ["full_time", "part_time"], ...p })]).then((r) => r.id);
const policy = (s: Session, p: Record<string, unknown>) => json<{ id: string }>(s, "select public.pto_policy_save($1::jsonb) as r", [JSON.stringify(p)]).then((r) => r.id);
const run = (s: Session, through: string) => json<{ entries: number; hours: number; forfeitures: number }>(s, "select public.pto_run_accruals($1) as r", [through]);
const entries = (s: Session, emp: string) =>
  s.query<{ kind: string; hours: string; effective_on: string; period_key: string | null }>(
    "select kind, hours::text, effective_on::text, period_key from public.pto_ledger where employee_id = $1 order by effective_on, created_at", [emp]).then((r) => r.rows);

describe("PTO accruals", () => {
  it("annual grant: once per year on the set date, from the hire date; a second run adds nothing", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const year = Number(today.slice(0, 4));
      const emp = await employee(s, { hire: `${year - 2}-06-15` });
      await s.as(owner);
      const b = await bank(s);
      await policy(s, { bank_id: b, employment_type: "full_time", method: "annual_grant", amount: 40, grant_month: 1, grant_day: 1, effective_from: `${year - 2}-01-01` });
      const first = await run(s, today);
      // Jan 1 of the year after hire, and of this year (the hire-year grant date was before the hire date).
      expect((await entries(s, emp)).filter((e) => e.kind === "accrual").map((e) => e.effective_on)).toEqual([`${year - 1}-01-01`, `${year}-01-01`]);
      expect(first.entries).toBeGreaterThanOrEqual(2);
      const again = await run(s, today);
      expect(again.entries).toBe(0);
      expect((await entries(s, emp)).length).toBe(2);
    });
  });

  it("hours worked: amount per hours worked from entered hours, rounded to 0.01 h; capped at the maximum balance", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const emp = await employee(s, { type: "part_time", hire: addDays(today, -400) });
      await s.as(owner);
      const b = await bank(s);
      await policy(s, { bank_id: b, employment_type: "part_time", method: "hours_worked", amount: 1, per_hours: 30, max_balance: 4, effective_from: addDays(today, -60) });
      await json(s, "select public.pto_record_hours($1::jsonb) as r", [JSON.stringify({ employee_id: emp, period_start: addDays(today, -30), period_end: addDays(today, -17), hours: 65 })]);
      await json(s, "select public.pto_record_hours($1::jsonb) as r", [JSON.stringify({ employee_id: emp, period_start: addDays(today, -16), period_end: addDays(today, -3), hours: 70 })]);
      await run(s, today);
      // 65 / 30 = 2.17 h; the next 70 / 30 = 2.33 h is capped at the 4 h maximum → 1.83 h.
      expect((await entries(s, emp)).map((e) => e.hours)).toEqual(["2.17", "1.83"]);
      expect((await run(s, today)).entries).toBe(0);
      // Hours for a period that has not ended are refused; hours are append-only.
      expect((await pgError(json(s, "select public.pto_record_hours($1::jsonb) as r", [JSON.stringify({ employee_id: emp, period_start: today, period_end: addDays(today, 5), hours: 10 })]))).message).toMatch(/periods that have ended/);
      await s.asAdmin();
      expect((await pgError(s.query("update public.pto_hours_worked set hours = 1 where employee_id = $1", [emp]))).message).toMatch(/append-only/);
    });
  });

  it("per pay period: each ended period once, only while eligible (waiting period from the hire date)", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const emp = await employee(s, { hire: addDays(today, -35) });
      const noHire = await employee(s, { hire: null });
      await s.as(owner);
      const b = await bank(s, { waiting_days: 14 });
      await policy(s, { bank_id: b, employment_type: "full_time", method: "per_pay_period", amount: 3.08, pay_period: "weekly", anchor_date: addDays(today, -49), effective_from: addDays(today, -49) });
      await run(s, today);
      // Eligible from hire + 14 days (today − 21): weekly periods starting on or after it that have ended.
      const got = await entries(s, emp);
      expect(got.length).toBeGreaterThanOrEqual(2);
      expect(got.every((e) => e.hours === "3.08" && e.period_key?.startsWith("period:"))).toBe(true);
      expect(got.every((e) => e.effective_on >= addDays(today, -21))).toBe(true);
      // No hire date with a waiting period: nothing is posted (the balances page names the missing date).
      expect(await entries(s, noHire)).toEqual([]);
    });
  });

  it("forfeiture needs a reviewed rule; at the plan-year start hours above the carryover cap are forfeited once", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const year = Number(today.slice(0, 4));
      const emp = await employee(s, { hire: `${year - 3}-01-01` });
      await s.as(owner);
      const b = await bank(s);
      expect((await pgError(policy(s, { bank_id: b, employment_type: "full_time", method: "annual_grant", amount: 40, grant_month: 2, grant_day: 1, carryover_cap: 16, effective_from: `${year - 1}-01-01` }))).message).toMatch(/not allowed everywhere/);
      await policy(s, { bank_id: b, employment_type: "full_time", method: "annual_grant", amount: 40, grant_month: 2, grant_day: 1, carryover_cap: 16, forfeiture_reviewed: true, effective_from: `${year - 1}-01-01` });
      await run(s, today);
      const got = await entries(s, emp);
      // 40 h granted Feb 1 last year; at Jan 1 this year 24 h above the 16 h cap are forfeited.
      expect(got.find((e) => e.kind === "forfeiture")).toMatchObject({ hours: "-24.00", effective_on: `${year}-01-01`, period_key: `yearend:${year}` });
      expect((await run(s, today)).forfeitures).toBe(0);
    });
  });

  it("only time_off.balances sets policies, records hours and runs accruals; employees see their own entries", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const worker = await s.createUser("driver");
      const emp = await employee(s, { userId: worker, hire: addDays(today, -400) });
      await s.as(owner);
      const b = await bank(s);
      await s.as(office);
      expect((await pgError(policy(s, { bank_id: b, employment_type: "full_time", method: "annual_grant", amount: 8, grant_month: 1, grant_day: 1 }))).code).toBe("42501");
      expect((await pgError(run(s, today))).code).toBe("42501");
      expect((await pgError(json(s, "select public.pto_record_hours($1::jsonb) as r", [JSON.stringify({ employee_id: emp, period_start: addDays(today, -7), period_end: addDays(today, -1), hours: 40 })]))).code).toBe("42501");
      await s.as(owner);
      await json(s, "select public.pto_record_hours($1::jsonb) as r", [JSON.stringify({ employee_id: emp, period_start: addDays(today, -7), period_end: addDays(today, -1), hours: 40 })]);
      await s.as(worker);
      expect((await s.query("select hours::text from public.pto_hours_worked")).rows.map((r) => r.hours)).toEqual(["40.00"]);
      await s.as(office);
      expect((await s.query("select 1 from public.pto_hours_worked")).rowCount).toBe(0);
    });
  });
});
