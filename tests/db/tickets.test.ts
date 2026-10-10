// Delivery tickets: creation, numbering under concurrency, quantity/unit
// validation, references, duplicates, review, corrections and voids, history
// across reassignment, load/order constraints, permissions and isolation.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { REVIEW_REASON_LABELS, unitRequiresWhole } from "@/lib/tickets/rules";
import { assign, businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;
type Submit = { ticket_id: string; ticket_number: string; status: string; created: boolean };

async function submit(s: Session, payload: Row) {
  const r = await s.query<{ r: Submit }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify(payload)]);
  return r.rows[0].r;
}

async function ticket(s: Session, id: string) {
  await s.asAdmin();
  return (await s.query("select *, quantity::text as qty from public.delivery_tickets where id = $1", [id])).rows[0];
}

/** Yesterday's assigned load of a scheduled order, and a clean payload for it. */
async function world(s: Session) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const office = await s.createUser("office");
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), today, addDays(today, -2));
  const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
  const assignment = await assign(s, load.load_id, f.t1, null, f.d1);
  const payload = {
    load_id: load.load_id,
    order_line_id: order.materialLine,
    delivered_date: yesterday,
    delivered_time: "08:30",
    quantity: "21.47",
    unit_code: "ton",
    external_reference: `SC-${randomUUID().slice(0, 8)}`,
    notes: "Scale house copy",
  };
  return { today, yesterday, office, f, order, load, assignment, payload };
}

describe("submitting tickets", () => {
  it("creates a numbered ticket with snapshots, history and an order audit entry; actual quantity is kept as entered", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const r = await submit(s, w.payload);
      expect(r).toMatchObject({ status: "submitted", created: true });
      expect(r.ticket_number).toMatch(/^T-\d{4}-\d{5}$/);
      const t = await ticket(s, r.ticket_id);
      expect(t).toMatchObject({
        company_id: TOP_LINE,
        revision: 1,
        order_id: w.order.id,
        load_id: w.load.load_id,
        assignment_id: w.assignment,
        order_line_id: w.order.materialLine,
        truck_id: w.f.t1,
        driver_id: w.f.d1,
        qty: "21.470", // not the planned 22
        unit_code: "ton",
        review_reasons: [],
        created_by: w.office,
      });
      expect(t.material_id).not.toBeNull();
      expect(t.snapshot).toMatchObject({ order_number: w.order.number, load_number: 1, line_description: "Gravel #53", driver_name: "Driver A", planned_quantity: 22 });
      expect(t.snapshot.truck_unit).toMatch(/^K1-/);
      const ev = await s.query("select action, from_status, to_status from public.delivery_ticket_events where ticket_id = $1", [r.ticket_id]);
      expect(ev.rows).toEqual([{ action: "submitted", from_status: null, to_status: "submitted" }]);
      const audit = await s.query("select summary from public.audit_events where entity_id = $1 and action = 'ticket.submitted'", [w.order.id]);
      expect(audit.rows[0].summary).toMatch(new RegExp(`^Ticket ${r.ticket_number} for ${w.order.number} load 1: 21\\.47 ton$`));
      // The order itself is not changed by a ticket.
      const o = (await s.query("select status, total_cents from public.orders where id = $1", [w.order.id])).rows[0];
      expect(o.status).toBe("scheduled");
    });
  });

  it("validates quantities, units, times and references", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const other = await scheduledOrder(s, w.office, w.yesterday, null, w.yesterday);
      await s.as(w.office);
      const cases: Array<[Row, RegExp]> = [
        [{ quantity: "" }, /Enter the delivered quantity/],
        [{ quantity: "0" }, /greater than 0/],
        [{ quantity: "1.2345" }, /at most 3 decimal places/],
        [{ quantity: "abc" }, /at most 3 decimal places/],
        [{ quantity: "-4" }, /at most 3 decimal places/],
        [{ quantity: "NaN" }, /at most 3 decimal places/],
        [{ quantity: "1e3" }, /at most 3 decimal places/],
        [{ unit_code: "" }, /Choose the unit/],
        [{ unit_code: "parsec" }, /valid unit/],
        [{ unit_code: "load", quantity: "2.5" }, /must be whole numbers/],
        [{ delivered_date: addDays(w.today, 2) }, /cannot be in the future/],
        [{ delivered_time: "" }, /delivery date and time/],
        [{ order_line_id: other.materialLine }, /Choose the order line/],
        [{ load_id: randomUUID() }, /Load not found/],
        [{ truck_id: randomUUID() }, /Truck not found/],
        [{ driver_id: randomUUID() }, /Driver not found/],
      ];
      for (const [patch, m] of cases) {
        expect((await pgError(submit(s, { ...w.payload, ...patch }))).message, JSON.stringify(patch)).toMatch(m);
      }
      // Whole loads are fine in loads.
      const loadsTicket = await submit(s, { ...w.payload, unit_code: "load", quantity: "1" });
      expect((await ticket(s, loadsTicket.ticket_id)).review_reasons).toEqual(["unit_differs_from_order_line"]);
    });
  });

  it("refuses loads that are not assigned or canceled, and orders that are not in work", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const unassigned = await planLoad(s, w.order.id, w.yesterday, "10:00", "11:00");
      expect((await pgError(submit(s, { ...w.payload, load_id: unassigned.load_id }))).message).toMatch(/no truck and driver assigned/);
      await s.query("select public.cancel_order_load($1, 'Not needed')", [unassigned.load_id]);
      expect((await pgError(submit(s, { ...w.payload, load_id: unassigned.load_id }))).message).toMatch(/is canceled/);
      await s.query("select public.set_order_status($1, 'on_hold', 'Weather')", [w.order.id]);
      // Holding the order released the assignment.
      expect((await pgError(submit(s, w.payload))).message).toMatch(/is on hold/);
    });
  });

  it("flags tickets for review instead of converting or guessing", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const r = await submit(s, { ...w.payload, unit_code: "cu_yd", delivered_date: w.today, delivered_time: "00:05", driver_id: w.f.d2, external_reference: "" });
      expect(r.status).toBe("needs_review");
      const t = await ticket(s, r.ticket_id);
      expect(t.review_reasons).toEqual(["unit_differs_from_order_line", "delivered_on_other_day", "equipment_differs_from_assignment", "missing_external_reference"]);
      expect(t.qty).toBe("21.470");
      expect(t.unit_code).toBe("cu_yd");
    });
  });
});

describe("duplicates", () => {
  it("returns the same ticket for a repeated submission and requires confirmation for a second ticket or a reused reference", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const key = randomUUID();
      const first = await submit(s, { ...w.payload, submission_key: key });
      const again = await submit(s, { ...w.payload, submission_key: key, quantity: "99" });
      expect(again).toEqual({ ...first, created: false });

      const second = await pgError(submit(s, { ...w.payload, external_reference: "SC-OTHER" }));
      expect(second.code).toBe("PT422");
      expect(second.message).toMatch(new RegExp(`already has ticket ${first.ticket_number}`));
      const confirmed = await submit(s, { ...w.payload, external_reference: "SC-OTHER", confirm_duplicate: true });
      expect((await ticket(s, confirmed.ticket_id)).review_reasons).toEqual(["additional_ticket_for_load"]);

      // A reused paper ticket number on another load.
      await s.as(w.office);
      const load2 = await planLoad(s, w.order.id, w.yesterday, "10:00", "11:00");
      await assign(s, load2.load_id, w.f.t2, null, w.f.d2);
      const reused = await pgError(submit(s, { ...w.payload, load_id: load2.load_id }));
      expect(reused.code).toBe("PT422");
      expect(reused.message).toMatch(/is already used on/);
      const ok = await submit(s, { ...w.payload, load_id: load2.load_id, truck_id: w.f.t2, driver_id: w.f.d2, confirm_duplicate: true });
      expect((await ticket(s, ok.ticket_id)).review_reasons).toEqual(["duplicate_external_reference"]);
    });
  });
});

describe("review, correction and void", () => {
  it("keeps every revision and event; accepted tickets need a reviewer to correct", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      const r = await submit(s, w.payload);
      expect((await pgError(s.query("select public.review_delivery_ticket($1, 'accept', '')", [r.ticket_id]))).code).toBe("42501");

      // The dispatcher corrects a typo before review.
      const c1 = await s.query<{ r: { ticket_id: string; revision: number; status: string } }>(
        "select public.correct_delivery_ticket($1, $2::jsonb, 'Typo in tons') as r",
        [r.ticket_id, JSON.stringify({ ...w.payload, quantity: "21.74" })],
      );
      const rev2 = c1.rows[0].r;
      expect(rev2).toMatchObject({ revision: 2, status: "submitted" });
      expect((await pgError(s.query("select public.correct_delivery_ticket($1, $2::jsonb, 'again')", [r.ticket_id, JSON.stringify(w.payload)]))).message).toMatch(/superseded/);
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.correct_delivery_ticket($1, $2::jsonb, '  ')", [rev2.ticket_id, JSON.stringify(w.payload)]))).message).toMatch(/reason/);

      await s.as(w.office);
      await s.query("select public.review_delivery_ticket($1, 'accept', 'Matches scale ticket')", [rev2.ticket_id]);
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.correct_delivery_ticket($1, $2::jsonb, 'late fix')", [rev2.ticket_id, JSON.stringify(w.payload)]))).code).toBe("42501");
      await s.as(w.office);
      const c2 = await s.query<{ r: { ticket_id: string; revision: number; status: string } }>(
        "select public.correct_delivery_ticket($1, $2::jsonb, 'Scale house reissued ticket') as r",
        [rev2.ticket_id, JSON.stringify({ ...w.payload, quantity: "22.01" })],
      );
      const rev3 = c2.rows[0].r;
      expect(rev3).toMatchObject({ revision: 3, status: "submitted" }); // reviewed again
      expect((await pgError(s.query("select public.review_delivery_ticket($1, 'void', '')", [rev3.ticket_id]))).message).toMatch(/reason/);
      await s.query("select public.review_delivery_ticket($1, 'void', 'Wrong job')", [rev3.ticket_id]);
      expect((await pgError(s.query("select public.review_delivery_ticket($1, 'accept', '')", [rev3.ticket_id]))).message).toMatch(/voided/);

      await s.asAdmin();
      const revs = (await s.query("select revision, status, quantity::text as q, correction_reason from public.delivery_tickets where ticket_number = $1 order by revision", [r.ticket_number])).rows;
      expect(revs).toEqual([
        { revision: 1, status: "superseded", q: "21.470", correction_reason: "" },
        { revision: 2, status: "superseded", q: "21.740", correction_reason: "Typo in tons" },
        { revision: 3, status: "voided", q: "22.010", correction_reason: "Scale house reissued ticket" },
      ]);
      const events = (await s.query("select action, from_status, to_status from public.delivery_ticket_events where ticket_number = $1 and company_id = $2 order by occurred_at, action", [r.ticket_number, TOP_LINE])).rows;
      expect(events.map((e) => e.action).sort()).toEqual(["accepted", "corrected", "corrected", "submitted", "voided"]);
      const corrected = (await s.query("select details from public.delivery_ticket_events where ticket_id = $1 and action = 'corrected'", [rev2.ticket_id])).rows[0];
      expect(corrected.details.changes.quantity).toEqual({ from: 21.47, to: 21.74 });

      // Records cannot be rewritten or deleted, even by the database owner.
      expect((await pgError(s.query("update public.delivery_tickets set quantity = 1 where id = $1", [rev3.ticket_id]))).code).toBe("42501");
      expect((await pgError(s.query("update public.delivery_tickets set status = 'accepted' where id = $1", [rev3.ticket_id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.delivery_tickets where id = $1", [r.ticket_id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.delivery_ticket_events where ticket_number = $1", [r.ticket_number]))).code).toBe("42501");
    });
  });

  it("keeps the delivery record when the load is reassigned later", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const r = await submit(s, w.payload);
      const before = await ticket(s, r.ticket_id);
      await s.as(w.office);
      await assign(s, w.load.load_id, w.f.t2, null, w.f.d2, w.assignment);
      const after = await ticket(s, r.ticket_id);
      expect(after).toEqual(before);
      expect(after.snapshot.truck_unit).toMatch(/^K1-/);
      const a = (await s.query("select status, cancel_reason from public.dispatch_assignments where id = $1", [before.assignment_id])).rows[0];
      expect(a).toEqual({ status: "canceled", cancel_reason: "Reassigned" });

      // With no active assignment left, a correction still refers to the original one.
      await s.as(w.office);
      const current = (await s.query<{ id: string }>("select id from public.dispatch_assignments where load_id = $1 and status = 'active'", [w.load.load_id])).rows[0].id;
      await s.query("select public.cancel_assignment($1, 'Truck broke down')", [current]);
      const c = await s.query<{ r: { ticket_id: string } }>("select public.correct_delivery_ticket($1, $2::jsonb, 'Scale reading') as r", [r.ticket_id, JSON.stringify({ ...w.payload, quantity: "21.5" })]);
      const corrected = await ticket(s, c.rows[0].r.ticket_id);
      expect(corrected).toMatchObject({ revision: 2, assignment_id: before.assignment_id, truck_id: w.f.t1, qty: "21.500", review_reasons: [] });
    });
  });

  it("a load or order with live tickets cannot be canceled until the tickets are voided", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const r = await submit(s, w.payload);
      expect((await pgError(s.query("select public.cancel_order_load($1, 'oops')", [w.load.load_id]))).message).toMatch(/has delivery tickets/);
      expect((await pgError(s.query("select public.set_order_status($1, 'canceled', 'Customer canceled')", [w.order.id]))).message).toMatch(/has delivery tickets/);
      await s.query("select public.review_delivery_ticket($1, 'void', 'Entered on the wrong order')", [r.ticket_id]);
      await s.query("select public.cancel_order_load($1, 'Not delivered')", [w.load.load_id]);
    });
  });
});

describe("permissions and isolation", () => {
  it("applies the role conventions and blocks direct writes", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const r = await submit(s, w.payload);
      expect((await pgError(s.query("update public.delivery_tickets set notes = 'x' where id = $1", [r.ticket_id]))).code).toBe("42501");
      expect((await pgError(s.query("insert into public.delivery_ticket_events (company_id, ticket_id, ticket_number, action, to_status) values ($1, $2, 'X', 'accepted', 'accepted')", [TOP_LINE, r.ticket_id]))).code).toBe("42501");
      for (const role of ["mechanic", "driver", null] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await pgError(submit(s, { ...w.payload, submission_key: randomUUID() }))).code, String(role)).toBe("42501");
        expect((await pgError(s.query("select public.review_delivery_ticket($1, 'void', 'x')", [r.ticket_id]))).code, String(role)).toBe("42501");
        expect((await s.query("select id from public.delivery_tickets")).rowCount, String(role)).toBe(0);
      }
    });
  });

  it("another company cannot see, submit against, review or correct Top Line tickets, or reference Top Line records", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const r = await submit(s, w.payload);

      const B = await s.createCompany("Brookside Aggregates (test)");
      const bOwner = await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      expect((await s.query("select id from public.delivery_tickets where id = $1", [r.ticket_id])).rowCount).toBe(0);
      expect((await s.query("select id from public.delivery_ticket_events where ticket_id = $1", [r.ticket_id])).rowCount).toBe(0);
      expect((await pgError(submit(s, { ...w.payload, external_reference: "B-1" }))).message).toMatch(/Load not found/);
      expect((await pgError(s.query("select public.review_delivery_ticket($1, 'void', 'hijack')", [r.ticket_id]))).message).toMatch(/Ticket not found/);
      expect((await pgError(s.query("select public.correct_delivery_ticket($1, $2::jsonb, 'hijack')", [r.ticket_id, JSON.stringify(w.payload)]))).message).toMatch(/Ticket not found/);

      // B's own load cannot reference Top Line's order line, truck or driver.
      const bTruck = await insert(s, "trucks", { unit_number: "B1", truck_type: "tri_axle_dump" });
      const bDriver = await insert(s, "drivers", { name: "B driver" });
      await insert(s, "driver_qualifications", { driver_id: bDriver, kind: "cdl", cdl_class: "A", expires_on: addDays(w.today, 400), verified_at: new Date().toISOString() });
      await insert(s, "driver_qualifications", { driver_id: bDriver, kind: "medical_card", expires_on: addDays(w.today, 400), verified_at: new Date().toISOString() });
      const bCustomer = await insert(s, "customers", { name: "Riverbend Builders (test)" });
      const bo = await s.query<{ r: { order_id: string } }>("select public.save_order_draft($1::jsonb) as r", [
        JSON.stringify({ customer_id: bCustomer, order_date: w.yesterday, lines: [{ kind: "other", calc_method: "per_unit", description: "Hauling", unit_code: "ton", quantity: "10", unit_rate_cents: 1000 }] }),
      ]);
      const bOrder = bo.rows[0].r.order_id;
      await s.query("select public.set_order_status($1, 'confirmed', '')", [bOrder]);
      await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [bOrder, JSON.stringify({ scheduled_start: w.yesterday })]);
      await s.query("select public.set_order_status($1, 'scheduled', '')", [bOrder]);
      const bLoad = await planLoad(s, bOrder, w.yesterday, "07:00", "08:00");
      await assign(s, bLoad.load_id, bTruck, null, bDriver);
      const bLine = (await s.query<{ id: string }>("select id from public.order_lines where order_id = $1", [bOrder])).rows[0].id;
      const bPayload = { ...w.payload, load_id: bLoad.load_id, order_line_id: bLine, external_reference: "B-1" };
      expect((await pgError(submit(s, { ...bPayload, order_line_id: w.order.materialLine }))).message).toMatch(/Choose the order line/);
      expect((await pgError(submit(s, { ...bPayload, truck_id: w.f.t1 }))).message).toMatch(/Truck not found/);
      expect((await pgError(submit(s, { ...bPayload, driver_id: w.f.d1 }))).message).toMatch(/Driver not found/);
      // B's own ticket works and is numbered in B's sequence.
      const own = await submit(s, bPayload);
      expect(own.ticket_number).toMatch(/^T-\d{4}-00001$/);

      await s.asAdmin();
      expect((await s.query("select status from public.delivery_tickets where id = $1", [r.ticket_id])).rows[0].status).toBe("submitted");
    });
  });
});

describe("ticket numbers under concurrency", () => {
  it("two simultaneous submissions get distinct, consecutive numbers", async () => {
    const setup = await pool.connect();
    const ids: { office?: string; orders: string[]; loads: string[]; lines: string[]; trucks: string[] } = { orders: [], loads: [], lines: [], trucks: [] };
    let yesterday = "";
    try {
      await setup.query("begin");
      const s: Session = {
        client: setup,
        as: async (uid) => {
          await setup.query("reset role");
          await setup.query("set local role authenticated");
          await setup.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
        },
        asAdmin: async () => {
          await setup.query("reset role");
        },
        query: (sql, params) => setup.query(sql, params as unknown[]),
        createCompany: async () => {
          throw new Error("not used");
        },
        createUser: async (role) => {
          await setup.query("reset role");
          const id = (await setup.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;
          await setup.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, `race-${id.slice(0, 8)}@test.example`]);
          await setup.query("insert into public.company_memberships (company_id, user_id, role) values ($1, $2, $3)", [TOP_LINE, id, role]);
          return id;
        },
      };
      const today = await businessToday(s);
      yesterday = addDays(today, -1);
      ids.office = await s.createUser("office");
      const f = await fleet(s, ids.office, yesterday);
      ids.trucks.push(f.t1, f.t2);
      const order = await scheduledOrder(s, ids.office, yesterday, null, yesterday);
      ids.orders.push(order.id);
      for (const [truck, driver, start] of [[f.t1, f.d1, "07:00"], [f.t2, f.d2, "07:00"]] as const) {
        const l = await planLoad(s, order.id, yesterday, start, "09:00");
        await assign(s, l.load_id, truck, null, driver);
        ids.loads.push(l.load_id);
      }
      ids.lines.push(order.materialLine);
      await setup.query("commit");
    } finally {
      setup.release();
    }

    const a = await pool.connect();
    const b = await pool.connect();
    const as = async (c: typeof a) => {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.office, role: "authenticated" })]);
    };
    const payload = (load: string, ref: string) =>
      JSON.stringify({ load_id: load, order_line_id: ids.lines[0], delivered_date: yesterday, delivered_time: "08:00", quantity: "20", unit_code: "ton", external_reference: ref });
    try {
      await as(a);
      await as(b);
      const ra = await a.query("select public.submit_delivery_ticket($1::jsonb) as r", [payload(ids.loads[0], `RACE-A-${randomUUID().slice(0, 6)}`)]);
      const pb = b.query("select public.submit_delivery_ticket($1::jsonb) as r", [payload(ids.loads[1], `RACE-B-${randomUUID().slice(0, 6)}`)]);
      await new Promise((r) => setTimeout(r, 300)); // b waits for the number allocation lock
      await a.query("commit");
      const rb = await pb;
      await b.query("commit");
      const na = ra.rows[0].r.ticket_number as string;
      const nb = rb.rows[0].r.ticket_number as string;
      expect(na).not.toBe(nb);
      expect(Number(nb.slice(-5)) - Number(na.slice(-5))).toBe(1);
    } finally {
      a.release();
      b.release();
      const c = await pool.connect();
      await c.query("begin");
      await c.query("select set_config('tlt.sample_purge', 'on', true)");
      await c.query("delete from public.orders where id = any($1)", [ids.orders]);
      await c.query("delete from public.driver_qualifications where driver_id in (select id from public.drivers where created_by = $1)", [ids.office]);
      await c.query("delete from public.drivers where created_by = $1", [ids.office]);
      await c.query("delete from public.trucks where id = any($1)", [ids.trucks]);
      await c.query("commit");
      c.release();
    }
  });
});

describe("rule parity", () => {
  it("the app and database agree on whole-number units and know every review reason", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const units = (await s.query<{ code: string; whole: boolean }>("select code, private.unit_requires_whole(code) as whole from public.units_of_measure where company_id = $1", [TOP_LINE])).rows;
      for (const u of units) expect(unitRequiresWhole(u.code), u.code).toBe(u.whole);
      const src = (await s.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'prepare_ticket'")).rows[0].src;
      const codes = [...src.matchAll(/v_reasons \|\| '([a-z_]+)'::text/g)].map((m) => m[1]);
      expect(codes.length).toBeGreaterThan(0);
      for (const c of codes) expect(REVIEW_REASON_LABELS[c], c).toBeTruthy();
    });
  });
});
