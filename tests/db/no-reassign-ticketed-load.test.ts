// RL1 (owner decision 2026-11-12, "Block it"; 20261120019700): once a load has a live delivery ticket, dispatch can no
// longer change or remove its truck and driver. The office corrects or voids the ticket first. Loads without a live
// ticket are unaffected, and another company never learns about the ticket.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Submit = { ticket_id: string; ticket_number: string };

/** Yesterday's load, assigned to truck 1 and driver A, with an office person and a dispatcher. */
async function world(s: Session) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const office = await s.createUser("office");
  const dispatcher = await s.createUser("dispatcher");
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), today, addDays(today, -2));
  const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
  const assignment = await assign(s, load.load_id, f.t1, null, f.d1);
  const payload = (loadId: string) => ({
    load_id: loadId, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30",
    quantity: "21.5", unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 8)}`,
  });
  /** A ticket for the load; `another` confirms a separate delivery when the load already has one. */
  const submit = async (loadId: string, another = false) => {
    await s.as(office);
    return (await s.query<{ r: Submit }>("select public.submit_delivery_ticket($1::jsonb) as r",
      [JSON.stringify({ ...payload(loadId), ...(another ? { confirm_duplicate: true } : {}) })])).rows[0].r;
  };
  return { today, yesterday, office, dispatcher, f, order, load, assignment, payload, submit };
}

async function activeAssignment(s: Session, loadId: string) {
  await s.asAdmin();
  return (await s.query<{ id: string; truck_id: string; driver_id: string }>(
    "select id, truck_id, driver_id from public.dispatch_assignments where load_id = $1 and status = 'active'", [loadId])).rows[0] ?? null;
}

describe("a load with a live delivery ticket keeps its truck and driver", () => {
  it("refuses a reassignment, the off-shift path and removing the assignment, with the reason and the next step", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const t = await w.submit(w.load.load_id);
      await s.as(w.dispatcher);

      const e = await pgError(assign(s, w.load.load_id, w.f.t2, null, w.f.d2, w.assignment));
      expect(e.code).toBe("22023");
      expect(e.message).toBe(
        `${w.order.number} load 1 already has delivery ticket ${t.ticket_number}, so its truck and driver can no longer be changed. ` +
        "If they are wrong, correct the ticket in Tickets, or void it there and then reassign the load.");
      // Only the truck (same driver) is refused too.
      expect((await pgError(assign(s, w.load.load_id, w.f.t2, null, w.f.d1, w.assignment))).message).toMatch(/already has delivery ticket/);
      // The off-shift path goes through assign_load and is refused the same way.
      expect((await pgError(s.query("select public.assign_load_off_shift($1, $2, null, $3, '', $4, 'Extra shift')",
        [w.load.load_id, w.f.t2, w.f.d2, w.assignment]))).message).toMatch(/already has delivery ticket/);
      // Removing the truck and driver (the first half of a manual reassignment) is refused.
      const r = await pgError(s.query("select public.cancel_assignment($1, 'Wrong truck')", [w.assignment]));
      expect(r.code).toBe("22023");
      expect(r.message).toBe(
        `${w.order.number} load 1 already has delivery ticket ${t.ticket_number}, so its truck and driver can no longer be removed. ` +
        "If they are wrong, correct the ticket in Tickets, or void it there first.");

      // Nothing changed: the same assignment is still active.
      expect(await activeAssignment(s, w.load.load_id)).toEqual({ id: w.assignment, truck_id: w.f.t1, driver_id: w.f.d1 });
      const history = await s.query("select count(*)::int as n from public.dispatch_assignments where load_id = $1", [w.load.load_id]);
      expect(history.rows[0].n).toBe(1);
    });
  });

  it("counts every live ticket: a corrected ticket still blocks, several tickets are all named", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const t1 = await w.submit(w.load.load_id);
      await s.as(w.office);
      const c = await s.query<{ r: Submit }>("select public.correct_delivery_ticket($1, $2::jsonb, 'Scale reading') as r",
        [t1.ticket_id, JSON.stringify({ ...w.payload(w.load.load_id), quantity: "21.7" })]);
      expect(c.rows[0].r.ticket_number).toBe(t1.ticket_number);
      await s.as(w.dispatcher);
      // The superseded revision and its correction are one ticket, named once.
      expect((await pgError(assign(s, w.load.load_id, w.f.t2, null, w.f.d2, w.assignment))).message)
        .toContain(`already has delivery ticket ${t1.ticket_number}, so`);
      const t2 = await w.submit(w.load.load_id, true);
      await s.as(w.dispatcher);
      expect((await pgError(assign(s, w.load.load_id, w.f.t2, null, w.f.d2, w.assignment))).message)
        .toContain(`already has delivery tickets ${[t1.ticket_number, t2.ticket_number].sort().join(", ")}, so`);
    });
  });

  it("allows reassigning once the ticket is voided", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const t = await w.submit(w.load.load_id);
      await s.as(w.office);
      await s.query("select public.review_delivery_ticket($1, 'void', 'Entered on the wrong truck')", [t.ticket_id]);
      await s.as(w.dispatcher);
      const next = await assign(s, w.load.load_id, w.f.t2, null, w.f.d2, w.assignment);
      expect(await activeAssignment(s, w.load.load_id)).toEqual({ id: next, truck_id: w.f.t2, driver_id: w.f.d2 });
      await s.as(w.dispatcher);
      await s.query("select public.cancel_assignment($1, 'Not needed after all')", [next]);
      expect(await activeAssignment(s, w.load.load_id)).toBeNull();
    });
  });

  it("leaves loads without a live ticket as they were", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      // A load without tickets: assigned, reassigned and unassigned as before.
      await s.as(w.dispatcher);
      const a2 = await assign(s, w.load.load_id, w.f.t2, null, w.f.d2, w.assignment);
      expect((await activeAssignment(s, w.load.load_id))?.id).toBe(a2);
      // Its assignment removed without a ticket: it gets a new one.
      await s.as(w.dispatcher);
      await s.query("select public.cancel_assignment($1, 'Driver called in sick')", [a2]);
      const a3 = await assign(s, w.load.load_id, w.f.t1, null, w.f.d1);
      expect((await activeAssignment(s, w.load.load_id))?.id).toBe(a3);
      // Another load of the same order with a ticket does not lock this one.
      await s.as(w.office);
      const other = await planLoad(s, w.order.id, w.yesterday, "10:00", "12:00");
      await s.as(w.dispatcher);
      const oa = await assign(s, other.load_id, w.f.t2, null, w.f.d2);
      await w.submit(other.load_id);
      await s.as(w.dispatcher);
      expect((await pgError(assign(s, other.load_id, w.f.t2, null, w.f.d3, oa))).message).toMatch(/already has delivery ticket/);
      const a4 = await assign(s, w.load.load_id, w.f.t1, null, w.f.d3, a3);
      expect((await activeAssignment(s, w.load.load_id))?.driver_id).toBe(w.f.d3);
      expect((await activeAssignment(s, w.load.load_id))?.id).toBe(a4);
    });
  });

  it("keeps companies apart: another company is told the load does not exist, never about its ticket", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const t = await w.submit(w.load.load_id);
      const B = await s.createCompany("Brookside Aggregates (test)");
      const bOwner = await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      const e = await pgError(assign(s, w.load.load_id, w.f.t2, null, w.f.d2, w.assignment));
      expect(e.message).toBe("Load not found.");
      const c = await pgError(s.query("select public.cancel_assignment($1, 'x')", [w.assignment]));
      expect(c.message).toBe("Assignment not found.");
      expect(`${e.message} ${c.message}`).not.toContain(t.ticket_number);
      // The check itself is not callable from the API.
      await s.as(w.dispatcher);
      expect((await pgError(s.query("select private.refuse_ticketed_load($1, $2, 'change')", [B, w.load.load_id]))).code).toBe("42501");
      expect(await activeAssignment(s, w.load.load_id)).toEqual({ id: w.assignment, truck_id: w.f.t1, driver_id: w.f.d1 });
    });
  });
});
