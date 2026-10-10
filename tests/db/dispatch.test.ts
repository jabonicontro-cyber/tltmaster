// Dispatch: loads, assignments, eligibility enforcement, double-booking
// (including concurrent requests), history, permissions and company isolation.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { ELIGIBILITY_MESSAGES } from "@/lib/fleet/eligibility";
import { pgError, pool, sampleIds, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;

async function insert(s: Session, table: string, row: Row) {
  const cols = Object.keys(row);
  const res = await s.query<{ id: string }>(
    `insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return res.rows[0].id;
}

async function today(s: Session) {
  await s.asAdmin();
  return (await s.query<{ d: string }>("select private.business_today($1)::text as d", [TOP_LINE])).rows[0].d;
}

/** A Scheduled direct order for the sample customer on `date` (through `end`). */
async function scheduledOrder(s: Session, user: string, date: string, end: string | null = null) {
  const ids = await sampleIds(s);
  await s.as(user);
  const r = await s.query<{ r: { order_id: string; order_number: string } }>("select public.save_order_draft($1::jsonb) as r", [
    JSON.stringify({
      customer_id: ids.customerId,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel", unit_code: "ton", quantity: "40", unit_rate_cents: 1000 }],
    }),
  ]);
  const id = r.rows[0].r.order_id;
  await s.query("select public.set_order_status($1, 'confirmed', '')", [id]);
  await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [id, JSON.stringify({ scheduled_start: date, scheduled_end: end, window_start: "07:00", window_end: "15:00" })]);
  await s.query("select public.set_order_status($1, 'scheduled', '')", [id]);
  return { id, number: r.rows[0].r.order_number };
}

async function planLoad(s: Session, orderId: string, date: string, start: string, end: string, extra: Row = {}) {
  const r = await s.query<{ r: { load_id: string; load_number: number } }>("select public.save_order_load($1::jsonb) as r", [
    JSON.stringify({ order_id: orderId, load_date: date, start_time: start, end_time: end, ...extra }),
  ]);
  return r.rows[0].r;
}

async function assign(s: Session, loadId: string, truck: string | null, trailer: string | null, driver: string | null, replace: string | null = null, note = "") {
  const r = await s.query<{ r: { assignment_id: string; warnings: string[] } }>("select public.assign_load($1, $2, $3, $4, $5, $6) as r", [loadId, truck, trailer, driver, note, replace]);
  return r.rows[0].r;
}

/** A ready fleet: two dump trucks, a tractor, a trailer for tractors, three fully qualified drivers. */
async function fleet(s: Session, user: string, on: string) {
  await s.as(user);
  const verified = new Date().toISOString();
  const far = addDays(on, 500);
  const t1 = await insert(s, "trucks", { unit_number: `D1-${Math.random().toString(36).slice(2, 6)}`, truck_type: "tri_axle_dump" });
  const t2 = await insert(s, "trucks", { unit_number: `D2-${Math.random().toString(36).slice(2, 6)}`, truck_type: "tri_axle_dump", weight_capacity: "22", weight_unit: "ton", capacity_verified_at: verified });
  const tractor = await insert(s, "trucks", { unit_number: `TR-${Math.random().toString(36).slice(2, 6)}`, truck_type: "tractor" });
  const trailer = await insert(s, "trailers", { unit_number: `RL-${Math.random().toString(36).slice(2, 6)}`, trailer_type: "end_dump", compatible_truck_types: "{tractor}" });
  const drivers: string[] = [];
  for (const n of ["A", "B", "C"]) {
    const d = await insert(s, "drivers", { name: `Driver ${n}` });
    await insert(s, "driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified });
    await insert(s, "driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: far, verified_at: verified });
    drivers.push(d);
  }
  return { t1, t2, tractor, trailer, d1: drivers[0], d2: drivers[1], d3: drivers[2] };
}

describe("loads", () => {
  it("plans numbered loads with explicit times in the company's timezone, within the order's schedule", async () => {
    await withSession(async (s) => {
      const on = addDays(await today(s), 5);
      const office = await s.createUser("office");
      const order = await scheduledOrder(s, office, on, addDays(on, 1));
      const l1 = await planLoad(s, order.id, on, "07:00", "09:30", { planned_quantity: "22", unit_code: "ton", notes: "First load" });
      const l2 = await planLoad(s, order.id, addDays(on, 1), "07:00", "09:30");
      expect([l1.load_number, l2.load_number]).toEqual([1, 2]);
      await s.asAdmin();
      const row = (await s.query("select starts_at at time zone 'America/Chicago' as local, planned_quantity, unit_code from public.order_loads where id = $1", [l1.load_id])).rows[0];
      expect(row.local.toISOString().slice(11, 16)).toBe("07:00");
      expect(row).toMatchObject({ planned_quantity: "22.000", unit_code: "ton" });

      await s.as(office);
      const cases: Array<[Row, RegExp]> = [
        [{ load_date: addDays(on, 2), start_time: "07:00", end_time: "08:00" }, /within the order's scheduled dates/],
        [{ load_date: on, start_time: "09:00", end_time: "08:00" }, /must end after it starts/],
        [{ load_date: on, start_time: "09:00", end_time: "10:00", planned_quantity: "5" }, /quantity and its unit/],
        [{ load_date: on, start_time: "09:00", end_time: "10:00", planned_quantity: "5", unit_code: "parsec" }, /valid unit/],
        [{ load_date: on, start_time: "", end_time: "10:00" }, /date, start time and end time/],
      ];
      for (const [p, m] of cases) {
        expect((await pgError(s.query("select public.save_order_load($1::jsonb)", [JSON.stringify({ order_id: order.id, ...p })]))).message).toMatch(m);
      }
      // Orders that are not scheduled cannot be planned.
      await s.query("select public.set_order_status($1, 'on_hold', 'Weather')", [order.id]);
      expect((await pgError(planLoad(s, order.id, on, "10:00", "11:00"))).message).toMatch(/Mark it scheduled/);
      await s.asAdmin();
      const audit = await s.query("select action from public.audit_events where entity_id = $1 and action like 'dispatch.%'", [order.id]);
      expect(audit.rows.map((a) => a.action).filter((a) => a === "dispatch.load_planned")).toHaveLength(2);
    });
  });
});

describe("assignments", () => {
  it("assigns, records warnings and history, and enforces eligibility", async () => {
    await withSession(async (s) => {
      const on = addDays(await today(s), 5);
      const office = await s.createUser("office");
      const f = await fleet(s, office, on);
      const order = await scheduledOrder(s, office, on);
      const load = await planLoad(s, order.id, on, "07:00", "11:00");

      const a = await assign(s, load.load_id, f.t1, null, f.d1);
      expect(a.warnings).toEqual(["truck_capacity_unknown"]);
      await s.asAdmin();
      const row = (await s.query("select status, order_id, warnings, created_by from public.dispatch_assignments where id = $1", [a.assignment_id])).rows[0];
      expect(row).toEqual({ status: "active", order_id: order.id, warnings: ["truck_capacity_unknown"], created_by: office });
      const audit = (await s.query("select action, summary from public.audit_events where entity_id = $1 and action = 'dispatch.assigned'", [order.id])).rows[0];
      expect(audit.summary).toMatch(/load 1 assigned: truck D1-.*driver Driver A/);

      // Unavailable resources are refused with the eligibility reason.
      await s.as(office);
      const load2 = await planLoad(s, order.id, on, "12:00", "14:00");
      await s.query("select public.set_equipment_service_status('truck', $1, 'out_of_service', 'Brakes')", [f.t2]);
      expect((await pgError(assign(s, load2.load_id, f.t2, null, f.d2))).message).toMatch(/^Not eligible on .*: Truck is out of service\.$/);
      expect((await pgError(assign(s, load2.load_id, f.tractor, null, f.d2))).message).toMatch(/A tractor needs a trailer/);
      expect((await pgError(assign(s, load2.load_id, f.t1, f.trailer, f.d2))).message).toMatch(/not recorded as compatible/);
      await s.query("update public.driver_qualifications set expires_on = $2, verified_at = now() where driver_id = $1 and kind = 'cdl'", [f.d3, addDays(on, -1)]);
      expect((await pgError(assign(s, load2.load_id, f.t1, null, f.d3))).message).toMatch(/CDL has expired/);
      await s.query("update public.drivers set active = false where id = $1", [f.d2]);
      expect((await pgError(assign(s, load2.load_id, f.t1, null, f.d2))).message).toMatch(/Driver is inactive/);
      // Tractor + compatible trailer + class A driver is fine.
      const ok = await assign(s, load2.load_id, f.tractor, f.trailer, f.d1);
      expect(ok.assignment_id).toBeTruthy();
    });
  });

  it("refuses overlapping bookings of the same truck, trailer or driver, naming the conflict; back-to-back is allowed", async () => {
    await withSession(async (s) => {
      const on = addDays(await today(s), 5);
      const office = await s.createUser("office");
      const f = await fleet(s, office, on);
      const o1 = await scheduledOrder(s, office, on);
      const o2 = await scheduledOrder(s, office, on);
      const a = await planLoad(s, o1.id, on, "07:00", "11:00");
      const b = await planLoad(s, o2.id, on, "10:00", "12:00");
      const c = await planLoad(s, o2.id, on, "11:00", "13:00");
      await assign(s, a.load_id, f.tractor, f.trailer, f.d1);

      await s.as(office);
      const trailer2 = await insert(s, "trailers", { unit_number: "RL-2", trailer_type: "end_dump", compatible_truck_types: "{tractor}" });
      const truckErr = await pgError(assign(s, b.load_id, f.tractor, trailer2, f.d2));
      expect(truckErr.message).toMatch(new RegExp(`^Truck TR-\\w+ is already assigned to ${o1.number} load 1 from 7:00 AM to 11:00 AM\\.$`));
      await s.as(office);
      const otherTractor = await insert(s, "trucks", { unit_number: "TR-X", truck_type: "tractor" });
      expect((await pgError(assign(s, b.load_id, otherTractor, f.trailer, f.d2))).message).toMatch(/^Trailer RL-\w+ is already assigned/);
      expect((await pgError(assign(s, b.load_id, f.t1, null, f.d1))).message).toMatch(/^Driver A is already assigned/);
      // Back-to-back: 11:00 start after an 11:00 end.
      await assign(s, c.load_id, f.tractor, f.trailer, f.d1);
      // The database itself refuses an overlap even without the function's pre-check.
      await s.asAdmin();
      const dup = await pgError(
        s.query(
          "insert into public.dispatch_assignments (company_id, load_id, order_id, truck_id, driver_id, starts_at, ends_at) select company_id, $1, order_id, $2, $3, starts_at, ends_at from public.order_loads where id = $1",
          [b.load_id, f.tractor, f.d3],
        ),
      );
      expect(dup.code).toBe("23P01");
    });
  });

  it("reassigns with optimistic checks, keeps history, and cancels with a reason", async () => {
    await withSession(async (s) => {
      const on = addDays(await today(s), 5);
      const office = await s.createUser("office");
      const f = await fleet(s, office, on);
      const order = await scheduledOrder(s, office, on);
      const load = await planLoad(s, order.id, on, "07:00", "11:00");
      const first = await assign(s, load.load_id, f.t1, null, f.d1);

      // A stale board (not naming the current assignment) cannot overwrite it.
      expect((await pgError(assign(s, load.load_id, f.t2, null, f.d2))).code).toBe("PT409");
      expect((await pgError(assign(s, load.load_id, f.t1, null, f.d1, first.assignment_id))).message).toMatch(/already assigned to that truck/);
      const second = await assign(s, load.load_id, f.t2, null, f.d2, first.assignment_id, "Truck swap");
      // The first truck and driver are free again.
      const other = await scheduledOrder(s, office, on);
      const otherLoad = await planLoad(s, other.id, on, "08:00", "09:00");
      await assign(s, otherLoad.load_id, f.t1, null, f.d1);

      await s.asAdmin();
      const rows = (await s.query("select id, status, cancel_reason, replaces_assignment_id from public.dispatch_assignments where load_id = $1 order by created_at, status", [load.load_id])).rows;
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: first.assignment_id, status: "canceled", cancel_reason: "Reassigned: Truck swap", replaces_assignment_id: null },
          { id: second.assignment_id, status: "active", cancel_reason: "", replaces_assignment_id: first.assignment_id },
        ]),
      );
      // History cannot be rewritten or deleted, even by the database owner.
      expect((await pgError(s.query("update public.dispatch_assignments set truck_id = $2 where id = $1", [second.assignment_id, f.t1]))).code).toBe("42501");
      expect((await pgError(s.query("update public.dispatch_assignments set status = 'active', canceled_at = null, cancel_reason = '' where id = $1", [first.assignment_id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.dispatch_assignments where id = $1", [first.assignment_id]))).code).toBe("42501");

      await s.as(office);
      expect((await pgError(s.query("select public.cancel_assignment($1, '  ')", [second.assignment_id]))).message).toMatch(/reason/);
      await s.query("select public.cancel_assignment($1, 'Customer delayed')", [second.assignment_id]);
      expect((await pgError(s.query("select public.cancel_assignment($1, 'again')", [second.assignment_id]))).message).toMatch(/already canceled/);
      await s.asAdmin();
      const actions = (await s.query("select action from public.audit_events where entity_id = $1 and action like 'dispatch.%'", [order.id])).rows.map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["dispatch.assigned", "dispatch.reassigned", "dispatch.unassigned"]));
    });
  });

  it("re-checks an assigned load when its time changes; canceling a load or holding the order releases resources", async () => {
    await withSession(async (s) => {
      const on = addDays(await today(s), 5);
      const office = await s.createUser("office");
      const f = await fleet(s, office, on);
      const order = await scheduledOrder(s, office, on);
      const l1 = await planLoad(s, order.id, on, "07:00", "09:00");
      const l2 = await planLoad(s, order.id, on, "10:00", "12:00");
      const a1 = await assign(s, l1.load_id, f.t1, null, f.d1);
      await assign(s, l2.load_id, f.t1, null, f.d2);

      // Moving load 1 into load 2's time would double-book truck 1.
      const move = (start: string, end: string) =>
        s.query("select public.save_order_load($1::jsonb)", [JSON.stringify({ load_id: l1.load_id, load_date: on, start_time: start, end_time: end })]);
      expect((await pgError(move("09:30", "10:30"))).message).toMatch(/already assigned to .* load 2/);
      await move("06:00", "08:00");
      await s.asAdmin();
      const times = (await s.query("select a.starts_at = l.starts_at and a.ends_at = l.ends_at as synced from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id where a.id = $1", [a1.assignment_id])).rows[0];
      expect(times.synced).toBe(true);

      await s.as(office);
      await s.query("select public.cancel_order_load($1, 'Not needed')", [l1.load_id]);
      await s.asAdmin();
      expect((await s.query("select status, cancel_reason from public.dispatch_assignments where id = $1", [a1.assignment_id])).rows[0]).toEqual({ status: "canceled", cancel_reason: "Load canceled: Not needed" });
      await s.as(office);
      expect((await pgError(assign(s, l1.load_id, f.t2, null, f.d3))).message).toMatch(/is canceled/);

      await s.query("select public.set_order_status($1, 'on_hold', 'Site flooded')", [order.id]);
      await s.asAdmin();
      const left = await s.query("select status, cancel_reason from public.dispatch_assignments where load_id = $1", [l2.load_id]);
      expect(left.rows).toEqual([{ status: "canceled", cancel_reason: "Order put on hold" }]);
    });
  });
});

describe("permissions and isolation", () => {
  it("dispatchers and office can dispatch; mechanics, drivers and pending users cannot; clients cannot write tables", async () => {
    await withSession(async (s) => {
      const on = addDays(await today(s), 5);
      const office = await s.createUser("office");
      const f = await fleet(s, office, on);
      const order = await scheduledOrder(s, office, on);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      const load = await planLoad(s, order.id, on, "07:00", "08:00");
      const a = await assign(s, load.load_id, f.t1, null, f.d1);
      expect((await pgError(s.query("insert into public.order_loads (company_id, order_id, load_number, load_date, start_time, end_time, starts_at, ends_at) values ($1, $2, 9, $3, '07:00', '08:00', now(), now() + interval '1 hour')", [TOP_LINE, order.id, on]))).code).toBe("42501");
      expect((await pgError(s.query("update public.dispatch_assignments set note = 'x' where id = $1", [a.assignment_id]))).code).toBe("42501");
      for (const role of ["mechanic", "driver", null] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await pgError(planLoad(s, order.id, on, "09:00", "10:00"))).code, String(role)).toBe("42501");
        expect((await pgError(assign(s, load.load_id, f.t2, null, f.d2, a.assignment_id))).code, String(role)).toBe("42501");
        expect((await pgError(s.query("select public.cancel_assignment($1, 'x')", [a.assignment_id]))).code, String(role)).toBe("42501");
        expect((await s.query("select id from public.dispatch_assignments")).rowCount, String(role)).toBe(0);
      }
    });
  });

  it("another company cannot see, use or change Top Line orders, loads, assignments or fleet", async () => {
    await withSession(async (s) => {
      const on = addDays(await today(s), 5);
      const office = await s.createUser("office");
      const f = await fleet(s, office, on);
      const order = await scheduledOrder(s, office, on);
      const load = await planLoad(s, order.id, on, "07:00", "08:00");
      const a = await assign(s, load.load_id, f.t1, null, f.d1);

      const B = await s.createCompany("Brookside Aggregates (test)");
      const bOwner = await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      expect((await s.query("select id from public.order_loads where id = $1", [load.load_id])).rowCount).toBe(0);
      expect((await s.query("select id from public.dispatch_assignments where id = $1", [a.assignment_id])).rowCount).toBe(0);
      expect((await pgError(planLoad(s, order.id, on, "09:00", "10:00"))).message).toMatch(/Order not found/);
      expect((await pgError(assign(s, load.load_id, null, null, null, a.assignment_id))).message).toMatch(/Load not found/);
      expect((await pgError(s.query("select public.cancel_assignment($1, 'hijack')", [a.assignment_id]))).message).toMatch(/Assignment not found/);
      expect((await pgError(s.query("select public.cancel_order_load($1, 'hijack')", [load.load_id]))).message).toMatch(/Load not found/);

      // B's own load cannot use Top Line trucks or drivers.
      const bTruck = await insert(s, "trucks", { unit_number: "B1", truck_type: "tri_axle_dump" });
      const bDriver = await insert(s, "drivers", { name: "B driver" });
      const bCustomer = await insert(s, "customers", { name: "Riverbend Builders (test)" });
      await s.asAdmin();
      // Give B an order the quick way (as B's owner through the order functions).
      await s.as(bOwner);
      const bo = await s.query<{ r: { order_id: string } }>("select public.save_order_draft($1::jsonb) as r", [
        JSON.stringify({ customer_id: bCustomer, lines: [{ kind: "other", calc_method: "per_unit", description: "Hauling", unit_code: "each", quantity: "1", unit_rate_cents: 10000 }] }),
      ]);
      const bOrder = bo.rows[0].r.order_id;
      await s.query("select public.set_order_status($1, 'confirmed', '')", [bOrder]);
      await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [bOrder, JSON.stringify({ scheduled_start: on })]);
      await s.query("select public.set_order_status($1, 'scheduled', '')", [bOrder]);
      const bLoad = await planLoad(s, bOrder, on, "07:00", "08:00");
      expect((await pgError(assign(s, bLoad.load_id, f.t1, null, bDriver))).message).toMatch(/Truck not found/);
      expect((await pgError(assign(s, bLoad.load_id, bTruck, null, f.d1))).message).toMatch(/Driver not found/);
      expect((await pgError(assign(s, bLoad.load_id, bTruck, f.trailer, bDriver))).message).toMatch(/Trailer not found/);

      await s.asAdmin();
      expect((await s.query("select status from public.dispatch_assignments where id = $1", [a.assignment_id])).rows[0].status).toBe("active");
    });
  });
});

describe("concurrency", () => {
  it("two dispatchers booking the same truck at the same time: one succeeds, the other gets a clear conflict", async () => {
    // Committed setup (sample customer), removed at the end.
    const setup = await pool.connect();
    const on = await (async () => (await setup.query<{ d: string }>("select (private.business_today($1) + 5)::text as d", [TOP_LINE])).rows[0].d)();
    const ids: { office?: string; truck?: string; d1?: string; d2?: string; orders: string[]; loads: string[] } = { orders: [], loads: [] };
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
      ids.office = await s.createUser("office");
      const f = await fleet(s, ids.office, on);
      ids.truck = f.t1;
      ids.d1 = f.d1;
      ids.d2 = f.d2;
      for (let i = 0; i < 2; i++) {
        const o = await scheduledOrder(s, ids.office, on);
        ids.orders.push(o.id);
        ids.loads.push((await planLoad(s, o.id, on, "07:00", "11:00")).load_id);
      }
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
    try {
      await as(a);
      await as(b);
      await a.query("select public.assign_load($1, $2, null, $3, '', null)", [ids.loads[0], ids.truck, ids.d1]);
      const pb = b.query("select public.assign_load($1, $2, null, $3, '', null)", [ids.loads[1], ids.truck, ids.d2]).then(
        () => null,
        (e: { code?: string; message?: string }) => e,
      );
      await new Promise((r) => setTimeout(r, 300)); // b is now waiting on a's booking
      await a.query("commit");
      const err = await pb;
      await b.query("rollback");
      expect(err?.code).toBe("PT409");
      expect(err?.message).toMatch(/The truck was just assigned to another load at this time/);
      const n = await a.query("select count(*)::int as n from public.dispatch_assignments where truck_id = $1 and status = 'active'", [ids.truck]);
      expect(n.rows[0].n).toBe(1);
    } finally {
      a.release();
      b.release();
      const c = await pool.connect();
      await c.query("begin");
      await c.query("select set_config('tlt.sample_purge', 'on', true)");
      await c.query("delete from public.orders where id = any($1)", [ids.orders]);
      await c.query("delete from public.driver_qualifications where driver_id in (select id from public.drivers where created_by = $1)", [ids.office]);
      await c.query("delete from public.trailers where created_by = $1", [ids.office]);
      await c.query("delete from public.drivers where created_by = $1", [ids.office]);
      await c.query("delete from public.trucks where created_by = $1", [ids.office]);
      await c.query("commit");
      c.release();
    }
  });
});

describe("messages", () => {
  it("database and app describe every eligibility code the same way", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      for (const [code, text] of Object.entries(ELIGIBILITY_MESSAGES)) {
        const r = await s.query<{ m: string }>("select private.eligibility_message($1) as m", [code]);
        expect(r.rows[0].m, code).toBe(text);
      }
    });
  });
});
