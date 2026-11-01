// Shared setup for dispatch-related database tests: a scheduled order, a ready
// fleet, loads and assignments — all created through the app's own functions.
import { randomUUID } from "node:crypto";
import { addDays } from "@/lib/dates";
import { sampleIds, TOP_LINE, type Session } from "./helpers";

type Row = Record<string, unknown>;

export async function insert(s: Session, table: string, row: Row) {
  const cols = Object.keys(row);
  const res = await s.query<{ id: string }>(
    `insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return res.rows[0].id;
}

export async function businessToday(s: Session) {
  await s.asAdmin();
  return (await s.query<{ d: string }>("select private.business_today($1)::text as d", [TOP_LINE])).rows[0].d;
}

/**
 * A Scheduled order for the sample customer (gravel in tons + hauling in tons),
 * with order date `orderDate` and scheduled `start`..`end`.
 */
export async function scheduledOrder(s: Session, user: string, start: string, end: string | null = null, orderDate?: string) {
  const ids = await sampleIds(s);
  await s.as(user);
  const r = await s.query<{ r: { order_id: string; order_number: string } }>("select public.save_order_draft($1::jsonb) as r", [
    JSON.stringify({
      site_line1: "100 Test Site Rd (test)", customer_id: ids.customerId,
      order_date: orderDate ?? start,
      lines: [
        { kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "40", unit_rate_cents: 1000 },
        { kind: "hauling", calc_method: "per_unit", charge_item_id: ids.haulTonId, description: "Hauling", unit_code: "ton", quantity: "40", unit_rate_cents: 500 },
      ],
    }),
  ]);
  const id = r.rows[0].r.order_id;
  await s.query("select public.set_order_status($1, 'confirmed', '')", [id]);
  await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [id, JSON.stringify({ scheduled_start: start, scheduled_end: end })]);
  await s.query("select public.set_order_status($1, 'scheduled', '')", [id]);
  const lines = await s.query<{ id: string; kind: string }>("select id, kind from public.order_lines where order_id = $1 order by line_no", [id]);
  return { id, number: r.rows[0].r.order_number, materialLine: lines.rows[0].id, haulingLine: lines.rows[1].id };
}

export async function planLoad(s: Session, orderId: string, date: string, start: string, end: string, extra: Row = {}) {
  const r = await s.query<{ r: { load_id: string; load_number: number } }>("select public.save_order_load($1::jsonb) as r", [
    JSON.stringify({ order_id: orderId, load_date: date, start_time: start, end_time: end, ...extra }),
  ]);
  return r.rows[0].r;
}

export async function assign(s: Session, loadId: string, truck: string, trailer: string | null, driver: string, replace: string | null = null) {
  const r = await s.query<{ r: { assignment_id: string } }>("select public.assign_load($1, $2, $3, $4, '', $5) as r", [loadId, truck, trailer, driver, replace]);
  return r.rows[0].r.assignment_id;
}

/** Two dump trucks and three drivers with verified, unexpired class A CDLs and medical cards on `on`. */
export async function fleet(s: Session, user: string, on: string) {
  await s.as(user);
  const verified = new Date().toISOString();
  const far = addDays(on, 600);
  const tag = () => Math.random().toString(36).slice(2, 6);
  const t1 = await insert(s, "trucks", { unit_number: `K1-${tag()}`, truck_type: "tri_axle_dump" });
  const t2 = await insert(s, "trucks", { unit_number: `K2-${tag()}`, truck_type: "tri_axle_dump" });
  const drivers: string[] = [];
  for (const n of ["A", "B", "C"]) {
    const d = await insert(s, "drivers", { name: `Driver ${n}` });
    await insert(s, "driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified });
    await insert(s, "driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: far, verified_at: verified });
    drivers.push(d);
  }
  return { t1, t2, d1: drivers[0], d2: drivers[1], d3: drivers[2] };
}

/** A completed, acknowledged order (a material line and a hauling line) handed off for billing. */
export async function handedOff(s: Session, office: string) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
  await assign(s, load.load_id, f.t1, null, f.d1);
  await s.as(office);
  const t = (await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
    load_id: load.load_id, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:00", quantity: "40", unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 8)}`,
  })])).rows[0].r;
  await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
  await s.query("select public.set_order_status($1, 'in_progress', '')", [order.id]);
  await s.query("select public.set_order_status($1, 'completed', '')", [order.id]);
  const st = (await s.query<Row>("select exceptions_fingerprint from public.billing_order_status where order_id = $1", [order.id])).rows[0];
  if (st?.exceptions_fingerprint) await s.query("select public.acknowledge_billing_exceptions($1, $2, 'Test')", [order.id, st.exceptions_fingerprint]);
  await s.query("select public.hand_off_orders($1::uuid[], '', '', $2)", [[order.id], randomUUID()]);
  const h = (await s.query<{ id: string; snapshot: { lines: Array<{ kind: string; billing_entity_id?: string; billing_entity_name?: string }> } }>("select id, snapshot from public.billing_handoff_orders where order_id = $1", [order.id])).rows[0];
  return { order, handoffOrder: h.id, snapshot: h.snapshot };
}
