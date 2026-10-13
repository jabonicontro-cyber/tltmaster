import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

// PTO banks and balances (migration 20261112000100): banks per company (separate or combined categories, eligible
// employment types, waiting period), an append-only ledger (grants, adjustments with a reason, usage on approval,
// reversal on cancel), requests refused beyond the available balance, and balances private to the employee and
// people with time_off.balances. Fictional data; every test runs in a rolled-back transaction.

afterAll(() => pool.end());

async function employee(s: Session, userId: string | null, opts: { type?: string; hire?: string | null; companyId?: string } = {}) {
  await s.asAdmin();
  const company = opts.companyId ?? "00000000-0000-4000-8000-000000000001";
  return (await s.query<{ id: string }>(
    "insert into public.employees (company_id, user_id, full_name, employment_type, hire_date) values ($1, $2, 'Test Person', $3, $4) returning id",
    [company, userId, opts.type ?? "full_time", opts.hire === undefined ? null : opts.hire],
  )).rows[0].id;
}
const json = <T>(s: Session, sql: string, p: unknown[]) => s.query<{ r: T }>(sql, p).then((r) => r.rows[0].r);
const bankSave = (s: Session, p: Record<string, unknown>) => json<{ id: string }>(s, "select public.pto_bank_save($1::jsonb) as r", [JSON.stringify(p)]);
const adjust = (s: Session, p: Record<string, unknown>) => json<{ id: string; duplicate: boolean; balance: string | null }>(s, "select public.pto_adjust($1::jsonb) as r", [JSON.stringify(p)]);
const save = (s: Session, p: Record<string, unknown>) => json<{ id: string }>(s, "select public.time_off_save($1::jsonb) as r", [JSON.stringify(p)]);
const decide = (s: Session, id: string, d: string) => s.query("select public.time_off_decide($1, $2, '')", [id, d]);
const balances = (s: Session, emp: string | null = null) =>
  json<Array<{ bank_id: string; name: string; balance: number; pending: number; available: number; eligible: boolean; usable_from: string | null; hire_date_missing: boolean }>>(
    s, "select public.pto_balances($1) as r", [emp]);
const ledger = (s: Session, emp: string) =>
  s.query<{ kind: string; hours: string }>("select kind, hours::text from public.pto_ledger where employee_id = $1 order by created_at", [emp]).then((r) => r.rows);

describe("PTO banks and balances", () => {
  it("banks are set up with time_off.balances; a category draws from one bank only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(bankSave(s, { name: "Paid time off", categories: ["vacation"], employment_types: ["full_time"] }))).code).toBe("42501");
      await s.as(owner);
      const combined = await bankSave(s, { name: "Paid time off", categories: ["vacation", "personal"], employment_types: ["full_time"], waiting_days: 0 });
      expect((await pgError(bankSave(s, { name: "Vacation", categories: ["vacation"], employment_types: ["full_time"] }))).message).toMatch(/one bank only; Paid time off/);
      expect((await pgError(bankSave(s, { name: "Sick", categories: [], employment_types: ["full_time"] }))).message).toMatch(/at least one kind/);
      expect((await pgError(bankSave(s, { name: "Sick", categories: ["sick"], employment_types: [] }))).message).toMatch(/employment types/);
      const sick = await bankSave(s, { name: "Sick leave", categories: ["sick"], employment_types: ["full_time", "part_time"] });
      expect(sick.id).not.toBe(combined.id);
      // Everyone in the company can read the bank definitions (the request form needs them).
      await s.as(dispatcher);
      expect((await s.query("select name from public.pto_banks order by name")).rows.map((r) => r.name)).toEqual(["Paid time off", "Sick leave"]);
    });
  });

  it("requests on a bank need known hours within the available balance; approval uses them and canceling gives them back", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const user = await s.createUser("driver");
      const emp = await employee(s, user);
      await s.as(owner);
      const bank = (await bankSave(s, { name: "Paid time off", categories: ["vacation", "personal"], employment_types: ["full_time"] })).id;

      await s.as(user);
      expect((await pgError(save(s, { category: "vacation", start_date: addDays(today, 10), end_date: addDays(today, 10) }))).message).toMatch(/Enter how many hours of Paid time off/);
      expect((await pgError(save(s, { category: "vacation", start_date: addDays(today, 10), end_date: addDays(today, 10), hours: 8 }))).message)
        .toMatch(/uses 8 h of Paid time off, but only 0 h are available/);
      // A category without a bank works as before (no balance check).
      expect((await save(s, { category: "sick", start_date: addDays(today, 3), end_date: addDays(today, 3) })).id).toBeTruthy();

      await s.as(owner);
      expect((await adjust(s, { employee_id: emp, bank_id: bank, kind: "grant", hours: 16, note: "Annual grant" })).balance).toBe(16);
      await s.as(user);
      const first = await save(s, { category: "vacation", start_date: addDays(today, 10), end_date: addDays(today, 10), hours: 8 });
      // The pending 8 h are reserved: a second request for 10 h does not fit the remaining 8 h.
      expect((await pgError(save(s, { category: "personal", start_date: addDays(today, 20), end_date: addDays(today, 21), hours: 10 }))).message)
        .toMatch(/only 8 h are available \(balance 16 h, other pending requests 8 h\)/);
      expect((await balances(s))[0]).toMatchObject({ name: "Paid time off", balance: 16, pending: 8, available: 8, eligible: true });

      await s.as(owner);
      await decide(s, first.id, "approved");
      expect(await ledger(s, emp)).toEqual([{ kind: "grant", hours: "16.00" }, { kind: "usage", hours: "-8.00" }]);
      await s.query("select public.time_off_cancel($1, 'Plans changed')", [first.id]);
      await s.query("select public.time_off_cancel($1, 'Again')", [first.id]).catch(() => undefined);
      expect(await ledger(s, emp)).toEqual([{ kind: "grant", hours: "16.00" }, { kind: "usage", hours: "-8.00" }, { kind: "usage_reversal", hours: "8.00" }]);
      expect((await balances(s, emp))[0]).toMatchObject({ balance: 16, pending: 0, available: 16 });
    });
  });

  it("approval re-checks the balance at that moment", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const user = await s.createUser("driver");
      const emp = await employee(s, user);
      await s.as(owner);
      const bank = (await bankSave(s, { name: "Paid time off", categories: ["vacation"], employment_types: ["full_time"] })).id;
      await adjust(s, { employee_id: emp, bank_id: bank, kind: "grant", hours: 8 });
      await s.as(user);
      const r = await save(s, { category: "vacation", start_date: addDays(today, 5), end_date: addDays(today, 5), hours: 8 });
      await s.as(owner);
      await adjust(s, { employee_id: emp, bank_id: bank, kind: "adjustment", hours: -4, note: "Correction of an entry error" });
      expect((await pgError(decide(s, r.id, "approved"))).message).toMatch(/Approving uses 8 h of Paid time off, but the balance is 4 h/);
      expect((await s.query("select status from public.time_off_requests where id = $1", [r.id])).rows[0].status).toBe("pending");
      // Denying needs no balance.
      await decide(s, r.id, "denied");
    });
  });

  it("eligibility: employment type, waiting period from the hire date, and a missing hire date", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const partTimer = await s.createUser("driver");
      const recent = await s.createUser("driver");
      const unknown = await s.createUser("driver");
      const ptEmp = await employee(s, partTimer, { type: "part_time" });
      const recentEmp = await employee(s, recent, { hire: addDays(today, -10) });
      const unknownEmp = await employee(s, unknown, { hire: null });
      await s.as(owner);
      const bank = (await bankSave(s, { name: "Paid time off", categories: ["vacation"], employment_types: ["full_time"], waiting_days: 90 })).id;
      expect((await pgError(adjust(s, { employee_id: ptEmp, bank_id: bank, kind: "grant", hours: 8 }))).message).toMatch(/not available to part-time employees/);
      await adjust(s, { employee_id: recentEmp, bank_id: bank, kind: "grant", hours: 40 });
      await adjust(s, { employee_id: unknownEmp, bank_id: bank, kind: "grant", hours: 40 });

      await s.as(partTimer);
      expect((await pgError(save(s, { category: "vacation", start_date: addDays(today, 5), end_date: addDays(today, 5), hours: 4 }))).message).toMatch(/not available to part-time employees/);
      expect(await balances(s)).toEqual([]); // not eligible and no hours: nothing to show
      await s.as(recent);
      expect((await pgError(save(s, { category: "vacation", start_date: addDays(today, 5), end_date: addDays(today, 5), hours: 8 }))).message).toMatch(/can be used from .* \(90 days after the hire date\)/);
      expect((await save(s, { category: "vacation", start_date: addDays(today, 85), end_date: addDays(today, 85), hours: 8 })).id).toBeTruthy();
      expect((await balances(s))[0].usable_from).toBe(addDays(today, 80));
      await s.as(unknown);
      expect((await pgError(save(s, { category: "vacation", start_date: addDays(today, 100), end_date: addDays(today, 100), hours: 8 }))).message).toMatch(/no hire date is recorded/);
      expect((await balances(s))[0].hire_date_missing).toBe(true);
    });
  });

  it("the ledger is append-only; adjustments need a reason and never go below zero; a repeated submission adds nothing", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const emp = await employee(s, null);
      await s.as(owner);
      const bank = (await bankSave(s, { name: "Paid time off", categories: ["vacation"], employment_types: ["full_time"] })).id;
      const key = crypto.randomUUID();
      const g = await adjust(s, { employee_id: emp, bank_id: bank, kind: "grant", hours: 24, note: "Annual grant", submission_key: key });
      const again = await adjust(s, { employee_id: emp, bank_id: bank, kind: "grant", hours: 24, note: "Annual grant", submission_key: key });
      expect(again).toMatchObject({ id: g.id, duplicate: true });
      expect((await ledger(s, emp)).length).toBe(1);
      expect((await pgError(adjust(s, { employee_id: emp, bank_id: bank, kind: "adjustment", hours: -2, note: "" }))).message).toMatch(/Say why/);
      expect((await pgError(adjust(s, { employee_id: emp, bank_id: bank, kind: "adjustment", hours: -30, note: "Too much" }))).message).toMatch(/below zero \(balance 24/);
      expect((await pgError(adjust(s, { employee_id: emp, bank_id: bank, kind: "grant", hours: -5 }))).message).toMatch(/use an adjustment/);
      expect((await pgError(adjust(s, { employee_id: emp, bank_id: bank, kind: "grant", hours: 5, effective_on: addDays(today, 3) }))).message).toMatch(/future/);
      // Nobody edits or deletes history, not even the owner (functions are the only writers; the table is append-only).
      expect((await pgError(s.query("update public.pto_ledger set hours = 99 where id = $1", [g.id]))).code).toBe("42501");
      await s.asAdmin();
      expect((await pgError(s.query("update public.pto_ledger set hours = 99 where id = $1", [g.id]))).message).toMatch(/append-only/);
      expect((await pgError(s.query("delete from public.pto_ledger where id = $1", [g.id]))).message).toMatch(/append-only/);
    });
  });

  it("balances are private: the employee and time_off.balances only; other companies see nothing", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const a = await s.createUser("driver");
      const b = await s.createUser("driver");
      const empA = await employee(s, a);
      const empB = await employee(s, b);
      await s.as(owner);
      const bank = (await bankSave(s, { name: "Paid time off", categories: ["vacation"], employment_types: ["full_time"] })).id;
      await adjust(s, { employee_id: empA, bank_id: bank, kind: "grant", hours: 12 });
      await adjust(s, { employee_id: empB, bank_id: bank, kind: "grant", hours: 20 });
      const overview = await json<Array<{ employee_id: string; balance: number }>>(s, "select public.pto_balance_overview() as r", []);
      expect(overview.find((r) => r.employee_id === empA)?.balance).toBe(12);

      await s.as(a);
      expect((await balances(s))[0].balance).toBe(12);
      expect((await s.query("select employee_id from public.pto_ledger")).rows.map((r) => r.employee_id)).toEqual([empA]);
      expect((await pgError(balances(s, empB))).code).toBe("42501");
      expect((await pgError(s.query("select public.pto_balance_overview()"))).code).toBe("42501");
      // time_off.view (office) sees requests, not balances.
      await s.as(office);
      expect((await s.query("select 1 from public.pto_ledger")).rowCount).toBe(0);
      expect((await pgError(s.query("select public.pto_balance_overview()"))).code).toBe("42501");
      expect((await pgError(adjust(s, { employee_id: empA, bank_id: bank, kind: "grant", hours: 1 }))).code).toBe("42501");

      const other = await s.createCompany("Brookside Aggregates");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select 1 from public.pto_ledger")).rowCount).toBe(0);
      expect((await s.query("select 1 from public.pto_banks")).rowCount).toBe(0);
      expect((await pgError(adjust(s, { employee_id: empA, bank_id: bank, kind: "grant", hours: 1 }))).message).toMatch(/not found/);
    });
  });
});
