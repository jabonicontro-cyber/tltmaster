import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { ELIGIBILITY_MESSAGES } from "@/lib/fleet/eligibility";
import { businessToday, insert } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

// A work order belongs to exactly one truck or one trailer (20261115000100).
// A safety-critical trailer defect keeps the trailer out of dispatch until an
// authorized inspection clears it, exactly as for trucks.

const tag = () => Math.random().toString(36).slice(2, 7);

async function createWo(s: Session, p: Record<string, unknown>) {
  const r = await s.query<{ r: { id: string; number: string } }>("select public.maintenance_create_work_order($1::jsonb) as r", [JSON.stringify(p)]);
  return r.rows[0].r;
}

const status = (s: Session, id: string, to: string, note = "") => s.query("select public.maintenance_set_status($1, $2, $3)", [id, to, note]);

async function trailerStatus(s: Session, id: string) {
  await s.asAdmin();
  return (await s.query<{ v: string }>("select service_status::text as v from public.trailers where id = $1", [id])).rows[0].v;
}

async function eligibility(s: Session, trailer: string, on: string) {
  return (await s.query<{ r: { blockers: string[]; warnings: string[] } }>("select public.check_assignment_eligibility(null, $1, null, $2) as r", [trailer, on])).rows[0].r;
}

describe("trailer work orders", () => {
  it("a safety-critical defect restricts the trailer until an authorized inspection passes", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const mechanic = await s.createUser("mechanic");
      await s.as(owner);
      const unit = `TR-${tag()}`;
      const trailer = await insert(s, "trailers", { unit_number: unit, trailer_type: "end_dump" });

      await s.as(mechanic);
      const wo = await createWo(s, { trailer_id: trailer, title: "Landing gear bent", category: "body", urgency: "immediate", safety_critical: true });
      expect(await trailerStatus(s, trailer)).toBe("out_of_service");

      await s.as(owner);
      expect((await eligibility(s, trailer, today)).blockers).toEqual(expect.arrayContaining(["trailer_out_of_service", "trailer_safety_restricted"]));
      expect((await pgError(s.query("select public.set_equipment_service_status('trailer', $1, 'in_service')", [trailer]))).message)
        .toMatch(/Trailer .* has an open safety-critical work order/);

      // The alert names the trailer.
      await s.asAdmin();
      const alert = (await s.query<{ title: string; entity_type: string; status: string }>(
        "select title, entity_type, status from public.alerts where event_type = 'maintenance.safety_restriction' and source_key = $1", [wo.id])).rows[0];
      expect(alert).toMatchObject({ title: `Trailer ${unit} restricted: Landing gear bent`, entity_type: "trailer", status: "open" });

      await s.as(mechanic);
      await status(s, wo.id, "in_progress");
      await status(s, wo.id, "awaiting_inspection");
      await s.as(owner);
      const r = await s.query<{ r: { returned_to_service: boolean } }>("select public.maintenance_record_clearance($1, 'passed', 'Replaced leg, tested') as r", [wo.id]);
      expect(r.rows[0].r.returned_to_service).toBe(true);
      expect(await trailerStatus(s, trailer)).toBe("in_service");
      await s.as(owner);
      expect((await eligibility(s, trailer, today)).blockers).toEqual([]);

      await s.asAdmin();
      const events = await s.query<{ kind: string; note: string }>("select kind, note from public.work_order_events where work_order_id = $1 order by created_at", [wo.id]);
      expect(events.rows.find((e) => e.kind === "returned_to_service")?.note).toBe(`Trailer ${unit} returned to service.`);
      const history = await s.query<{ t: string }>("select from_status || '>' || to_status as t from public.equipment_status_events where trailer_id = $1", [trailer]);
      expect(history.rows.map((h) => h.t).sort()).toEqual(["in_service>out_of_service", "out_of_service>in_service"]);
      expect((await s.query<{ status: string }>("select status from public.alerts where source_key = $1", [wo.id])).rows[0].status).toBe("resolved");
    });
  });

  it("a shop visit on the load date blocks the trailer; open shop work warns; trucks are unaffected", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const day = addDays(today, 2);
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(owner);
      const a = await insert(s, "trailers", { unit_number: `TA-${tag()}`, trailer_type: "end_dump" });
      const b = await insert(s, "trailers", { unit_number: `TB-${tag()}`, trailer_type: "belly_dump" });
      const truck = await insert(s, "trucks", { unit_number: `K-${tag()}`, truck_type: "tri_axle_dump" });
      await createWo(s, { trailer_id: a, title: "Annual inspection", category: "inspection", scheduled_for: day });
      const w2 = await createWo(s, { trailer_id: b, title: "Tarp arm" });
      await status(s, w2.id, "in_progress");

      expect((await eligibility(s, a, day)).blockers).toContain("trailer_shop_scheduled");
      expect((await eligibility(s, a, addDays(day, 1))).blockers).toEqual([]);
      const eb = await eligibility(s, b, day);
      expect([eb.blockers, eb.warnings.includes("trailer_shop_work_open")]).toEqual([[], true]);
      const et = (await s.query<{ r: { blockers: string[]; warnings: string[] } }>("select public.check_assignment_eligibility($1, null, null, $2) as r", [truck, day])).rows[0].r;
      expect(et.blockers.concat(et.warnings).some((c) => c.startsWith("truck_shop") || c.startsWith("truck_safety"))).toBe(false);

      // Dispatch sees the trailer in the shop schedule; messages exist for every new code.
      await s.as(dispatcher);
      const rows = (await s.query<{ r: Array<{ trailer_id: string | null; truck_id: string | null }> }>("select public.dispatch_shop_schedule($1, $2) as r", [today, addDays(today, 7)])).rows[0].r;
      expect(rows.filter((r) => r.trailer_id === a).map((r) => r.truck_id)).toEqual([null]);
      await s.asAdmin();
      for (const code of ["trailer_safety_restricted", "trailer_shop_scheduled", "trailer_shop_work_open"]) {
        const m = (await s.query<{ m: string }>("select private.eligibility_message($1) as m", [code])).rows[0].m;
        expect(m).toBe(ELIGIBILITY_MESSAGES[code]);
      }
    });
  });

  it("a work order names exactly one unit of the caller's company; schedules stay truck-only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const trailer = await insert(s, "trailers", { unit_number: `TC-${tag()}`, trailer_type: "flatbed" });
      const truck = await insert(s, "trucks", { unit_number: `K-${tag()}`, truck_type: "tri_axle_dump" });
      expect((await pgError(createWo(s, { truck_id: truck, trailer_id: trailer, title: "Both" }))).message).toMatch(/not both/);
      expect((await pgError(createWo(s, { title: "Neither" }))).message).toMatch(/Choose a truck/);

      const other = await s.createCompany(`Other ${tag()}`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await pgError(createWo(s, { trailer_id: trailer, title: "Not mine" }))).message).toMatch(/Choose a trailer/);
      expect((await s.query("select id from public.work_orders where trailer_id = $1", [trailer])).rowCount).toBe(0);

      await s.asAdmin();
      const company = (await s.query<{ c: string }>("select company_id as c from public.trailers where id = $1", [trailer])).rows[0].c;
      const insertRaw = (cols: Record<string, unknown>) => s.query(
        `insert into public.work_orders (company_id, number, title, ${Object.keys(cols).join(", ")}) values ($1, $2, 'Raw row', ${Object.keys(cols).map((_, i) => `$${i + 3}`).join(", ")})`,
        [company, `WO-T-${tag()}`, ...Object.values(cols)]);
      expect((await pgError(insertRaw({ truck_id: null }))).code).toBe("23514");
      expect((await pgError(insertRaw({ truck_id: truck, trailer_id: trailer }))).code).toBe("23514");
      const sched = (await s.query<{ id: string }>("insert into public.maintenance_schedules (company_id, truck_id, name, interval_days) values ($1, $2, 'Oil', 90) returning id", [company, truck])).rows[0].id;
      expect((await pgError(insertRaw({ trailer_id: trailer, schedule_id: sched }))).code).toBe("23514");
    });
  });

  it("the driver whose truck usually pulls the trailer is told about its shop visit", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const driverUser = await s.createUser("driver");
      await s.as(owner);
      const truck = await insert(s, "trucks", { unit_number: `K-${tag()}`, truck_type: "tractor" });
      const unit = `TD-${tag()}`;
      const trailer = await insert(s, "trailers", { unit_number: unit, trailer_type: "end_dump", default_truck_id: truck });
      await s.asAdmin();
      const d = (await s.query<{ id: string }>("insert into public.drivers (company_id, user_id, name) select company_id, user_id, 'Trailer Notice Driver' from public.company_memberships where user_id = $1 returning id", [driverUser])).rows[0].id;
      await s.as(owner);
      await s.query("select public.set_driver_primary_truck($1, $2)", [d, truck]);
      await createWo(s, { trailer_id: trailer, title: "Brake inspection", category: "inspection", scheduled_for: addDays(today, 3) });

      await s.as(driverUser);
      const notices = (await s.query<{ r: Array<{ unit_number: string; equipment: string; notice: string }> }>("select public.driver_maintenance_notices() as r")).rows[0].r;
      expect(notices.map((n) => [n.equipment, n.unit_number, n.notice])).toEqual([["trailer", unit, "scheduled"]]);
    });
  });
});
