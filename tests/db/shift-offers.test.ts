// Shift offers (B102, migration 20261120004700): the company chooses how an offered shift is filled — people ask and a
// planner approves; the first to accept gets it; or offered to chosen people, first to accept, a planner confirms.
// Qualification, an existing shift and approved time off are checked when a person answers and again before the shift
// is written. Other companies see nothing.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Mine = { id: string; my_status: string | null; problem: string | null; offer_status: string };

async function person(s: Session, company: string, name: string, driver: boolean) {
  const user = await s.createUser(driver ? "driver" : "office", { companyId: company });
  await s.asAdmin();
  const d = driver ? (await s.query<{ id: string }>("insert into public.drivers (company_id, name, user_id) values ($1, $2, $3) returning id", [company, name, user])).rows[0].id : null;
  const e = (await s.query<{ id: string }>("insert into public.employees (company_id, full_name, department, user_id, driver_id) values ($1, $2, 'operations', $3, $4) returning id", [company, name, user, d])).rows[0].id;
  return { user, employee: e };
}

describe("shift offers", () => {
  it("fills offered shifts in each of the three company modes, with the checks", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany("Shift Offer Co (test)");
      const owner = await s.createUser("owner", { companyId: company });
      const dispatcher = await s.createUser("dispatcher", { companyId: company });
      const a = await person(s, company, "Ada Driver", true);
      const b = await person(s, company, "Ben Driver", true);
      const clerk = await person(s, company, "Cleo Office", false);
      await s.asAdmin();
      const today = (await s.query<{ d: string }>("select private.company_today($1)::text d", [company])).rows[0].d;
      const day = (n: number) => `('${today}'::date + ${n})`;
      const create = async (n: number, targets: string[] | null = null) =>
        (await s.query<{ r: string }>(`select public.shift_offer_create(${day(n)}, '06:00', '14:30', 30, 'drivers', 'Extra hauls', $1::uuid[]) r`, [targets])).rows[0].r;
      const mine = async (who: string) => { await s.as(who); return (await s.query<Mine>("select id, my_status, problem, offer_status from public.my_shift_offers()")).rows; };

      // (a) People ask, a planner approves. The default mode.
      await s.as(dispatcher);
      const o1 = await create(1);
      expect((await mine(a.user)).map((r) => r.id)).toContain(o1);
      expect(await mine(clerk.user)).toEqual([]); // not a driver
      await s.as(a.user);
      expect((await s.query<{ r: string }>("select public.shift_offer_respond($1) r", [o1])).rows[0].r).toBe("requested");
      expect((await pgError(s.query("select public.shift_offer_respond($1)", [o1]))).message).toMatch(/already answered/);
      await s.as(b.user);
      await s.query("select public.shift_offer_respond($1)", [o1]);
      await s.as(clerk.user);
      expect((await pgError(s.query("select public.shift_offer_respond($1)", [o1]))).message).toMatch(/for drivers/);
      // Planners were told (in-app only).
      await s.asAdmin();
      expect(Number((await s.query<{ n: string }>("select count(*) n from public.comm_notifications where user_id = $1 and category = 'schedule'", [owner])).rows[0].n)).toBeGreaterThanOrEqual(2);
      // A driver cannot decide; the dispatcher approves Ben.
      await s.as(dispatcher);
      const ben = (await s.query<{ id: string }>("select id from public.shift_offer_responses where offer_id = $1 and employee_id = $2", [o1, b.employee])).rows[0].id;
      await s.as(a.user);
      expect((await pgError(s.query("select public.shift_offer_decide($1, true)", [ben]))).code).toBe("42501");
      await s.as(dispatcher);
      await s.query("select public.shift_offer_decide($1, true)", [ben]);
      const shift = (await s.query<{ kind: string; reason: string }>(`select kind, reason from public.shift_changes where employee_id = $1 and work_date = ${day(1)}`, [b.employee])).rows;
      expect(shift).toEqual([{ kind: "shift", reason: "Shift offer" }]);
      const answers = (await s.query<{ employee_id: string; status: string }>("select employee_id, status from public.shift_offer_responses where offer_id = $1 order by status", [o1])).rows;
      expect(answers).toEqual([{ employee_id: b.employee, status: "approved" }, { employee_id: a.employee, status: "not_chosen" }]);
      expect((await pgError(s.query("select public.shift_offer_decide($1, true)", [ben]))).message).toMatch(/already been decided/);

      // (b) First to accept gets it. Only an owner (settings.manage) changes the mode.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.shift_offer_set_mode('first_accept')"))).code).toBe("42501");
      await s.as(owner);
      await s.query("select public.shift_offer_set_mode('first_accept')");
      const o2 = await create(2);
      await s.as(a.user);
      expect((await s.query<{ r: string }>("select public.shift_offer_respond($1) r", [o2])).rows[0].r).toBe("approved");
      await s.as(b.user);
      expect((await pgError(s.query("select public.shift_offer_respond($1)", [o2]))).message).toMatch(/no longer available/);
      // Ada now works that day: a second offer that day is not shown to her and is refused.
      await s.as(owner);
      const o3 = await create(2);
      expect((await mine(a.user)).map((r) => r.id)).not.toContain(o3);
      expect((await pgError(s.query("select public.shift_offer_respond($1)", [o3]))).message).toMatch(/Already works that day/);
      // Approved time off blocks too.
      await s.asAdmin();
      await s.query(`insert into public.time_off_requests (company_id, employee_id, category, start_date, end_date, status) values ($1, $2, 'vacation', ${day(3)}, ${day(3)}, 'approved')`, [company, b.employee]);
      await s.as(owner);
      const o4 = await create(3);
      await s.as(b.user);
      expect((await pgError(s.query("select public.shift_offer_respond($1)", [o4]))).message).toMatch(/approved time off/);
      // A planner withdraws an offer nobody needs.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.shift_offer_cancel($1, ' ')", [o4]))).message).toMatch(/reason/);
      await s.query("select public.shift_offer_cancel($1, 'Pour moved')", [o4]);

      // (c) Offered to chosen people; first to accept holds it; a planner confirms.
      await s.as(owner);
      await s.query("select public.shift_offer_set_mode('offer')");
      expect((await pgError(s.query(`select public.shift_offer_create(${day(4)}, '06:00', '14:30', 0, 'drivers', '', null)`))).message).toMatch(/Choose the people/);
      expect((await pgError(create(2, [a.employee]))).message).toMatch(/Ada Driver: Already works that day/);
      const o5 = await create(4, [a.employee, b.employee]);
      await s.as(b.user);
      expect((await s.query<{ r: string }>("select public.shift_offer_respond($1) r", [o5])).rows[0].r).toBe("accepted");
      await s.as(a.user);
      expect((await pgError(s.query("select public.shift_offer_respond($1)", [o5]))).message).toMatch(/Someone else accepted/);
      // Ben withdraws: the offer is open again; Ada accepts; the dispatcher confirms.
      await s.as(b.user);
      await s.query("select public.shift_offer_withdraw($1)", [o5]);
      await s.as(a.user);
      await s.query("select public.shift_offer_respond($1)", [o5]);
      await s.as(dispatcher);
      const ada = (await s.query<{ id: string }>("select id from public.shift_offer_responses where offer_id = $1 and employee_id = $2", [o5, a.employee])).rows[0].id;
      await s.query("select public.shift_offer_decide($1, true)", [ada]);
      expect((await s.query<{ status: string }>("select status from public.shift_offers where id = $1", [o5])).rows[0].status).toBe("filled");

      // Another company sees and decides nothing; demo samples are refused for a real company.
      const other = await s.createCompany("Other Shift Co (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select id from public.shift_offers")).rowCount).toBe(0);
      expect((await pgError(s.query("select public.shift_offer_decide($1, true)", [ada]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.shift_offer_respond($1)", [o5]))).code).toBe("42501"); // not linked to a person there
      expect((await pgError(s.query("select public.demo_shift_offer_samples()"))).code).toBe("42501");
    });
  });
});
