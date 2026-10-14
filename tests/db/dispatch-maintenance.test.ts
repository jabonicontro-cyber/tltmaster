import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { ELIGIBILITY_MESSAGES } from "@/lib/fleet/eligibility";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

// Dispatch reads the maintenance workspace: shop visits on the load date and
// safety restrictions block assignments at the moment of assignment.

async function setup(s: Session) {
  const today = await businessToday(s);
  const day = addDays(today, 2);
  const owner = await s.createUser("owner");
  const dispatcher = await s.createUser("dispatcher");
  const f = await fleet(s, owner, day);
  const order = await scheduledOrder(s, owner, today, addDays(today, 5));
  const load = await planLoad(s, order.id, day, "08:00", "10:00");
  return { today, day, owner, dispatcher, f, order, load };
}

const wo = (s: Session, p: Record<string, unknown>) =>
  s.query<{ r: { id: string; number: string } }>("select public.maintenance_create_work_order($1::jsonb) as r", [JSON.stringify(p)]).then((r) => r.rows[0].r);

describe("maintenance-aware dispatch", () => {
  it("a shop visit scheduled on the load date blocks the truck; another date does not", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.owner);
      await wo(s, { truck_id: w.f.t1, title: "Annual inspection", category: "inspection", scheduled_for: w.day });
      await wo(s, { truck_id: w.f.t2, title: "Grease", category: "preventive", scheduled_for: addDays(w.day, 1) });

      await s.as(w.dispatcher);
      const err = await pgError(assign(s, w.load.load_id, w.f.t1, null, w.f.d1));
      expect(err.message).toContain(ELIGIBILITY_MESSAGES.truck_shop_scheduled);
      const id = await assign(s, w.load.load_id, w.f.t2, null, w.f.d1); // shop visit is the next day
      expect(id).toBeTruthy();
    });
  });

  it("a safety-critical work order blocks the truck even if someone tried to mark it in service", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.owner);
      await wo(s, { truck_id: w.f.t1, title: "Brake chamber cracked", safety_critical: true });
      await s.as(w.dispatcher);
      const err = await pgError(assign(s, w.load.load_id, w.f.t1, null, w.f.d1));
      expect(err.message).toContain(ELIGIBILITY_MESSAGES.truck_out_of_service);
      expect(err.message).toContain(ELIGIBILITY_MESSAGES.truck_safety_restricted);
      const elig = await s.query<{ r: { blockers: string[] } }>("select public.check_assignment_eligibility($1, null, null, $2) as r", [w.f.t1, w.day]);
      expect(elig.rows[0].r.blockers).toEqual(expect.arrayContaining(["truck_out_of_service", "truck_safety_restricted"]));
    });
  });

  it("open shop work is a warning, not a blocker; canceling the shop visit lifts the block", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.owner);
      const a = await wo(s, { truck_id: w.f.t1, title: "Mirror bracket" });
      await s.query("select public.maintenance_set_status($1, 'in_progress')", [a.id]);
      const b = await wo(s, { truck_id: w.f.t2, title: "Tarp motor", scheduled_for: w.day });
      const elig = await s.query<{ r: { blockers: string[]; warnings: string[] } }>("select public.check_assignment_eligibility($1, null, null, $2) as r", [w.f.t1, w.day]);
      expect(elig.rows[0].r.blockers).toEqual([]);
      expect(elig.rows[0].r.warnings).toContain("truck_shop_work_open");
      await s.query("select public.maintenance_set_status($1, 'canceled', 'Done at the dealer')", [b.id]);
      await s.as(w.dispatcher);
      expect(await assign(s, w.load.load_id, w.f.t2, null, w.f.d1)).toBeTruthy();
    });
  });

  it("the shop schedule is readable with dispatch.view, only for the caller's company, and without costs", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.owner);
      await wo(s, { truck_id: w.f.t1, title: "Annual inspection", scheduled_for: w.day });
      await s.as(w.dispatcher);
      const rows = (await s.query<{ r: Array<Record<string, unknown>> }>("select public.dispatch_shop_schedule($1, $2) as r", [w.today, addDays(w.today, 7)])).rows[0].r;
      const mine = rows.filter((r) => r.truck_id === w.f.t1);
      expect(mine).toHaveLength(1);
      expect(Object.keys(mine[0]).sort()).toEqual(["number", "safety_critical", "scheduled_for", "status", "title", "trailer_id", "truck_id", "work_order_id"]);
      expect((await pgError(s.query("select public.dispatch_shop_schedule($1, $2)", [w.today, addDays(w.today, 100)]))).message).toMatch(/62 days/);

      const driverUser = await s.createUser("driver");
      await s.as(driverUser);
      expect((await pgError(s.query("select public.dispatch_shop_schedule($1, $2)", [w.today, w.day]))).code).toBe("42501");

      const other = await s.createCompany(`Other ${Math.random().toString(36).slice(2, 6)}`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      const theirs = (await s.query<{ r: Array<{ truck_id: string }> }>("select public.dispatch_shop_schedule($1, $2) as r", [w.today, addDays(w.today, 7)])).rows[0].r;
      expect(theirs.some((r) => r.truck_id === w.f.t1)).toBe(false);
    });
  });
});
