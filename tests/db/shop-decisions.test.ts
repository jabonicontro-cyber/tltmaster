// Mechanic and dispatcher decisions of 2026-11-09 (master plan MD1, SEC3), 20261120015000-015500:
// 1. a job waiting for a part that has not started leaves the truck dispatchable with a warning; started or
//    safety-critical work blocks (private.assignment_eligibility, the same rule as src/lib/fleet/readiness.ts);
// 2. a wrong reading is set aside (kept, audited) and every current-reading rule uses only readings not set aside;
// 3. a certificate the shop recorded is marked as such and stays on the office's list until verified;
// 4. a truck parked by hand is offered back once its shop work is done, never returned by itself;
// 5. parts on order follow the per-person dispatch-base limits.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const tag = () => Math.random().toString(36).slice(2, 7);
const wo = (s: Session, p: Record<string, unknown>) =>
  s.query<{ r: { id: string; number: string } }>("select public.maintenance_create_work_order($1::jsonb) as r", [JSON.stringify(p)]).then((r) => r.rows[0].r);
const setStatus = (s: Session, id: string, status: string, note = "") => s.query("select public.maintenance_set_status($1, $2, $3)", [id, status, note]);
const eligibility = async (s: Session, truck: string, on: string) =>
  (await s.query<{ r: { blockers: string[]; warnings: string[] } }>("select public.check_assignment_eligibility($1, null, null, $2) as r", [truck, on])).rows[0].r;
const started = async (s: Session, id: string) =>
  (await s.query<{ work_started_at: string | null }>("select work_started_at from public.work_orders where id = $1", [id])).rows[0].work_started_at;

describe("part on order, job not started (MD1)", () => {
  it("a job waiting for a part before work starts leaves the truck dispatchable with a warning; started work blocks", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const day = addDays(today, 2);
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const f = await fleet(s, owner, day);
      const order = await scheduledOrder(s, owner, today, addDays(today, 5));
      const load = await planLoad(s, order.id, day, "08:00", "10:00");
      await s.as(owner);
      const job = await wo(s, { truck_id: f.t1, title: "Seat cushion torn" });
      await s.query("select public.part_wait_add($1, $2::jsonb)", [job.id, JSON.stringify({ description: "Seat cushion", expected_on: addDays(today, 4), set_waiting: true })]);
      expect(await started(s, job.id)).toBeNull();
      const before = await eligibility(s, f.t1, day);
      expect(before.blockers).toEqual([]);
      expect(before.warnings).toContain("truck_part_on_order");

      // The dispatch shop schedule carries the fact and the part, for dispatchers without maintenance rights too.
      await s.as(dispatcher);
      const shop = (await s.query<{ r: Array<{ work_order_id: string; work_started_at: string | null; parts: Array<{ description: string; expected_on: string }> }> }>(
        "select public.dispatch_shop_schedule($1, $1) as r", [day])).rows[0].r.find((w) => w.work_order_id === job.id);
      expect(shop).toMatchObject({ work_started_at: null, parts: [{ description: "Seat cushion", expected_on: addDays(today, 4) }] });
      // Assigning works and returns the warning.
      const a = (await s.query<{ r: { assignment_id: string; warnings: string[] } }>("select public.assign_load($1, $2, null, $3, '', null) as r", [load.load_id, f.t1, f.d1])).rows[0].r;
      expect(a.warnings).toContain("truck_part_on_order");

      // Work starts: blocked; it stays started when the job waits for parts again.
      await s.as(owner);
      await setStatus(s, job.id, "in_progress");
      expect(await started(s, job.id)).not.toBeNull();
      await setStatus(s, job.id, "awaiting_parts", "Seat cushion");
      const after = await eligibility(s, f.t1, day);
      expect(after.blockers).toEqual(["truck_shop_work_open"]);
      expect(after.warnings).not.toContain("truck_part_on_order");
      // Back to the queue and waiting again: still started (never cleared).
      await setStatus(s, job.id, "triaged");
      await setStatus(s, job.id, "awaiting_parts", "Seat cushion");
      expect(await eligibility(s, f.t1, day)).toMatchObject({ blockers: ["truck_shop_work_open"] });
      // A direct attempt to clear it (as the database owner, bypassing grants) is refused by the trigger: it stays set.
      await s.asAdmin();
      await s.query("update public.work_orders set work_started_at = null where id = $1", [job.id]);
      expect(await started(s, job.id)).not.toBeNull();
    });
  });

  it("a safety-critical job waiting for parts blocks even before work starts; time recorded marks a job started", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const f = await fleet(s, owner, today);
      await s.as(owner);
      const safety = await wo(s, { truck_id: f.t1, title: "Brake hose chafed", safety_critical: true });
      await setStatus(s, safety.id, "awaiting_parts", "Brake hose");
      expect((await eligibility(s, f.t1, addDays(today, 3))).blockers).toEqual(expect.arrayContaining(["truck_safety_restricted", "truck_shop_work_open"]));
      expect((await eligibility(s, f.t1, addDays(today, 3))).warnings).not.toContain("truck_part_on_order");

      const timed = await wo(s, { truck_id: f.t2, title: "Wiper motor" });
      await s.query("select public.maintenance_add_mechanic($1, $2, true)", [timed.id, owner]);
      await s.query("select public.maintenance_add_time($1, $2, now() - interval '3 hours', now() - interval '2 hours', 'Looked at it')", [timed.id, owner]);
      expect(await started(s, timed.id)).not.toBeNull();
      await setStatus(s, timed.id, "awaiting_parts", "Wiper motor");
      expect((await eligibility(s, f.t2, addDays(today, 3))).blockers).toEqual(["truck_shop_work_open"]);
    });
  });
});

describe("a wrong reading is set aside (MD1)", () => {
  it("keeps it, audits it, and the last good reading counts again so later correct readings are used", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const mechanic = await s.createUser("mechanic");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(owner);
      const t = await insert(s, "trucks", { unit_number: `RA-${tag()}`, truck_type: "tri_axle_dump" });
      const sched = (await s.query<{ id: string }>("select public.maintenance_save_schedule($1::jsonb) as id",
        [JSON.stringify({ truck_id: t, name: "Oil and filter", interval_miles: 15000, warn_miles: 1000, last_done_miles: 100000 })])).rows[0].id;
      const pm = async () => (await s.query<{ state: string; current_miles: string | null }>(
        "select state, current_miles::text from public.maintenance_pm_status() where schedule_id = $1", [sched])).rows[0];
      await s.query("select public.record_truck_reading($1, 108000, null, '')", [t]);
      // A typo on a fuel slip: 109,900 instead of 108,200 (within the per-day limit, so the feed would have used it).
      await s.asAdmin();
      const wrong = (await s.query<{ id: string }>(
        "insert into public.truck_readings (company_id, truck_id, odometer_miles, note, source, read_at) values ($1, $2, 109900, 'typo', 'fuel', clock_timestamp()) returning id", [TOP_LINE, t])).rows[0].id;
      await s.as(owner);
      expect(await pm()).toEqual({ state: "ok", current_miles: "109900.0" });
      // The next correct reading is "lower" and ignored.
      await s.query("select public.fuel_record_purchase($1::jsonb)", [JSON.stringify({ truck_id: t, purchased_on: today, jurisdiction: "IA", gallons: "60", total_cents: 25000, odometer: 108300 })]);
      expect((await s.query("select 1 from public.audit_events where entity_id = $1 and action = 'truck.reading_ignored'", [t])).rowCount).toBe(1);
      expect((await pgError(s.query("select public.record_truck_reading($1, 108400, null, '')", [t]))).message).toMatch(/cannot go down/);

      // Who may set it aside: maintenance.manage or fleet.edit; a reason is needed.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.truck_reading_set_aside($1, 'typo')", [wrong]))).code).toBe("42501");
      await s.as(mechanic);
      expect((await pgError(s.query("select public.truck_reading_set_aside($1, '')", [wrong]))).code).toBe("22023");
      await s.as(office);
      const after = (await s.query<{ r: { current_miles: number } }>("select public.truck_reading_set_aside($1, 'Typo on the fuel slip') as r", [wrong])).rows[0].r;
      expect(Number(after.current_miles)).toBe(108000);
      expect((await pgError(s.query("select public.truck_reading_set_aside($1, 'again')", [wrong]))).message).toMatch(/already marked wrong/);

      // Kept, with who and why; audited on the truck.
      await s.as(owner);
      const row = (await s.query<{ odometer_miles: string; set_aside_by: string; set_aside_reason: string }>(
        "select odometer_miles::text, set_aside_by, set_aside_reason from public.truck_readings where id = $1", [wrong])).rows[0];
      expect(row).toEqual({ odometer_miles: "109900.0", set_aside_by: office, set_aside_reason: "Typo on the fuel slip" });
      const audit = (await s.query<{ actor_id: string; details: { reading_id: string; current_miles: number } }>(
        "select actor_id, details from public.audit_events where entity_id = $1 and action = 'truck.reading_set_aside'", [t])).rows;
      expect(audit).toEqual([expect.objectContaining({ actor_id: office, details: expect.objectContaining({ reading_id: wrong }) })]);

      // Every current-reading rule now uses the good readings: preventive, the Preventive page's check, the feed.
      expect(await pm()).toEqual({ state: "ok", current_miles: "108000.0" });
      await s.query("select public.record_truck_reading($1, 108400, null, '')", [t]);
      await s.query("select public.fuel_record_purchase($1::jsonb)", [JSON.stringify({ truck_id: t, purchased_on: today, jurisdiction: "IA", gallons: "50", total_cents: 20000, odometer: 108500 })]);
      expect(await pm()).toEqual({ state: "ok", current_miles: "108500.0" });
      expect((await s.query("select 1 from public.audit_events where entity_id = $1 and action = 'truck.reading_ignored'", [t])).rowCount).toBe(1);
      // A preventive job completed now stores the good reading, not the wrong one.
      const job = await wo(s, { truck_id: t, title: "Oil change", category: "preventive" });
      await s.asAdmin();
      await s.query("update public.work_orders set schedule_id = $2 where id = $1", [job.id, sched]); // as "Create due work" links it
      await s.as(owner);
      await setStatus(s, job.id, "in_progress");
      await setStatus(s, job.id, "completed");
      expect((await s.query<{ m: string }>("select last_done_miles::text as m from public.maintenance_schedules where id = $1", [sched])).rows[0].m).toBe("108500.0");

      // Another company cannot touch it.
      const other = await s.createCompany(`Other ${tag()}`);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      const good = (await s.query<{ id: string }>("select id from public.truck_readings where truck_id = $1 and set_aside_at is null limit 1", [t]));
      expect(good.rowCount).toBe(0);
      await s.asAdmin();
      const goodId = (await s.query<{ id: string }>("select id from public.truck_readings where truck_id = $1 and set_aside_at is null limit 1", [t])).rows[0].id;
      await s.as(outsider);
      expect((await pgError(s.query("select public.truck_reading_set_aside($1, 'not mine')", [goodId]))).code).toBe("P0002");
    });
  });
});

describe("the current reading is the highest reading not set aside (MD1, 20261120015600)", () => {
  it("an older higher reading counts over a newer lower one until it is set aside, in every rule", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const t = await insert(s, "trucks", { unit_number: `HG-${tag()}`, truck_type: "tri_axle_dump" });
      const sched = (await s.query<{ id: string }>("select public.maintenance_save_schedule($1::jsonb) as id",
        [JSON.stringify({ truck_id: t, name: "Oil and filter", interval_miles: 15000, warn_miles: 1000, last_done_miles: 100000 })])).rows[0].id;
      const pm = async () => (await s.query<{ current_miles: string | null }>(
        "select current_miles::text from public.maintenance_pm_status() where schedule_id = $1", [sched])).rows[0].current_miles;
      // Records from before readings were checked: 120,000 five days ago (a typo), then 110,000 today.
      await s.asAdmin();
      const high = (await s.query<{ id: string }>(
        "insert into public.truck_readings (company_id, truck_id, odometer_miles, note, source, read_at) values ($1, $2, 120000, 'old typo', 'manual', now() - interval '5 days') returning id", [TOP_LINE, t])).rows[0].id;
      await s.query("insert into public.truck_readings (company_id, truck_id, odometer_miles, note, source, read_at) values ($1, $2, 110000, 'later', 'manual', now())", [TOP_LINE, t]);
      await s.as(owner);
      // Preventive, the Preventive page's check and the feed all take the highest one.
      expect(await pm()).toBe("120000.0");
      expect((await pgError(s.query("select public.record_truck_reading($1, 115000, null, '')", [t]))).message).toMatch(/cannot go down: the last reading was 120000/);
      // Set aside: the highest good reading (110,000) counts and the next correct reading is used.
      await s.query("select public.truck_reading_set_aside($1, 'Typo from an old record')", [high]);
      expect(await pm()).toBe("110000.0");
      await s.query("select public.record_truck_reading($1, 115000, null, '')", [t]);
      expect(await pm()).toBe("115000.0");
    });
  });
});

describe("an inspection certificate from the shop is checked by the office (MD1)", () => {
  it("gives the office (fleet.edit) a to-do alert that stays open until the certificate is checked", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`Certificates ${tag()}`);
      const owner = await s.createUser("owner", { companyId: c });
      const office = await s.createUser("office", { companyId: c });
      const mechanic = await s.createUser("mechanic", { companyId: c });
      const dispatcher = await s.createUser("dispatcher", { companyId: c });
      const today = await businessToday(s);
      await s.as(owner);
      const t = await insert(s, "trucks", { unit_number: `CA-${tag()}`, truck_type: "tri_axle_dump" });
      await s.as(mechanic);
      const job = await wo(s, { truck_id: t, title: "Annual DOT inspection", category: "inspection" });
      await setStatus(s, job.id, "in_progress");
      await setStatus(s, job.id, "completed");
      const record = () => s.query<{ id: string }>("select public.maintenance_record_inspection($1, $2::jsonb) as id",
        [job.id, JSON.stringify({ inspected_on: today, expires_on: addDays(today, 365), inspector: "Pat Inspector" })]).then((r) => r.rows[0].id);
      const doc = await record();
      const alerts = async () => {
        await s.asAdmin();
        return (await s.query<{ id: string; status: string; priority: string; link: string; title: string; to: string[] }>(
          `select a.id, a.status, a.priority, a.link, a.title, array(select r.user_id::text from public.alert_recipients r where r.alert_id = a.id order by 1) as to
           from public.alerts a where a.company_id = $1 and a.event_type = 'documents.certificate_check' and a.source_key = $2 order by a.created_at`, [c, doc])).rows;
      };
      const [open] = await alerts();
      expect(open).toMatchObject({ status: "open", priority: "action_required", link: `/fleet/trucks/${t}` });
      expect(open.title).toMatch(/^Check the inspection certificate of truck CA-/);
      // The fleet.edit people (owner, office); not the mechanic who recorded it, nor dispatch.
      expect(open.to).toEqual([owner, office].sort());
      expect(open.to).not.toContain(mechanic);
      expect(open.to).not.toContain(dispatcher);

      // Acknowledging is not resolving: it stays open until the certificate is checked.
      await s.as(office);
      await s.query("select public.comm_alert_acknowledge($1, '')", [open.id]);
      expect((await alerts())[0].status).toBe("open");
      // Another company sees neither the alert nor the certificate.
      const other = await s.createCompany(`Other ${tag()}`);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await s.query("select 1 from public.alerts where id = $1", [open.id])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.verify_vehicle_document($1)", [doc]))).message).toMatch(/not found/i);
      await s.as(office);
      await s.query("select public.verify_vehicle_document($1)", [doc]);
      expect((await alerts()).map((a) => a.status)).toEqual(["resolved"]);

      // Recorded again from the work order: it needs a check again, with a new to-do.
      await s.as(mechanic);
      expect(await record()).toBe(doc);
      expect((await alerts()).map((a) => a.status)).toEqual(["resolved", "open"]);
      // Archived: the to-do is resolved.
      await s.asAdmin();
      await s.query("update public.vehicle_documents set archived_at = now() where id = $1", [doc]);
      expect((await alerts()).map((a) => a.status)).toEqual(["resolved", "resolved"]);

      // A company that turned the alert off gets none (the Fleet overview list still shows the certificate).
      await s.as(owner);
      await s.query("select public.comm_save_alert_setting('documents.certificate_check', '{\"enabled\": false}'::jsonb)");
      await s.as(mechanic);
      const next = await wo(s, { truck_id: t, title: "Annual DOT inspection (again)", category: "inspection" });
      await setStatus(s, next.id, "in_progress");
      await setStatus(s, next.id, "completed");
      const doc2 = (await s.query<{ id: string }>("select public.maintenance_record_inspection($1, $2::jsonb) as id",
        [next.id, JSON.stringify({ inspected_on: today, expires_on: addDays(today, 365), inspector: "Pat Inspector" })])).rows[0].id;
      await s.asAdmin();
      expect((await s.query("select 1 from public.vehicle_documents where id = $1 and work_order_id is not null and verified_at is null", [doc2])).rowCount).toBe(1);
      expect((await s.query("select 1 from public.alerts where event_type = 'documents.certificate_check' and source_key = $1", [doc2])).rowCount).toBe(0);
    });
  });


  it("is marked as recorded by the shop, counts at once, and leaves the office's list once verified", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const mechanic = await s.createUser("mechanic");
      const office = await s.createUser("office");
      await s.as(owner);
      const t = await insert(s, "trucks", { unit_number: `IC-${tag()}`, truck_type: "tri_axle_dump" });
      await s.as(mechanic);
      const job = await wo(s, { truck_id: t, title: "Annual DOT inspection", category: "inspection" });
      await setStatus(s, job.id, "in_progress");
      await setStatus(s, job.id, "completed");
      const doc = (await s.query<{ id: string }>("select public.maintenance_record_inspection($1, $2::jsonb) as id",
        [job.id, JSON.stringify({ inspected_on: today, expires_on: addDays(today, 365), inspector: "Pat Inspector" })])).rows[0].id;
      await s.as(office);
      const toCheck = async () => (await s.query<{ id: string }>(
        "select id from public.vehicle_documents where work_order_id is not null and verified_at is null and archived_at is null and id = $1", [doc])).rows;
      expect(await toCheck()).toEqual([{ id: doc }]);
      expect((await s.query<{ work_order_id: string }>("select work_order_id from public.vehicle_documents where id = $1", [doc])).rows[0].work_order_id).toBe(job.id);
      // App roles cannot set or change the reference by hand.
      expect((await pgError(s.query("update public.vehicle_documents set work_order_id = null where id = $1", [doc]))).code).toBe("42501");
      // The mechanic cannot verify (fleet.edit); the office can.
      await s.as(mechanic);
      expect((await pgError(s.query("select public.verify_vehicle_document($1)", [doc]))).code).toBe("42501");
      await s.as(office);
      await s.query("select public.verify_vehicle_document($1)", [doc]);
      expect(await toCheck()).toEqual([]);
      // Audited (the vehicle documents audit trigger records who verified it).
      await s.asAdmin();
      expect((await s.query("select 1 from public.audit_events where entity_id = $1 and actor_id = $2 and details::text like '%verified_at%'", [doc, office])).rowCount).toBeGreaterThan(0);
    });
  });
});

describe("a truck parked by hand comes back only when a person says so (MD1)", () => {
  it("is offered once its shop work is done; returning it needs the permission and no open work", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const mechanic = await s.createUser("mechanic");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(owner);
      const t = await insert(s, "trucks", { unit_number: `PK-${tag()}`, truck_type: "tri_axle_dump" });
      await s.query("select public.set_equipment_service_status('truck', $1, 'out_of_service', 'Waiting on new tires', null)", [t]);
      const listed = async () => (await s.query<{ id: string; work_order_number: string | null }>("select id, work_order_number from public.units_back_from_shop() where id = $1", [t])).rows;
      expect(await listed()).toEqual([]); // no shop work done yet
      const job = await wo(s, { truck_id: t, title: "Steer tires", category: "tires" });
      await setStatus(s, job.id, "in_progress");
      expect(await listed()).toEqual([]); // still open
      expect((await pgError(s.query("select public.return_unit_after_shop('truck', $1)", [t]))).message).toMatch(/Shop work is still open/);
      await setStatus(s, job.id, "completed");
      // Never returned by itself.
      expect((await s.query<{ service_status: string }>("select service_status from public.trucks where id = $1", [t])).rows[0].service_status).toBe("out_of_service");
      expect(await listed()).toEqual([{ id: t, work_order_number: job.number }]);

      // Dispatch sees it (fleet.view) but cannot return it; the mechanic (shop) can.
      await s.as(dispatcher);
      expect((await listed()).map((r) => r.id)).toEqual([t]);
      expect((await pgError(s.query("select public.return_unit_after_shop('truck', $1)", [t]))).code).toBe("42501");
      const other = await s.createCompany(`Other ${tag()}`);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await s.query("select 1 from public.units_back_from_shop() where id = $1", [t])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.return_unit_after_shop('truck', $1)", [t]))).code).toBe("P0002");
      await s.as(mechanic);
      await s.query("select public.return_unit_after_shop('truck', $1)", [t]);
      await s.as(owner);
      expect((await s.query<{ service_status: string }>("select service_status from public.trucks where id = $1", [t])).rows[0].service_status).toBe("in_service");
      expect((await s.query<{ actor_id: string; to_status: string }>("select actor_id, to_status from public.equipment_status_events where truck_id = $1 and to_status = 'in_service'", [t])).rows[0])
        .toEqual({ actor_id: mechanic, to_status: "in_service" });
      expect((await s.query("select 1 from public.audit_events where entity_id = $1 and action = 'fleet.returned_after_shop'", [t])).rowCount).toBe(1);
      expect(await listed()).toEqual([]);
      expect((await pgError(s.query("select public.return_unit_after_shop('truck', $1)", [t]))).message).toMatch(/already in service/);
      // The fleet page's Return to service is unchanged (fleet.service), and so are its messages.
      expect((await pgError(s.query("select public.set_equipment_service_status('truck', $1, 'in_service', '', null)", [t]))).message).toMatch(/already in service/);
    });
  });
});

describe("parts on order follow the dispatch-base limits (SEC3)", () => {
  it("a base-limited mechanic cannot read or change another base's parts on order; their own base works", async () => {
    await withSession(async (s) => {
      // Top Line on a two-base plan (rolled back with the session).
      const v = (await s.query<{ id: string }>("select id from private.platform_plan_versions where plan_key = 'growth' order by version desc limit 1")).rows[0].id;
      await s.query("insert into private.company_lifecycle (company_id, plan_version_id) values ($1, $2) on conflict (company_id) do update set plan_version_id = excluded.plan_version_id", [TOP_LINE, v]);
      const owner = await s.createUser("owner");
      const mechanic = await s.createUser("mechanic");
      await s.as(owner);
      const north = (await s.query<{ id: string }>("insert into public.dispatch_bases (code, name, timezone) values ($1, 'North (test)', 'America/Chicago') returning id", [`N${randomUUID().slice(0, 5)}`])).rows[0].id;
      const main = (await s.query<{ id: string }>("select id from public.dispatch_bases where is_default")).rows[0].id;
      const tMain = await insert(s, "trucks", { unit_number: `BM-${tag()}`, truck_type: "tri_axle_dump", base_id: main });
      const tNorth = await insert(s, "trucks", { unit_number: `BN-${tag()}`, truck_type: "tri_axle_dump", base_id: north });
      const woMain = await wo(s, { truck_id: tMain, title: "Mirror" });
      const woNorth = await wo(s, { truck_id: tNorth, title: "Mirror" });
      const pMain = (await s.query<{ id: string }>("select public.part_wait_add($1, $2::jsonb) as id", [woMain.id, JSON.stringify({ description: "Mirror glass" })])).rows[0].id;
      await s.query("select public.set_person_bases($1, $2::uuid[])", [mechanic, [north]]);

      await s.as(mechanic);
      const refusal = { code: "42501", message: "You can only work with records at your dispatch bases." };
      const err = (e: { code: string; message: string }) => ({ code: e.code, message: e.message });
      expect(err(await pgError(s.query("select public.part_wait_add($1, $2::jsonb)", [woMain.id, JSON.stringify({ description: "Anything" })])))).toEqual(refusal);
      expect(err(await pgError(s.query("select public.part_wait_update($1, $2::jsonb)", [pMain, JSON.stringify({ po_number: "PO-1" })])))).toEqual(refusal);
      expect(err(await pgError(s.query("select public.part_wait_receive($1, false)", [pMain])))).toEqual(refusal);
      expect(err(await pgError(s.query("select public.part_wait_cancel($1, 'not mine')", [pMain])))).toEqual(refusal);
      expect((await s.query("select 1 from public.part_waits($1)", [woMain.id])).rowCount).toBe(0);
      expect((await s.query<{ id: string }>("select id from public.part_waits(null)")).rows.map((r) => r.id)).not.toContain(pMain);
      expect((await s.query("select 1 from public.work_order_part_waits where id = $1", [pMain])).rowCount).toBe(0);
      // The other crew functions on another base's job are refused the same way.
      expect(err(await pgError(s.query("select public.maintenance_add_task($1, 'Not mine')", [woMain.id])))).toEqual(refusal);

      // Their own base works.
      const pNorth = (await s.query<{ id: string }>("select public.part_wait_add($1, $2::jsonb) as id", [woNorth.id, JSON.stringify({ description: "Mirror glass", set_waiting: true })])).rows[0].id;
      expect((await s.query<{ id: string }>("select id from public.part_waits($1)", [woNorth.id])).rows.map((r) => r.id)).toEqual([pNorth]);
      expect((await s.query("select 1 from public.work_order_part_waits where id = $1", [pNorth])).rowCount).toBe(1);

      // The owner sees both bases' parts.
      await s.as(owner);
      expect((await s.query<{ id: string }>("select id from public.part_waits(null)")).rows.map((r) => r.id)).toEqual(expect.arrayContaining([pMain, pNorth]));

      // "Put it back in service?" (MD1) follows the same limits: another base's parked truck is neither offered nor
      // returned by a base-limited person.
      await s.query("select public.set_equipment_service_status('truck', $1, 'out_of_service', 'Parked (test)', null)", [tMain]);
      await s.query("select public.part_wait_cancel($1, 'Not needed')", [pMain]);
      await setStatus(s, woMain.id, "in_progress");
      await setStatus(s, woMain.id, "completed");
      expect((await s.query("select 1 from public.units_back_from_shop() where id = $1", [tMain])).rowCount).toBe(1);
      await s.as(mechanic);
      expect((await s.query("select 1 from public.units_back_from_shop() where id = $1", [tMain])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.return_unit_after_shop('truck', $1)", [tMain]))).code).toBe("42501");
      await s.as(owner);
      expect((await s.query<{ service_status: string }>("select service_status from public.trucks where id = $1", [tMain])).rows[0].service_status).toBe("out_of_service");
    });
  });
});

describe("the shop decisions demo samples", () => {
  it("adds each case in a demo only, once, and each shows where the feature reads it", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany(`Demo decisions ${tag()}`);
      const owner = await s.createUser("owner", { companyId: company });
      await s.as(owner);
      const trucks: string[] = [];
      for (let i = 0; i < 4; i++) trucks.push(await insert(s, "trucks", { unit_number: `DD${i}-${tag()}`, truck_type: "tri_axle_dump" }));
      await s.query("select public.record_truck_reading($1, 150000, null, '')", [trucks[1]]);
      // A real company: refused, and nothing is added.
      expect((await pgError(s.query("select public.demo_shop_decision_samples()"))).code).toBe("42501");

      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [company]);
      await s.as(owner);
      expect((await s.query<{ n: number }>("select public.demo_shop_decision_samples() n")).rows[0].n).toBe(4);
      expect((await s.query<{ n: number }>("select public.demo_shop_decision_samples() n")).rows[0].n).toBe(0); // Refresh adds nothing twice

      // 1. A truck with a part on order for a job not started: dispatchable, with the warning.
      const waiting = (await s.query<{ truck_id: string; work_started_at: string | null }>(
        "select truck_id, work_started_at from public.work_orders where title = 'Replace torn driver seat cushion (demo)'")).rows[0];
      expect(waiting.work_started_at).toBeNull();
      await s.asAdmin();
      const e = (await s.query<{ r: { blockers: string[]; warnings: string[] } }>("select private.assignment_eligibility($1, $2, null, null, null) as r", [company, waiting.truck_id])).rows[0].r;
      await s.as(owner);
      expect(e.blockers).toEqual([]);
      expect(e.warnings).toContain("truck_part_on_order");
      // 2. A wrong reading and a correct one the feed did not use.
      expect((await s.query("select 1 from public.audit_events where entity_id = $1 and action = 'truck.reading_ignored'", [trucks[1]])).rowCount).toBe(1);
      expect((await s.query("select 1 from public.truck_readings where truck_id = $1 and note = 'Demo: one digit typed wrong'", [trucks[1]])).rowCount).toBe(1);
      // 3. A certificate from the shop, not checked yet.
      expect((await s.query("select 1 from public.vehicle_documents where work_order_id is not null and verified_at is null and archived_at is null")).rowCount).toBe(1);
      // 4. A truck parked by hand, its shop work done: offered back, not returned.
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'owner', 'fleet.view') on conflict do nothing", [company]);
      await s.as(owner);
      const back = (await s.query<{ id: string }>("select id from public.units_back_from_shop()")).rows;
      expect(back).toHaveLength(1);
      expect((await s.query<{ service_status: string }>("select service_status from public.trucks where id = $1", [back[0].id])).rows[0].service_status).toBe("out_of_service");
    });
  });
});
