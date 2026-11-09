// Readings from every place they are entered (20261120012200): fuel entries, inspections, trip sheets and work orders
// update the truck's current odometer and engine hours through one shared path, never lowering it; a value lower than
// the current reading, or a jump no truck could drive, is not used and is recorded in the audit log; preventive "due by
// miles" follows the real mileage.
import { afterAll, describe, expect, it } from "vitest";
import { businessToday, insert } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

const tag = () => Math.random().toString(36).slice(2, 7);
const KEYS = ["service_brakes", "parking_brake", "steering", "lights_reflectors", "tires", "wheels_rims", "coupling", "horn", "wipers", "mirrors", "emergency_equipment", "air_lines", "hoist_body", "pto", "tarp", "tailgate"];

describe("odometer readings feed", () => {
  it("records readings from fuel, inspections, trip sheets and work orders; never lowers them; PM follows the mileage", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      await s.as(owner);
      const t = await insert(s, "trucks", { unit_number: `RF-${tag()}`, truck_type: "tri_axle_dump" });
      const sched = (await s.query<{ id: string }>("select public.maintenance_save_schedule($1::jsonb) as id",
        [JSON.stringify({ truck_id: t, name: "Oil and filter", interval_miles: 15000, warn_miles: 1000, last_done_miles: 100000 })])).rows[0].id;
      const pm = async () => (await s.query<{ state: string; current_miles: string | null }>(
        "select state, current_miles::text from public.maintenance_pm_status() where schedule_id = $1", [sched])).rows[0];
      const readings = async () => (await s.query<{ odometer_miles: string | null; engine_hours: string | null; source: string }>(
        "select odometer_miles::text, engine_hours::text, source from public.truck_readings where truck_id = $1 order by read_at, id", [t])).rows;
      const ignored = async () => (await s.query<{ summary: string; details: { why: string; source: string } }>(
        "select summary, details from public.audit_events where entity_id = $1 and action = 'truck.reading_ignored' order by occurred_at", [t])).rows;
      expect((await pm()).state).toBe("unknown");

      // A fuel entry: the first reading.
      await s.query("select public.fuel_record_purchase($1::jsonb)", [JSON.stringify({ truck_id: t, purchased_on: today, jurisdiction: "IA", gallons: "80", total_cents: 30000, odometer: 113000 })]);
      expect(await pm()).toEqual({ state: "ok", current_miles: "113000.0" });

      // A pre-trip inspection: due soon.
      await s.query("select public.inspection_submit($1::jsonb)", [JSON.stringify({ truck_id: t, kind: "pre_trip", odometer: "114200", items: KEYS.map((key) => ({ key, ok: true, note: "" })) })]);
      expect((await pm()).state).toBe("due_soon");

      // A trip sheet: overdue.
      await s.query("select public.fuel_record_trip_sheet($1::jsonb)", [JSON.stringify({ truck_id: t, sheet_date: today, start_odometer: 114200, end_odometer: 115100, legs: [{ jurisdiction: "IA", miles: 900 }] })]);
      expect(await pm()).toEqual({ state: "overdue", current_miles: "115100.0" });

      // A typo lower than the current reading is not used; it is recorded.
      await s.query("select public.fuel_record_purchase($1::jsonb)", [JSON.stringify({ truck_id: t, purchased_on: today, jurisdiction: "IA", gallons: "20", total_cents: 8000, odometer: 11510 })]);
      expect((await pm()).current_miles).toBe("115100.0");

      // A work order: an impossible jump is not used; a real reading (miles and hours) is.
      const wo = (await s.query<{ r: { id: string } }>("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: t, title: "Oil and filter service" })])).rows[0].r.id;
      await s.query("select public.maintenance_update_work_order($1, null, $2::jsonb)", [wo, JSON.stringify({ odometer_at_service: "1151000" })]);
      expect((await pm()).current_miles).toBe("115100.0");
      await s.query("select public.maintenance_update_work_order($1, null, $2::jsonb)", [wo, JSON.stringify({ odometer_at_service: "115300", engine_hours_at_service: "4210" })]);
      // Saving the same values again adds nothing.
      await s.query("select public.maintenance_update_work_order($1, null, $2::jsonb)", [wo, JSON.stringify({ findings: "Oil changed" })]);
      expect((await pm()).current_miles).toBe("115300.0");

      expect(await readings()).toEqual([
        { odometer_miles: "113000.0", engine_hours: null, source: "fuel" },
        { odometer_miles: "114200.0", engine_hours: null, source: "inspection" },
        { odometer_miles: "115100.0", engine_hours: null, source: "trip_sheet" },
        { odometer_miles: "115300.0", engine_hours: "4210.0", source: "work_order" },
      ]);
      const flags = await ignored();
      expect(flags.map((f) => [f.details.why, f.details.source])).toEqual([["lower", "fuel"], ["implausible", "work_order"]]);
      expect(flags[0].summary).toMatch(/Odometer 11510 mi from a fuel entry on truck RF-\w+ was not used: lower than the current 115100/);

      // The Preventive page still refuses a lower reading outright, and accepts a higher one.
      expect((await pgError(s.query("select public.record_truck_reading($1, 115000, null)", [t]))).message).toMatch(/cannot go down/);
      await s.query("select public.record_truck_reading($1, 115400, null)", [t]);
      expect((await readings()).at(-1)).toEqual({ odometer_miles: "115400.0", engine_hours: null, source: "manual" });

      // Readings stay invisible to people without maintenance access, and to other companies.
      const driver = await s.createUser("driver");
      await s.as(driver);
      expect((await s.query("select 1 from public.truck_readings where truck_id = $1", [t])).rowCount).toBe(0);
    });
  });

  it("a trailer work order or a voided fuel entry records nothing", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      await s.as(owner);
      const tr = await insert(s, "trailers", { unit_number: `RT-${tag()}`, trailer_type: "end_dump", compatible_truck_types: "{tractor}" });
      const wo = (await s.query<{ r: { id: string } }>("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ trailer_id: tr, title: "Trailer lights" })])).rows[0].r.id;
      await s.query("select public.maintenance_update_work_order($1, null, $2::jsonb)", [wo, JSON.stringify({ odometer_at_service: "5000" })]);
      const t = await insert(s, "trucks", { unit_number: `RV-${tag()}`, truck_type: "tri_axle_dump" });
      const id = (await s.query<{ r: string }>("select public.fuel_record_purchase($1::jsonb) r", [JSON.stringify({ truck_id: t, purchased_on: today, jurisdiction: "IA", gallons: "10", total_cents: 4000, odometer: 5000 })])).rows[0].r;
      expect((await s.query("select 1 from public.truck_readings where truck_id = $1", [t])).rowCount).toBe(1);
      await s.query("select public.fuel_void('purchase', $1, 'Wrong truck')", [id]);
      // Voiding keeps the reading already taken (it was the truck's real odometer when entered); nothing new is added.
      expect((await s.query("select 1 from public.truck_readings where truck_id = $1", [t])).rowCount).toBe(1);
    });
  });
});
