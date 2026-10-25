// Shift scheduling and the dispatch shift check (20261120003300): weekly patterns, rotations, overnight shifts,
// one-day changes, who may change them, company isolation, and dispatch assigning outside a shift only with a reason.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
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

async function businessToday(s: Session) {
  await s.asAdmin();
  return (await s.query<{ d: string }>("select private.business_today($1)::text as d", [TOP_LINE])).rows[0].d;
}

/** The Monday on or after a date. */
function nextMonday(d: string) {
  const day = new Date(`${d}T12:00:00Z`).getUTCDay();
  return addDays(d, (8 - day) % 7 || 7);
}

type Day = { work_date: string; status: string; start_time: string | null; end_time: string | null; overnight: boolean; source: string | null };
async function range(s: Session, employee: string, from: string, days: number) {
  const r = await s.query<Day>("select work_date::text, status, start_time::text, end_time::text, overnight, source from public.schedule_range($1, $2) where employee_id = $3", [from, days, employee]);
  return r.rows;
}

describe("shift schedules", () => {
  it("weekly patterns, rotations, overnight shifts and one-day changes; history is kept", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const mon = nextMonday(today);
      const office = await s.createUser("office");
      await s.as(office);
      const emp = await insert(s, "employees", { full_name: "Shift Test Person", department: "operations" });

      // Weekly: Mon–Fri 6:00–16:30 with a 30-minute break.
      const weekdays = [0, 1, 2, 3, 4].map((day) => ({ day, start: "06:00", end: "16:30", break: 30 }));
      await s.query("select public.schedule_set_pattern($1, 'weekly', 7, null, $2, $3::jsonb, 'Day crew')", [emp, mon, JSON.stringify(weekdays)]);
      let week = await range(s, emp, mon, 7);
      expect(week.map((d) => d.status)).toEqual(["shift", "shift", "shift", "shift", "shift", "off", "off"]);
      expect(week[0]).toMatchObject({ start_time: "06:00:00", end_time: "16:30:00", overnight: false, source: "pattern" });
      // Before the pattern starts there is no schedule.
      expect((await range(s, emp, addDays(mon, -1), 1))[0].status).toBe("none");

      // A one-day change: Tuesday off, Saturday a short shift; clearing Tuesday restores the pattern.
      await s.query("select public.schedule_set_day($1, $2, 'off', null, null, 0, 'Dentist')", [emp, addDays(mon, 1)]);
      await s.query("select public.schedule_set_day($1, $2, 'shift', '07:00', '12:00', 0, 'Plant open Saturday')", [emp, addDays(mon, 5)]);
      week = await range(s, emp, mon, 7);
      expect(week[1]).toMatchObject({ status: "off", source: "change" });
      expect(week[5]).toMatchObject({ status: "shift", start_time: "07:00:00", source: "change" });
      await s.query("select public.schedule_clear_day($1, $2)", [emp, addDays(mon, 1)]);
      expect((await range(s, emp, addDays(mon, 1), 1))[0]).toMatchObject({ status: "shift", source: "pattern" });

      // From the next week: a 4 on / 4 off night rotation (20:00–06:00, overnight). The weekly pattern ends the day before.
      const nights = [0, 1, 2, 3].map((day) => ({ day, start: "20:00", end: "06:00" }));
      await s.query("select public.schedule_set_pattern($1, 'rotation', 8, $2, $2, $3::jsonb, 'Night rotation')", [emp, addDays(mon, 7), JSON.stringify(nights)]);
      const rot = await range(s, emp, addDays(mon, 7), 9);
      expect(rot.map((d) => d.status)).toEqual(["shift", "shift", "shift", "shift", "off", "off", "off", "off", "shift"]);
      expect(rot[0]).toMatchObject({ start_time: "20:00:00", end_time: "06:00:00", overnight: true });
      // The first week keeps its weekly pattern (history).
      expect((await range(s, emp, mon, 1))[0]).toMatchObject({ status: "shift", start_time: "06:00:00" });
      await s.asAdmin();
      const patterns = await s.query<{ kind: string; effective_to: string | null }>("select kind, effective_to::text from public.shift_patterns where employee_id = $1 order by effective_from", [emp]);
      expect(patterns.rows).toEqual([{ kind: "weekly", effective_to: addDays(mon, 6) }, { kind: "rotation", effective_to: null }]);
      const events = await s.query<{ kind: string }>("select kind from public.schedule_events where employee_id = $1 order by id", [emp]);
      expect(events.rows.map((e) => e.kind)).toEqual(["pattern_set", "day_set", "day_set", "day_cleared", "pattern_set"]);

      // Invalid input is refused with a plain message.
      await s.as(office);
      expect((await pgError(s.query("select public.schedule_set_day($1, $2, 'shift', '08:00', '08:00', 0, '')", [emp, mon]))).message).toMatch(/start and an end/);
      expect((await pgError(s.query("select public.schedule_set_pattern($1, 'rotation', 3, $2, $2, $3::jsonb, '')", [emp, mon, JSON.stringify([{ day: 5, start: "06:00", end: "10:00" }])]))).message).toMatch(/outside the pattern/);
    });
  });

  it("owner, office and dispatch change schedules; others only see their own; other companies see nothing", async () => {
    await withSession(async (s) => {
      const mon = nextMonday(await businessToday(s));
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const driverUser = await s.createUser("driver");
      await s.as(owner);
      const mine = await insert(s, "employees", { full_name: "Driver With Login", department: "operations", user_id: driverUser });
      const other = await insert(s, "employees", { full_name: "Someone Else", department: "operations" });
      const day = JSON.stringify([{ day: 0, start: "06:00", end: "14:00" }]);
      await s.query("select public.schedule_set_pattern($1, 'weekly', 7, null, $2, $3::jsonb, '')", [mine, mon, day]);
      await s.as(dispatcher);
      await s.query("select public.schedule_set_pattern($1, 'weekly', 7, null, $2, $3::jsonb, '')", [other, mon, day]);

      // A driver sees only their own schedule and cannot change it.
      await s.as(driverUser);
      const seen = await s.query<{ employee_id: string }>("select distinct employee_id from public.schedule_range($1, 1)", [mon]);
      expect(seen.rows.map((r) => r.employee_id)).toEqual([mine]);
      expect((await pgError(s.query("select public.schedule_set_day($1, $2, 'off', null, null, 0, '')", [mine, mon]))).code).toBe("42501");
      expect((await s.query("select 1 from public.shift_patterns where employee_id = $1", [other])).rowCount).toBe(0);
      // Direct writes are not possible for anyone.
      await s.as(owner);
      expect((await pgError(s.query("insert into public.shift_changes (employee_id, work_date, kind) values ($1, $2, 'off')", [mine, mon]))).code).toBe("42501");

      // Another company's owner sees none of it and cannot change it.
      const otherCompany = await s.createCompany("Shift Other Co (test)");
      const outsider = await s.createUser("owner", { companyId: otherCompany });
      await s.asAdmin();
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [otherCompany, outsider]);
      await s.as(outsider);
      expect((await s.query("select 1 from public.schedule_range($1, 7) where employee_id = any($2::uuid[])", [mon, [mine, other]])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.schedule_set_day($1, $2, 'off', null, null, 0, '')", [mine, mon]))).message).toMatch(/not found/);
    });
  });
});

describe("dispatch shift check", () => {
  it("an off-shift driver is refused with the reason; a written reason assigns and is recorded; no schedule is not checked", async () => {
    await withSession(async (s) => {
      const on = nextMonday(addDays(await businessToday(s), 3));
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(office);
      const r = await s.query<{ r: { order_id: string } }>("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
        site_line1: "100 Shift Test Rd (test)", customer_id: ids.customerId,
        lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel", unit_code: "ton", quantity: "40", unit_rate_cents: 1000 }],
      })]);
      const order = r.rows[0].r.order_id;
      await s.query("select public.set_order_status($1, 'confirmed', '')", [order]);
      await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [order, JSON.stringify({ scheduled_start: on, scheduled_end: on, window_start: "05:00", window_end: "22:00" })]);
      await s.query("select public.set_order_status($1, 'scheduled', '')", [order]);
      const load = async (start: string, end: string) =>
        (await s.query<{ r: { load_id: string } }>("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: order, load_date: on, start_time: start, end_time: end })])).rows[0].r.load_id;
      const early = await load("05:00", "06:00");
      const inside = await load("08:00", "10:00");
      const unscheduled = await load("19:00", "20:00");

      const verified = new Date().toISOString();
      const truck = async () => insert(s, "trucks", { unit_number: `SH-${Math.random().toString(36).slice(2, 7)}`, truck_type: "tri_axle_dump", weight_capacity: "22", weight_unit: "ton", capacity_verified_at: verified });
      const driver = async (name: string) => {
        const d = await insert(s, "drivers", { name });
        await insert(s, "driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: addDays(on, 500), verified_at: verified });
        await insert(s, "driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: addDays(on, 500), verified_at: verified });
        return d;
      };
      const scheduled = await driver("Scheduled Driver");
      const free = await driver("No Schedule Driver");
      const emp = await insert(s, "employees", { full_name: "Scheduled Driver", department: "operations", driver_id: scheduled });
      await s.query("select public.schedule_set_pattern($1, 'weekly', 7, null, $2, $3::jsonb, '')", [emp, on, JSON.stringify([{ day: 0, start: "06:00", end: "16:30" }])]);
      const [t1, t2, t3] = [await truck(), await truck(), await truck()];

      await s.as(dispatcher);
      // Inside the shift: assigned as usual.
      const ok = await s.query<{ r: { warnings: string[] } }>("select public.assign_load($1, $2, null, $3, '', null) as r", [inside, t1, scheduled]);
      expect(ok.rows[0].r.warnings).not.toContain("driver_off_shift");
      // Before the shift starts: refused with the shift shown.
      const refused = await pgError(s.query("select public.assign_load($1, $2, null, $3, '', null)", [early, t2, scheduled]));
      expect(refused.message).toMatch(/Not on shift: works 6:00 AM–4:30 PM/);
      // With a reason it is assigned, flagged and recorded.
      expect((await pgError(s.query("select public.assign_load_off_shift($1, $2, null, $3, '', null, 'x')", [early, t2, scheduled]))).message).toMatch(/Say why/);
      const over = await s.query<{ r: { assignment_id: string; warnings: string[] } }>("select public.assign_load_off_shift($1, $2, null, $3, '', null, 'Plant opens early for this pour') as r", [early, t2, scheduled]);
      expect(over.rows[0].r.warnings).toContain("driver_off_shift");
      const rec = await s.query<{ problem: string; reason: string }>("select problem, reason from public.assignment_shift_overrides where assignment_id = $1", [over.rows[0].r.assignment_id]);
      expect(rec.rows[0]).toMatchObject({ reason: "Plant opens early for this pour" });
      expect(rec.rows[0].problem).toMatch(/Not on shift/);
      // A driver without any schedule is not checked.
      await s.query("select public.assign_load($1, $2, null, $3, '', null)", [unscheduled, t3, free]);

      // A day off is refused too.
      await s.as(office);
      const tue = await (async () => {
        await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [order, JSON.stringify({ scheduled_start: on, scheduled_end: addDays(on, 1), window_start: "05:00", window_end: "22:00" })]);
        return (await s.query<{ r: { load_id: string } }>("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: order, load_date: addDays(on, 1), start_time: "08:00", end_time: "09:00" })])).rows[0].r.load_id;
      })();
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.assign_load($1, $2, null, $3, '', null)", [tue, await (async () => { await s.as(office); const t = await truck(); await s.as(dispatcher); return t; })(), scheduled]))).message).toMatch(/Day off/);
    });
  });
});
