import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { ELIGIBILITY_MESSAGES } from "@/lib/fleet/eligibility";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

/** An employee record linked to a login (and, for drivers, to a driver record). */
async function employee(s: Session, userId: string, driverId: string | null = null, companyId = TOP_LINE) {
  await s.asAdmin();
  return (await s.query<{ id: string }>("insert into public.employees (company_id, user_id, driver_id, full_name) values ($1, $2, $3, 'Test Person') returning id", [companyId, userId, driverId])).rows[0].id;
}

const save = (s: Session, p: Record<string, unknown>) =>
  s.query<{ r: { id: string; duplicate: boolean } }>("select public.time_off_save($1::jsonb) as r", [JSON.stringify(p)]).then((r) => r.rows[0].r);
const decide = (s: Session, id: string, d: string, note = "") =>
  s.query<{ r: { status: string; conflicts: Array<{ assignment_id: string }> } }>("select public.time_off_decide($1, $2, $3) as r", [id, d, note]).then((r) => r.rows[0].r);

describe("time-off requests", () => {
  it("an employee requests time off; an approver decides; history is kept; double submits create one request", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const driverUser = await s.createUser("driver");
      await employee(s, driverUser);
      await s.as(driverUser);
      const key = crypto.randomUUID();
      const a = await save(s, { category: "vacation", start_date: addDays(today, 10), end_date: addDays(today, 12), reason: "Family trip", submission_key: key });
      expect((await save(s, { category: "vacation", start_date: addDays(today, 10), end_date: addDays(today, 12), submission_key: key })).id).toBe(a.id);
      // Overlapping another pending request is refused.
      expect((await pgError(save(s, { category: "personal", start_date: addDays(today, 12), end_date: addDays(today, 13) }))).message).toMatch(/overlaps another request/);
      // Employees cannot decide requests.
      expect((await pgError(decide(s, a.id, "approved"))).code).toBe("42501");

      await s.as(owner);
      expect((await decide(s, a.id, "approved", "Enjoy")).status).toBe("approved");
      expect((await pgError(decide(s, a.id, "denied"))).message).toMatch(/already approved/);
      const events = await s.query<{ kind: string }>("select kind from public.time_off_events where request_id = $1 order by created_at", [a.id]);
      expect(events.rows.map((e) => e.kind)).toEqual(["submitted", "approved"]);

      // The employee may cancel approved leave that has not started; it then frees the dates.
      await s.as(driverUser);
      await s.query("select public.time_off_cancel($1, 'Plans changed')", [a.id]);
      const b = await save(s, { category: "personal", start_date: addDays(today, 12), end_date: addDays(today, 13) });
      expect(b.duplicate).toBe(false);
    });
  });

  it("nobody decides their own request, and partial days need a valid time range on one date", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      await employee(s, owner);
      await s.as(owner);
      const mine = await save(s, { category: "personal", start_date: addDays(today, 3), end_date: addDays(today, 3) });
      expect((await pgError(decide(s, mine.id, "approved"))).message).toMatch(/cannot decide your own/);
      expect((await pgError(save(s, { category: "sick", start_date: addDays(today, 4), end_date: addDays(today, 5), full_day: false, start_time: "08:00", end_time: "12:00" }))).message).toMatch(/single date/);
      expect((await pgError(save(s, { category: "sick", start_date: addDays(today, 4), full_day: false, start_time: "12:00", end_time: "08:00" }))).message).toMatch(/end after start/);
      const p = await save(s, { category: "sick", start_date: addDays(today, 4), full_day: false, start_time: "08:00", end_time: "11:30" });
      expect((await s.query("select hours::text from public.time_off_requests where id = $1", [p.id])).rows[0].hours).toBe("3.50");
    });
  });

  it("requests are private to the employee and people with time_off.view; other companies see nothing", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const a = await s.createUser("driver");
      const b = await s.createUser("driver");
      const dispatcher = await s.createUser("dispatcher");
      const empA = await employee(s, a);
      await employee(s, b);
      await s.as(a);
      const r = await save(s, { category: "sick", start_date: addDays(today, 2), end_date: addDays(today, 2), reason: "Doctor" });
      await s.as(b);
      expect((await s.query("select id from public.time_off_requests where id = $1", [r.id])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.time_off_cancel($1)", [r.id]))).code).toBe("42501");
      // Entering time off for someone else needs time_off.approve.
      expect((await pgError(save(s, { employee_id: empA, category: "vacation", start_date: addDays(today, 20), end_date: addDays(today, 20) }))).code).toBe("42501");
      await s.as(dispatcher);
      expect((await s.query("select id from public.time_off_requests where id = $1", [r.id])).rowCount).toBe(1);
      expect((await pgError(decide(s, r.id, "approved"))).code).toBe("42501"); // view is not approve
      const other = await s.createCompany(`Other ${Math.random().toString(36).slice(2, 6)}`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select id from public.time_off_requests where id = $1", [r.id])).rowCount).toBe(0);
      expect((await pgError(decide(s, r.id, "approved"))).code).toBe("P0002");
    });
  });
});

describe("time off and dispatch", () => {
  async function setup(s: Session) {
    const today = await businessToday(s);
    const day = addDays(today, 3);
    const owner = await s.createUser("owner");
    const dispatcher = await s.createUser("dispatcher");
    const f = await fleet(s, owner, day);
    const order = await scheduledOrder(s, owner, today, addDays(today, 6));
    const morning = await planLoad(s, order.id, day, "09:00", "10:00");
    const afternoon = await planLoad(s, order.id, day, "13:00", "14:00");
    const emp = await employee(s, (await s.createUser("driver")), f.d1);
    await s.as(owner);
    return { today, day, owner, dispatcher, f, morning, afternoon, emp };
  }

  it("approved full-day leave blocks assignment at that moment; pending, denied and canceled do not", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      const req = await save(s, { employee_id: w.emp, category: "vacation", start_date: w.day, end_date: w.day });
      // Pending: a warning only.
      const elig = await s.query<{ r: { blockers: string[]; warnings: string[] } }>("select public.check_assignment_eligibility(null, null, $1, $2) as r", [w.f.d1, w.day]);
      expect(elig.rows[0].r.warnings).toContain("driver_time_off_pending");
      expect(elig.rows[0].r.blockers).toEqual([]);
      await decide(s, req.id, "approved");
      await s.as(w.dispatcher);
      expect((await pgError(assign(s, w.morning.load_id, w.f.t1, null, w.f.d1))).message).toMatch(/approved time off|time off/);
      await s.as(w.owner);
      await s.query("select public.time_off_cancel($1, 'Back early')", [req.id]);
      await s.as(w.dispatcher);
      expect(await assign(s, w.morning.load_id, w.f.t1, null, w.f.d1)).toBeTruthy();

      await s.as(w.owner);
      const denied = await save(s, { employee_id: w.emp, category: "personal", start_date: w.day, end_date: w.day });
      await decide(s, denied.id, "denied", "Busy week");
      await s.as(w.dispatcher);
      expect(await assign(s, w.afternoon.load_id, w.f.t2, null, w.f.d1)).toBeTruthy();
    });
  });

  it("partial-day leave blocks only overlapping loads, using the load's times", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      const req = await save(s, { employee_id: w.emp, category: "personal", start_date: w.day, full_day: false, start_time: "08:00", end_time: "12:00" });
      await decide(s, req.id, "approved");
      await s.as(w.dispatcher);
      expect((await pgError(assign(s, w.morning.load_id, w.f.t1, null, w.f.d1))).message).toMatch(/partial|overlaps this load/);
      expect(await assign(s, w.afternoon.load_id, w.f.t1, null, w.f.d1)).toBeTruthy();
      const elig = await s.query<{ r: { blockers: string[]; warnings: string[] } }>("select public.check_assignment_eligibility(null, null, $1, $2) as r", [w.f.d1, w.day]);
      expect(elig.rows[0].r.warnings).toContain("driver_partial_time_off");
    });
  });

  it("approving leave over existing assignments flags them for review and never cancels them", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.dispatcher);
      const asg = await assign(s, w.morning.load_id, w.f.t1, null, w.f.d1);
      await s.as(w.owner);
      const req = await save(s, { employee_id: w.emp, category: "sick", start_date: w.day, end_date: w.day });
      const r = await decide(s, req.id, "approved");
      expect(r.conflicts.map((c) => c.assignment_id)).toEqual([asg]);
      expect((await s.query("select status from public.dispatch_assignments where id = $1", [asg])).rows[0].status).toBe("active");
      // The Command Center's check now reports the assignment as a problem.
      const elig = await s.query<{ r: { blockers: string[] } }>("select public.check_assignment_eligibility($1, null, $2, $3) as r", [w.f.t1, w.f.d1, w.day]);
      expect(elig.rows[0].r.blockers).toContain("driver_time_off");
      expect(ELIGIBILITY_MESSAGES.driver_time_off).toBeTruthy();
    });
  });

  it("dispatch sees absences without the category or reason", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await save(s, { employee_id: w.emp, category: "sick", start_date: w.day, end_date: w.day, reason: "Private reason" });
      await s.as(w.dispatcher);
      const rows = (await s.query<{ r: Array<Record<string, unknown>> }>("select public.dispatch_time_off($1, $2) as r", [w.today, addDays(w.today, 7)])).rows[0].r;
      const mine = rows.filter((x) => x.driver_id === w.f.d1);
      expect(mine).toHaveLength(1);
      expect(JSON.stringify(mine)).not.toMatch(/sick|Private reason/);
      expect(mine[0].status).toBe("pending");
    });
  });
});
