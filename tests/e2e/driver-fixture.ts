// Shared e2e fixture: the e2e driver account linked to a fresh driver record
// with yesterday's load and a load late today (and another driver's load).
import pg from "pg";
import { asUser } from "./db";
import { unique } from "./helpers";
import { USERS } from "./users";

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** The driver account's user id (fixture lookup on the local test database). */
export async function driverUserId() {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<{ id: string }>("select id from public.profiles where email = $1", [USERS.driver.email])).rows[0].id;
  } finally {
    await c.end();
  }
}
export const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;

/**
 * Links the e2e driver account to a fresh driver record (earlier runs' records
 * are unlinked and kept), and gives it yesterday's load and a load late today.
 * Another driver gets a load on the same order.
 */
export async function driverFixture() {
  const id = unique();
  const userId = await driverUserId();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      const r = await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
      return r.rows[0].id as string;
    };
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    await q("update public.drivers set user_id = null, name = 'Drew Driver (earlier e2e run)', active = false where user_id = $1", [userId]);
    const verified = new Date().toISOString();
    const qualified = async (row: Record<string, unknown>) => {
      const d = await ins("drivers", row);
      await ins("driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: plusDays(600), verified_at: verified });
      await ins("driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: plusDays(20), verified_at: verified });
      return d;
    };
    const me = await qualified({ user_id: userId });
    const other = await qualified({ name: `Other Driver ${id}` });
    const myTruck = await ins("trucks", { unit_number: `DRV-${id}`, truck_type: "tri_axle_dump" });
    const otherTruck = await ins("trucks", { unit_number: `OTH-${id}`, truck_type: "tri_axle_dump" });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [
      JSON.stringify({
        site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, order_date: yesterday, project_name: `Driver e2e ${id}`, job_instructions: "Dump at the north pad, back in from Elm St.",
        internal_notes: "OFFICE-ONLY-NOTE e2e",
        lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 }],
      }),
    ]);
    const o = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: yesterday, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    const plan = async (date: string, start: string, end: string) =>
      ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: o.order_id, load_date: date, start_time: start, end_time: end, planned_quantity: "22", unit_code: "ton" })])).rows[0].r as { load_id: string }).load_id;
    const assignTo = async (load: string, truck: string, driver: string) =>
      ((await q("select public.assign_load($1, $2, null, $3, '', null) as r", [load, truck, driver])).rows[0].r as { assignment_id: string }).assignment_id;
    const pastLoad = await plan(yesterday, "07:00", "09:00");
    const past = await assignTo(pastLoad, myTruck, me);
    const lateLoad = await plan(today, "23:00", "23:59");
    const late = await assignTo(lateLoad, myTruck, me);
    const otherLoad = await plan(yesterday, "10:00", "12:00");
    const otherAssignment = await assignTo(otherLoad, otherTruck, other);
    return { orderId: o.order_id, orderNumber: o.order_number, past, late, otherAssignment, myTruck: `DRV-${id}`, otherTruck: `OTH-${id}`, ref: `SC-${id}` };
  });
}
