// Tickets without Dispatch (MOD1 (2), migration 20261120023100, docs/MODULES.md §5): with Dispatch off a ticket is
// entered against the customer's job (truck and driver optional) and goes through review, billing readiness and the
// invoice draft as any ticket; with Dispatch on nothing changes and every existing ticket rule still applies.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, TOP_LINE, withSession, type Session } from "./helpers";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";

afterAll(() => pool.end());

type J = Record<string, unknown>;
const rpc = async <T = J>(s: Session, fn: string, ...args: unknown[]) =>
  (await s.query<{ r: T }>(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r;

async function job(s: Session, user: string, date: string) {
  const ids = await sampleIds(s);
  await s.as(user);
  return rpc<{ order_id: string; order_number: string; order_line_id: string }>(s, "create_ticket_job", JSON.stringify({
    customer_id: ids.customerId, site_label: "North pit job (test)", project_name: "Driveway base", delivered_date: date,
    lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "30", unit_rate_cents: 1000, taxable: true }],
  }));
}

const ticket = (order: string, line: string, date: string, extra: J = {}) =>
  JSON.stringify({ order_id: order, order_line_id: line, delivered_date: date, quantity: "18.5", unit_code: "ton", external_reference: `P-${randomUUID().slice(0, 6)}`, ...extra });

describe("tickets without dispatch", () => {
  it("are refused while the company dispatches, and existing ticket rules stay as they were", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      await s.as(owner);
      // Dispatch is on (default): neither a job from the ticket screen nor a ticket without a load.
      expect((await pgError(job(s, owner, today))).message).toMatch(/uses Dispatch/);
      const order = await scheduledOrder(s, owner, today);
      expect((await pgError(rpc(s, "submit_ticket_without_dispatch", ticket(order.id, order.materialLine, today)))).message).toMatch(/uses Dispatch/);

      // A dispatched ticket still needs its assignment, truck and driver (the database refuses a bare one).
      const f = await fleet(s, owner, today);
      const load = await planLoad(s, order.id, today, "06:00", "07:00");
      await assign(s, load.load_id, f.t1, null, f.d1);
      await s.asAdmin();
      const bare = pgError(s.query(
        "insert into public.delivery_tickets (company_id, ticket_number, status, order_id, load_id, order_line_id, delivered_at, quantity, unit_code, snapshot) values ($1, 'T-BARE', 'submitted', $2, $3, $4, now(), 1, 'ton', '{}')",
        [TOP_LINE, order.id, load.load_id, order.materialLine]));
      expect((await bare).code).toBe("23514");
      // Marking it "without dispatch" on a dispatched load is refused too.
      const marked = pgError(s.query(
        "insert into public.delivery_tickets (company_id, ticket_number, status, order_id, load_id, order_line_id, delivered_at, quantity, unit_code, snapshot, without_dispatch) values ($1, 'T-MARK', 'submitted', $2, $3, $4, now(), 1, 'ton', '{}', true)",
        [TOP_LINE, order.id, load.load_id, order.materialLine]));
      expect((await marked).code).toBe("42501");
      await s.as(owner);
      const t = await rpc<{ status: string }>(s, "submit_delivery_ticket", JSON.stringify({
        load_id: load.load_id, order_line_id: order.materialLine, delivered_date: today, delivered_time: "06:30", quantity: "20", unit_code: "ton", external_reference: `D-${randomUUID().slice(0, 6)}` }));
      expect(["submitted", "needs_review"]).toContain(t.status);
    });
  });

  it("with Dispatch off: job in one step, ticket without truck or driver, review, billing and invoice draft", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const today = await businessToday(s);
      await s.as(owner);
      await s.query("select public.set_company_modules(private.module_preset('tickets_to_billing'))");

      await s.as(office);
      const j = await job(s, office, today);
      await s.asAdmin();
      const order = (await s.query<{ status: string; total_cents: string }>("select status, total_cents from public.orders where id = $1", [j.order_id])).rows[0];
      expect(order.status).toBe("in_progress");

      await s.as(office);
      const t = await rpc<{ ticket_id: string; ticket_number: string; status: string; load_id: string; created: boolean }>(s, "submit_ticket_without_dispatch", ticket(j.order_id, j.order_line_id, today, { submission_key: randomUUID() }));
      expect(t.created).toBe(true);
      await s.asAdmin();
      const row = (await s.query<{ assignment_id: string | null; truck_id: string | null; driver_id: string | null; without_dispatch: boolean; snapshot: J }>(
        "select assignment_id, truck_id, driver_id, without_dispatch, snapshot from public.delivery_tickets where id = $1", [t.ticket_id])).rows[0];
      expect(row).toMatchObject({ assignment_id: null, truck_id: null, driver_id: null, without_dispatch: true });
      expect(row.snapshot).toMatchObject({ without_dispatch: true, time_entered: false, load_number: 1 });
      const load = (await s.query<{ from_ticket: boolean; status: string }>("select from_ticket, status from public.order_loads where id = $1", [t.load_id])).rows[0];
      expect(load).toEqual({ from_ticket: true, status: "planned" });

      // Its delivery can never get a truck assignment.
      const f = await fleet(s, owner, today);
      await s.as(owner);
      expect((await pgError(s.query("select public.assign_load($1, $2, null, $3, '', null)", [t.load_id, f.t1, f.d1]))).message).toMatch(/entered from its ticket|already has delivery/);
      await s.asAdmin();
      const direct = pgError(s.query("insert into public.dispatch_assignments (company_id, load_id, order_id, truck_id, driver_id, starts_at, ends_at) select company_id, id, order_id, $2, $3, starts_at, ends_at from public.order_loads where id = $1", [t.load_id, f.t1, f.d1]));
      expect((await direct).message).toMatch(/entered from its ticket/);

      // Review, then billing readiness and the invoice draft's input (accepted quantity, the job's price).
      await s.as(office);
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
      await s.query("select public.set_order_status($1, 'completed', '')", [j.order_id]);
      const readiness = (await s.query<{ readiness: string; tickets_accepted: number; loads_missing: number }>(
        "select readiness, tickets_accepted, loads_missing from public.billing_order_status where order_id = $1", [j.order_id])).rows[0];
      expect(readiness.tickets_accepted).toBe(1);
      expect(readiness.loads_missing).toBe(0);
      expect(["ready", "blocked"]).toContain(readiness.readiness);
      const line = (await s.query<{ delivered_quantity: string; unit_rate_cents: string }>("select delivered_quantity, unit_rate_cents from public.billing_line_status where line_id = $1", [j.order_line_id])).rows[0];
      expect(Number(line.delivered_quantity)).toBe(18.5);
      expect(Number(line.unit_rate_cents)).toBe(1000);
    });
  });

  it("checks quantity, date and job; truck and driver may be named; corrections keep the delivery; voiding cancels it", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      await s.as(owner);
      await s.query("select public.set_company_modules(array['dispatch'])");
      const j = await job(s, owner, today);
      expect((await pgError(rpc(s, "submit_ticket_without_dispatch", ticket(j.order_id, j.order_line_id, today, { quantity: "" })))).message).toMatch(/quantity/);
      expect((await pgError(rpc(s, "submit_ticket_without_dispatch", ticket(j.order_id, j.order_line_id, "")))).message).toMatch(/delivery date/);
      expect((await pgError(rpc(s, "submit_ticket_without_dispatch", ticket(randomUUID(), j.order_line_id, today)))).message).toMatch(/job/);

      const f = await fleet(s, owner, today);
      await s.as(owner);
      const t = await rpc<{ ticket_id: string; load_id: string; ticket_number: string }>(s, "submit_ticket_without_dispatch", ticket(j.order_id, j.order_line_id, today, { truck_id: f.t1, driver_id: f.d2, delivered_time: "00:30" }));
      await s.asAdmin();
      const named = (await s.query<{ truck_id: string; driver_id: string; snapshot: J }>("select truck_id, driver_id, snapshot from public.delivery_tickets where id = $1", [t.ticket_id])).rows[0];
      expect(named.truck_id).toBe(f.t1);
      expect(named.driver_id).toBe(f.d2);
      expect(named.snapshot.time_entered).toBe(true);

      // The same paper ticket number again needs a confirmation.
      await s.as(owner);
      const ref = (await s.query<{ r: string }>("select external_reference r from public.delivery_tickets where id = $1", [t.ticket_id])).rows[0].r;
      expect((await pgError(rpc(s, "submit_ticket_without_dispatch", ticket(j.order_id, j.order_line_id, today, { external_reference: ref })))).code).toBe("PT422");

      // A correction keeps its own delivery and is rechecked.
      const c = await rpc<{ ticket_id: string; revision: number }>(s, "correct_delivery_ticket", t.ticket_id,
        JSON.stringify({ load_id: t.load_id, order_line_id: j.order_line_id, delivered_date: today, quantity: "20", unit_code: "ton", external_reference: ref }), "Scale reading corrected");
      expect(c.revision).toBe(2);
      await s.asAdmin();
      const rev = (await s.query<{ without_dispatch: boolean; load_id: string; quantity: string }>("select without_dispatch, load_id, quantity from public.delivery_tickets where id = $1", [c.ticket_id])).rows[0];
      expect(rev).toMatchObject({ without_dispatch: true, load_id: t.load_id });

      // Voiding it cancels its delivery, so billing does not wait for it.
      await s.as(owner);
      await s.query("select public.review_delivery_ticket($1, 'void', 'Entered twice')", [c.ticket_id]);
      await s.asAdmin();
      expect((await s.query<{ status: string }>("select status from public.order_loads where id = $1", [t.load_id])).rows[0].status).toBe("canceled");

      // Dispatch switched back on: the earlier ticket stays; new ones go through dispatch again.
      await s.as(owner);
      await s.query("select public.set_company_modules('{}')");
      expect((await pgError(rpc(s, "submit_ticket_without_dispatch", ticket(j.order_id, j.order_line_id, today)))).message).toMatch(/uses Dispatch/);
    });
  });

  // Financial review 2026-11-18 (M): with Dispatch on, every delivery for a customer on credit hold goes through
  // assign_load, which needs a reason and records it (20261120016300). Without Dispatch the job and each ticket do.
  it("a customer on credit hold needs a reason for a new job and for each ticket, recorded with the audit event", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      const today = await businessToday(s);
      const ids = await sampleIds(s);
      await s.as(owner);
      await s.query("select public.set_company_modules(private.module_preset('tickets_to_billing'))");
      const holdError = async (p: Promise<unknown>) => {
        try {
          await p;
        } catch (e) {
          const err = e as { code?: string; hint?: string; message?: string };
          return { code: err.code, hint: err.hint, message: err.message ?? "" };
        }
        throw new Error("Expected the query to fail, but it succeeded");
      };
      const overrides = async () => {
        await s.asAdmin();
        return (await s.query<{ context: string; entity_id: string; reason: string; hold_reasons: string[]; created_by: string }>(
          "select context, entity_id, reason, hold_reasons, created_by from public.credit_hold_overrides where company_id = $1 and customer_id = $2 order by created_at, reason",
          [TOP_LINE, ids.customerId])).rows;
      };

      // Not on hold: unchanged, no reason asked and nothing recorded.
      const plain = await job(s, office, today);
      await s.as(office);
      await rpc(s, "submit_ticket_without_dispatch", ticket(plain.order_id, plain.order_line_id, today));
      expect(await overrides()).toEqual([]);

      await s.query("update public.customers set credit_hold = true, credit_hold_reason = 'Two invoices late (test)' where id = $1", [ids.customerId]);

      // A new job: refused without a reason (or with one under 3 characters), and for someone who cannot change orders.
      const newJob = (reason?: string) => rpc<{ order_id: string; order_line_id: string; order_number: string }>(s, "create_ticket_job", JSON.stringify({
        customer_id: ids.customerId, site_label: "Held job (test)", project_name: "Held job", delivered_date: today,
        lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "30", unit_rate_cents: 1000, taxable: true }],
        ...(reason === undefined ? {} : { credit_reason: reason }),
      }));
      await s.as(office);
      expect(await holdError(newJob())).toMatchObject({ code: "22023", hint: "credit_hold" });
      expect(await holdError(newJob("ok"))).toMatchObject({ code: "22023", hint: "credit_hold" });
      await s.as(dispatcher);
      expect((await holdError(newJob("Owner approved by phone"))).code).toBe("42501");
      await s.as(office);
      const held = await newJob("Owner approved by phone");
      expect(await overrides()).toEqual([
        { context: "order", entity_id: held.order_id, reason: "Owner approved by phone", hold_reasons: ["manual"], created_by: office },
      ]);

      // Each ticket: refused without a reason, entered with one; the reason and the audit event are written with it.
      await s.as(dispatcher);
      expect(await holdError(rpc(s, "submit_ticket_without_dispatch", ticket(held.order_id, held.order_line_id, today)))).toMatchObject({ code: "22023", hint: "credit_hold" });
      expect(await holdError(rpc(s, "submit_ticket_without_dispatch", ticket(plain.order_id, plain.order_line_id, today, { credit_reason: "  " })))).toMatchObject({ code: "22023", hint: "credit_hold" });
      const key = randomUUID();
      const t = await rpc<{ ticket_id: string; created: boolean }>(s, "submit_ticket_without_dispatch",
        ticket(held.order_id, held.order_line_id, today, { submission_key: key, credit_reason: "Payment promised Friday" }));
      expect(t.created).toBe(true);
      const recorded = await overrides();
      expect(recorded).toHaveLength(2);
      expect(recorded[1]).toEqual({ context: "order", entity_id: held.order_id, reason: "Payment promised Friday", hold_reasons: ["manual"], created_by: dispatcher });
      const events = (await s.query<{ actor_id: string; summary: string; details: J }>(
        "select actor_id, summary, details from public.audit_events where action = 'customer.credit_override' and entity_id = $1", [ids.customerId])).rows;
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.actor_id).sort()).toEqual([office, dispatcher].sort());
      const ticketEvent = events.find((e) => e.actor_id === dispatcher)!;
      expect(ticketEvent.summary).toMatch(/Payment promised Friday/);
      expect(ticketEvent.details).toMatchObject({ context: "order", entity_id: held.order_id, ticket_id: t.ticket_id, source: "without_dispatch", hold_reasons: ["manual"] });

      // A retry of the same submission returns the ticket without recording the reason again.
      await s.as(dispatcher);
      const again = await rpc<{ ticket_id: string; created: boolean }>(s, "submit_ticket_without_dispatch", ticket(held.order_id, held.order_line_id, today, { submission_key: key }));
      expect(again).toMatchObject({ ticket_id: t.ticket_id, created: false });
      expect(await overrides()).toHaveLength(2);

      // Released: no reason needed again, nothing more recorded.
      await s.query("update public.customers set credit_hold = false where id = $1", [ids.customerId]);
      await s.as(office);
      await rpc(s, "submit_ticket_without_dispatch", ticket(held.order_id, held.order_line_id, today));
      expect(await overrides()).toHaveLength(2);
    });
  });

  it("needs tickets.edit, stays in the caller's company, and a ticket without a driver is not payable", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const mechanic = await s.createUser("mechanic");
      const today = await businessToday(s);
      await s.as(owner);
      await s.query("select public.set_company_modules(array['dispatch'])");
      const j = await job(s, owner, today);
      await s.as(mechanic);
      expect((await pgError(rpc(s, "submit_ticket_without_dispatch", ticket(j.order_id, j.order_line_id, today)))).code).toBe("42501");

      // Another company's owner cannot reach this job.
      const other = await s.createCompany(`No Dispatch Other ${randomUUID().slice(0, 6)} (test)`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.asAdmin();
      await s.query("update public.company_settings set modules_off = array['dispatch'] where company_id = $1", [other]);
      await s.as(otherOwner);
      expect((await pgError(rpc(s, "submit_ticket_without_dispatch", ticket(j.order_id, j.order_line_id, today)))).message).toMatch(/job/);

      await s.as(owner);
      const t = await rpc<{ ticket_id: string }>(s, "submit_ticket_without_dispatch", ticket(j.order_id, j.order_line_id, today));
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
      await s.asAdmin();
      // Payroll reads accepted tickets with a driver (payroll_period_work); this one has none.
      expect((await s.query("select 1 from public.delivery_tickets where id = $1 and driver_id is not null", [t.ticket_id])).rowCount).toBe(0);
    });
  });
});
