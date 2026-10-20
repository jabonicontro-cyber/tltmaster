// Driver portal and field reports: identity (session → linked active driver),
// only own assignments, driver-safe fields, ticket submission through the
// shared ticket rules with idempotent retries, field reports and their review,
// role visibility, command center items and company isolation.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;
type Home = { driver: { name: string }; assignments: Array<Row & { assignment_id: string; load: Row; order: Row; tickets: Row[]; can_submit_ticket: boolean }>; tickets: Row[]; qualifications: Row[]; reports: Row[] };

const home = async (s: Session) => (await s.query<{ r: Home }>("select public.driver_portal_home() as r")).rows[0].r;
const submit = async (s: Session, p: Row) =>
  (await s.query<{ r: { ticket_id: string; ticket_number: string; status: string; created: boolean } }>("select public.driver_submit_ticket($1::jsonb) as r", [JSON.stringify(p)])).rows[0].r;
const report = async (s: Session, p: Row) =>
  (await s.query<{ r: { report_id: string; created: boolean } }>("select public.driver_submit_field_report($1::jsonb) as r", [JSON.stringify(p)])).rows[0].r;

/** Two linked driver accounts (d1, d2) with loads yesterday, today and tomorrow on one order. */
async function world(s: Session) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const office = await s.createUser("office");
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  await s.query("select public.update_order_details($1, null, $2::jsonb)", [order.id, JSON.stringify({ internal_notes: "SECRET-INTERNAL-NOTE (test)", job_instructions: "Dump at the north pad (test)" })]);
  const past = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton", notes: "Bring the tarp (test)" });
  const a1 = await assign(s, past.load_id, f.t1, null, f.d1);
  const tomorrow = await planLoad(s, order.id, addDays(today, 1), "07:00", "09:00");
  const a1b = await assign(s, tomorrow.load_id, f.t1, null, f.d1);
  const other = await planLoad(s, order.id, yesterday, "10:00", "12:00");
  const a2 = await assign(s, other.load_id, f.t2, null, f.d2);
  const driver1 = await s.createUser("driver");
  const driver2 = await s.createUser("driver");
  await s.as(office);
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driver1]);
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d2, driver2]);
  const ticket = (extra: Row = {}) => ({
    assignment_id: a1, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30",
    quantity: "21.47", unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 8)}`, notes: "", submission_key: randomUUID(), ...extra,
  });
  return { today, yesterday, office, f, order, past, tomorrow, other, a1, a1b, a2, driver1, driver2, ticket };
}

describe("driver identity and what a driver sees", () => {
  it("shows a linked driver only their own assignments, with driver-safe fields", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      const h = await home(s);
      expect(h.driver.name).toBe("Test driver");
      const ids = h.assignments.map((a) => a.assignment_id);
      expect(ids).toEqual(expect.arrayContaining([w.a1, w.a1b]));
      expect(ids).not.toContain(w.a2);
      const a = h.assignments.find((x) => x.assignment_id === w.a1)!;
      expect(a.order).toMatchObject({ job_instructions: "Dump at the north pad (test)" });
      expect(a.load).toMatchObject({ notes: "Bring the tarp (test)", unit_code: "ton" });
      expect(a.can_submit_ticket).toBe(true);
      expect(h.assignments.find((x) => x.assignment_id === w.a1b)?.can_submit_ticket).toBe(false);
      const text = JSON.stringify(h);
      for (const secret of ["SECRET-INTERNAL-NOTE", "unit_rate", "amount_cents", "total_cents", "rate_cents", "price"]) expect(text, secret).not.toContain(secret);

      // Drivers read no tables directly.
      for (const t of ["orders", "order_lines", "order_loads", "dispatch_assignments", "delivery_tickets", "drivers", "audit_events", "billing_handoffs", "billing_reviews", "field_reports"]) {
        expect((await s.query(`select 1 from public.${t} limit 1`)).rowCount, t).toBe(0);
      }
      expect((await s.query("select 1 from public.billing_order_status limit 1")).rowCount).toBe(0);
      expect((await pgError(s.query("select public.command_center_summary()"))).code).toBe("42501");
    });
  });

  it("refuses unlinked or inactive drivers and roles without the portal", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const unlinked = await s.createUser("driver");
      await s.as(unlinked);
      expect((await pgError(home(s))).message).toMatch(/not linked to an active driver/);
      await s.as(w.office);
      await s.query("update public.drivers set active = false where id = $1", [w.f.d1]);
      await s.as(w.driver1);
      expect((await pgError(home(s))).code).toBe("42501");
      expect((await pgError(submit(s, w.ticket()))).code).toBe("42501");
      for (const role of ["office", "dispatcher", "mechanic", null] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await pgError(home(s))).code, String(role)).toBe("42501");
      }
      await s.as(null);
      expect((await pgError(home(s))).code).toBe("42501");
    });
  });
});

describe("driver tickets", () => {
  it("uses the office ticket rules, keeps the driver and equipment of the assignment, and is idempotent", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      const payload = w.ticket({ truck_id: w.f.t2, driver_id: w.f.d2 }); // ignored: taken from the assignment
      const r = await submit(s, payload);
      expect(r).toMatchObject({ created: true, status: "submitted" });
      expect(r.ticket_number).toMatch(/^TKT-\d{4,}$/);
      expect(await submit(s, payload)).toMatchObject({ ticket_id: r.ticket_id, created: false });

      await s.asAdmin();
      const t = (await s.query<Row>("select driver_id, truck_id, status, created_by, quantity::text as q from public.delivery_tickets where id = $1", [r.ticket_id])).rows[0];
      expect(t).toMatchObject({ driver_id: w.f.d1, truck_id: w.f.t1, status: "submitted", created_by: w.driver1, q: "21.470" });
      expect((await s.query<{ d: Row }>("select details as d from public.delivery_ticket_events where ticket_id = $1", [r.ticket_id])).rows[0].d).toMatchObject({ source: "driver_portal" });
      expect((await s.query<{ summary: string }>("select summary from public.audit_events where action = 'ticket.submitted' and details ->> 'ticket_id' = $1", [r.ticket_id])).rows[0].summary).toMatch(/entered by the driver/);

      await s.as(w.driver1);
      const h = await home(s);
      expect(h.tickets[0]).toMatchObject({ id: r.ticket_id, status: "submitted" });
      // Yesterday's load now has its ticket, so it leaves "Tickets still needed".
      expect(h.assignments.map((a) => a.assignment_id)).not.toContain(w.a1);

      // A second ticket on the load needs confirmation and is flagged.
      const second = w.ticket({ quantity: "3" });
      expect((await pgError(submit(s, second))).code).toBe("PT422");
      expect(await submit(s, { ...second, confirm_duplicate: true })).toMatchObject({ created: true, status: "needs_review" });

      // Same validation as the office.
      expect((await pgError(submit(s, w.ticket({ quantity: "2.5", unit_code: "load" })))).message).toMatch(/whole numbers/);
      expect((await pgError(submit(s, w.ticket({ unit_code: "" })))).message).toMatch(/Choose the unit/);
      expect((await pgError(submit(s, w.ticket({ submission_key: "" })))).message).toMatch(/Missing submission key/);
    });
  });

  it("refuses another driver's load, a future load, a stolen submission key and office review actions", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      expect((await pgError(submit(s, w.ticket({ assignment_id: w.a2 })))).code).toBe("42501");
      expect((await pgError(submit(s, w.ticket({ assignment_id: w.a1b, delivered_date: w.today })))).message).toMatch(/from the day of the load/);
      expect((await pgError(s.query("select public.driver_assignment_form($1)", [w.a2]))).code).toBe("42501");
      const mine = await submit(s, w.ticket());

      await s.asAdmin();
      const usedKey = (await s.query<{ k: string }>("select submission_key as k from public.delivery_tickets where id = $1", [mine.ticket_id])).rows[0].k;
      await s.as(w.driver2);
      const stolen = await pgError(submit(s, { ...w.ticket({ assignment_id: w.a2 }), submission_key: usedKey }));
      expect(stolen.code).toBe("42501");
      expect((await pgError(s.query("select public.review_delivery_ticket($1, 'accept', '')", [mine.ticket_id]))).code).toBe("42501");
      expect((await pgError(s.query("select public.submit_delivery_ticket($1::jsonb)", [JSON.stringify({ load_id: w.other.load_id })]))).code).toBe("42501");

      // Reassigning the load away from the driver ends their access to it.
      await s.as(w.office);
      await assign(s, w.past.load_id, w.f.t2, null, w.f.d3, w.a1);
      await s.as(w.driver1);
      expect((await pgError(submit(s, w.ticket()))).code).toBe("42501");
      expect((await home(s)).assignments.map((a) => a.assignment_id)).not.toContain(w.a1);
    });
  });
});

describe("field reports", () => {
  it("records reports on the driver's own assignment, changes nothing else, and is reviewed by office, dispatch or the shop", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      const key = randomUUID();
      const delay = await report(s, { assignment_id: w.a1, kind: "delay", description: "Waiting at the quarry scale (test)", submission_key: key });
      expect(delay.created).toBe(true);
      expect(await report(s, { assignment_id: w.a1, kind: "delay", description: "Waiting at the quarry scale (test)", submission_key: key })).toEqual({ report_id: delay.report_id, created: false });
      expect((await pgError(report(s, { assignment_id: w.a1, kind: "breakdown", description: "Air leak", submission_key: randomUUID() }))).message).toMatch(/truck or the trailer/);
      expect((await pgError(report(s, { assignment_id: w.a1, kind: "breakdown", equipment: "trailer", description: "Air leak", submission_key: randomUUID() }))).message).toMatch(/no trailer/);
      expect((await pgError(report(s, { assignment_id: w.a2, kind: "delay", description: "Not mine", submission_key: randomUUID() }))).code).toBe("42501");
      expect((await pgError(report(s, { assignment_id: w.a1, kind: "delay", description: "", submission_key: randomUUID() }))).message).toMatch(/Describe what happened/);
      const breakdown = await report(s, { assignment_id: w.a1b, kind: "breakdown", equipment: "truck", description: "Air leak on the tag axle (test)", submission_key: randomUUID() });
      expect((await home(s)).reports.map((r) => r.id).sort()).toEqual([breakdown.report_id, delay.report_id].sort());

      // Nothing changes by itself.
      await s.asAdmin();
      expect((await s.query("select service_status from public.trucks where id = $1", [w.f.t1])).rows[0].service_status).toBe("in_service");
      expect((await s.query("select status from public.dispatch_assignments where id = any($1)", [[w.a1, w.a1b]])).rows.every((r) => r.status === "active")).toBe(true);
      const audit = (await s.query<{ entity_type: string }>("select entity_type from public.audit_events where action = 'field_report.submitted' and details ->> 'report_id' = any($1) order by entity_type", [[delay.report_id, breakdown.report_id]])).rows;
      expect(audit.map((a) => a.entity_type)).toEqual(["order", "truck"]);

      // Office sees both in the command center.
      await s.as(w.office);
      // Each kind on its own: a database with earlier test runs holds many other items.
      const items = async (kind: string) =>
        (await s.query<{ r: { items: Array<Row & { exception_key: string }> } }>("select public.command_center_exceptions($1, false, 500, 0) as r", [kind])).rows[0].r.items;
      expect((await items("equipment_report")).find((i) => i.exception_key === `field_report:${breakdown.report_id}`)).toMatchObject({ kind: "equipment_report", priority: 1, unit_number: expect.any(String) });
      expect((await items("delay_report")).find((i) => i.exception_key === `field_report:${delay.report_id}`)).toMatchObject({ kind: "delay_report", priority: 2 });

      // Mechanics see and resolve equipment reports only (and cannot be assigned delays).
      const mechanic = await s.createUser("mechanic");
      await s.as(w.office);
      expect((await pgError(s.query("select public.assign_exception($1, $2, '')", [`field_report:${delay.report_id}`, mechanic]))).message).toMatch(/cannot resolve this item/);
      await s.query("select public.assign_exception($1, $2, '')", [`field_report:${breakdown.report_id}`, mechanic]);
      await s.as(mechanic);
      expect((await s.query("select id from public.field_reports where id = any($1)", [[delay.report_id, breakdown.report_id]])).rows.map((r) => r.id)).toEqual([breakdown.report_id]);
      expect((await pgError(s.query("select public.review_field_report($1, 'acknowledge', '')", [delay.report_id]))).message).toMatch(/Report not found/);
      await s.query("select public.review_field_report($1, 'acknowledge', 'Shop will look at it (test)')", [breakdown.report_id]);
      expect((await pgError(s.query("select public.review_field_report($1, 'acknowledge', '')", [breakdown.report_id]))).code).toBe("PT409");
      expect((await pgError(s.query("select public.review_field_report($1, 'resolve', '')", [breakdown.report_id]))).message).toMatch(/how it was resolved/);
      await s.query("select public.review_field_report($1, 'resolve', 'Fitting replaced (test)')", [breakdown.report_id]);

      // Dispatch resolves the delay; resolved items leave the command center.
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      await s.query("select public.review_field_report($1, 'resolve', 'Customer told (test)')", [delay.report_id]);
      await s.as(w.office);
      const after = (await s.query<{ r: { items: Array<{ exception_key: string }> } }>("select public.command_center_exceptions(null, false, 100, 0) as r")).rows[0].r.items;
      expect(after.some((i) => i.exception_key.includes(delay.report_id) || i.exception_key.includes(breakdown.report_id))).toBe(false);

      // Records resist direct changes; drivers cannot review.
      expect((await pgError(s.query("update public.field_reports set description = 'x' where id = $1", [delay.report_id]))).code).toBe("42501");
      await s.asAdmin();
      expect((await pgError(s.query("update public.field_reports set description = 'x' where id = $1", [delay.report_id]))).code).toBe("42501");
      expect((await pgError(s.query("update public.field_reports set status = 'open', resolved_at = null, resolution_note = '' where id = $1", [delay.report_id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.field_reports where id = $1", [delay.report_id]))).code).toBe("42501");
      await s.as(w.driver1);
      expect((await pgError(s.query("select public.review_field_report($1, 'resolve', 'x')", [delay.report_id]))).code).toBe("42501");
    });
  });
});

describe("company isolation", () => {
  it("a driver or office of another company cannot see or act on Top Line loads and reports", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      const r = await report(s, { assignment_id: w.a1, kind: "delay", description: "Late (test)", submission_key: randomUUID() });

      const B = await s.createCompany("Brookside Aggregates (test)");
      const bOwner = await s.createUser("owner", { companyId: B });
      const bDriverUser = await s.createUser("driver", { companyId: B });
      await s.as(bOwner);
      await insert(s, "drivers", { user_id: bDriverUser });
      expect((await s.query("select id from public.field_reports")).rowCount).toBe(0);
      expect((await pgError(s.query("select public.review_field_report($1, 'resolve', 'hijack')", [r.report_id]))).message).toMatch(/Report not found/);

      await s.as(bDriverUser);
      expect((await home(s)).assignments).toEqual([]);
      expect((await pgError(submit(s, w.ticket()))).code).toBe("42501");
      expect((await pgError(report(s, { assignment_id: w.a1, kind: "delay", description: "Hijack", submission_key: randomUUID() }))).code).toBe("42501");
      expect((await pgError(s.query("select public.driver_assignment_form($1)", [w.a1]))).code).toBe("42501");
      await s.asAdmin();
      expect((await s.query("select count(*)::int as n from public.field_reports where company_id = $1", [TOP_LINE])).rows[0].n).toBeGreaterThan(0);
    });
  });
});
