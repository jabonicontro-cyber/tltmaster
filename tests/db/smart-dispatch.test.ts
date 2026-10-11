// N15 database rules behind Smart Dispatch and the order-to-billing fixes:
// approval re-checks (safety reports, capacity, conflicts, permissions),
// recorded rejections, the delivery-location requirement, derived fulfillment
// and billing readiness, and per-company branding.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { ELIGIBILITY_MESSAGES } from "@/lib/fleet/eligibility";
import { assign, businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, sampleIds, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;

/** A scheduled order with one load yesterday (assigned to t1/d1) and an open load today. */
async function world(s: Session) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const owner = await s.createUser("owner");
  const dispatcher = await s.createUser("dispatcher");
  const f = await fleet(s, owner, yesterday);
  const order = await scheduledOrder(s, owner, addDays(today, -2), addDays(today, 3), addDays(today, -2));
  await s.as(dispatcher);
  const past = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "20", unit_code: "ton" });
  const pastAssignment = await assign(s, past.load_id, f.t1, null, f.d1);
  const open = await planLoad(s, order.id, addDays(today, 1), "07:00", "09:00", { planned_quantity: "20", unit_code: "ton" });
  return { today, yesterday, owner, dispatcher, f, order, past, pastAssignment, open };
}

async function report(s: Session, w: Awaited<ReturnType<typeof world>>, kind: string, status = "open") {
  await s.asAdmin();
  return insert(s, "field_reports", {
    company_id: TOP_LINE, kind, status, driver_id: w.f.d1, assignment_id: w.pastAssignment, load_id: w.past.load_id, order_id: w.order.id,
    equipment: "truck", truck_id: w.f.t1, description: "Reported in a test", snapshot: "{}",
    ...(status === "acknowledged" ? { acknowledged_at: new Date().toISOString() } : {}),
  });
}

const assignErr = async (s: Session, loadId: string, truck: string, driver: string) =>
  pgError(s.query("select public.assign_load($1, $2, null, $3, '', null)", [loadId, truck, driver]));

describe("approval is re-checked by the database", () => {
  it("5. an unresolved breakdown or inspection report blocks the truck; an equipment issue is a warning; resolving clears it", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const r = await report(s, w, "breakdown");
      await s.as(w.dispatcher);
      expect((await assignErr(s, w.open.load_id, w.f.t1, w.f.d2)).message).toContain(ELIGIBILITY_MESSAGES.truck_safety_report_open);

      await s.asAdmin();
      await s.query("update public.field_reports set status = 'resolved', resolved_at = now(), resolution_note = 'Repaired (test)' where id = $1", [r]);
      await report(s, w, "equipment_issue", "acknowledged");
      await s.as(w.dispatcher);
      const ok = await s.query<{ r: { warnings: string[] } }>("select public.assign_load($1, $2, null, $3, 'Approved Smart Dispatch proposal', null) as r", [w.open.load_id, w.f.t1, w.f.d2]);
      expect(ok.rows[0].r.warnings).toContain("truck_equipment_report_open"); // a warning code, shown with ELIGIBILITY_MESSAGES
    });
  });

  it("6. a load above the truck's recorded capacity is refused; unknown capacity is not", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.owner);
      await s.query("update public.trucks set weight_capacity = 15, weight_unit = 'ton' where id = $1", [w.f.t2]);
      await s.as(w.dispatcher);
      const e = await assignErr(s, w.open.load_id, w.f.t2, w.f.d2);
      expect(e.message).toMatch(/Not eligible: The load is planned at 20 ton, more than the recorded capacity of 15 ton/);
      // t1 has no recorded capacity: allowed (the board shows it as a warning).
      await assign(s, w.open.load_id, w.f.t1, null, w.f.d2);
    });
  });

  it("8/11. a truck or driver already booked at that time is refused, and a second approval of the same load cannot double-assign", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const second = await planLoad(s, w.order.id, addDays(w.today, 1), "08:00", "10:00");
      await s.as(w.dispatcher);
      await assign(s, w.open.load_id, w.f.t1, null, w.f.d1);
      // Another dispatcher approves an older proposal using the same truck at an overlapping time.
      const other = await s.createUser("dispatcher");
      await s.as(other);
      expect((await assignErr(s, second.load_id, w.f.t1, w.f.d2)).message).toMatch(/booked|conflict|already/i);
      // …or approves the same load again: refused as stale, nothing replaced silently.
      const again = await assignErr(s, w.open.load_id, w.f.t2, w.f.d2);
      expect(again.code).toBe("PT409");
      const active = await s.query("select truck_id from public.dispatch_assignments where load_id = $1 and status = 'active'", [w.open.load_id]);
      expect(active.rows).toEqual([{ truck_id: w.f.t1 }]);
    });
  });

  it("14. only people with dispatch.edit can assign, reject or reconsider", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      for (const role of ["mechanic", "driver"] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await assignErr(s, w.open.load_id, w.f.t2, w.f.d2)).code).toBe("42501");
        expect((await pgError(s.query("select public.reject_dispatch_recommendation($1, $2, $3, '')", [w.open.load_id, w.f.t2, w.f.d2]))).code).toBe("42501");
        expect((await pgError(s.query("select public.reconsider_dispatch_recommendations($1)", [w.open.load_id]))).code).toBe("42501");
      }
    });
  });
});

describe("rejected proposals", () => {
  it("10. records a rejection once, audits it, and reconsidering clears it", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.dispatcher);
      await s.query("select public.reject_dispatch_recommendation($1, $2, $3, 'Driver prefers the north route')", [w.open.load_id, w.f.t2, w.f.d2]);
      await s.query("select public.reject_dispatch_recommendation($1, $2, $3, 'again')", [w.open.load_id, w.f.t2, w.f.d2]);
      const rows = await s.query("select reason from public.dispatch_recommendation_rejections where load_id = $1 and cleared_at is null", [w.open.load_id]);
      expect(rows.rows).toEqual([{ reason: "Driver prefers the north route" }]);
      expect((await pgError(s.query("insert into public.dispatch_recommendation_rejections (company_id, load_id, truck_id, driver_id) values ($1, $2, $3, $4)", [TOP_LINE, w.open.load_id, w.f.t1, w.f.d1]))).code).toBe("42501");

      const n = await s.query<{ n: number }>("select public.reconsider_dispatch_recommendations($1) as n", [w.open.load_id]);
      expect(n.rows[0].n).toBe(1);
      expect((await s.query("select 1 from public.dispatch_recommendation_rejections where load_id = $1 and cleared_at is null", [w.open.load_id])).rowCount).toBe(0);

      await s.asAdmin();
      const audit = await s.query("select action from public.audit_events where entity_id = $1 and action like 'dispatch.recommendation%'", [w.order.id]);
      expect(audit.rows.map((a) => a.action)).toContain("dispatch.recommendation_rejected");
    });
  });

  it("15. another company cannot see or reject this company's loads", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.dispatcher);
      await s.query("select public.reject_dispatch_recommendation($1, $2, $3, '')", [w.open.load_id, w.f.t2, w.f.d2]);
      const otherCo = await s.createCompany("Other Hauling (test)");
      const outsider = await s.createUser("owner", { companyId: otherCo });
      await s.as(outsider);
      expect((await s.query("select 1 from public.dispatch_recommendation_rejections")).rowCount).toBe(0);
      expect((await pgError(s.query("select public.reject_dispatch_recommendation($1, $2, $3, '')", [w.open.load_id, w.f.t2, w.f.d2]))).message).toMatch(/Load not found/);
      expect((await pgError(s.query("select public.assign_load($1, $2, null, $3, '', null)", [w.open.load_id, w.f.t2, w.f.d2]))).message).toMatch(/not found/i);
    });
  });
});

describe("orders need a delivery location before scheduling", () => {
  it("refuses Scheduled without a site address or site name, and accepts a site name for pickups", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const office = await s.createUser("office");
      await s.as(office);
      const today = await businessToday(s);
      await s.as(office);
      const draft = async (extra: Row) =>
        (await s.query<{ r: { order_id: string } }>("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
          customer_id: ids.customerId,
          lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel", unit_code: "ton", quantity: "10", unit_rate_cents: 1000 }],
          ...extra,
        })])).rows[0].r.order_id;
      const prep = async (id: string) => {
        await s.query("select public.set_order_status($1, 'confirmed', '')", [id]);
        await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [id, JSON.stringify({ scheduled_start: today })]);
      };
      const bare = await draft({});
      await prep(bare);
      expect((await pgError(s.query("select public.set_order_status($1, 'scheduled', '')", [bare]))).message).toMatch(/Add the delivery location/);
      const pickup = await draft({ site_label: "Customer pickup at the yard" });
      await prep(pickup);
      await s.query("select public.set_order_status($1, 'scheduled', '')", [pickup]);
    });
  });
});

describe("fulfillment and billing readiness", () => {
  const submit = async (s: Session, payload: Row) =>
    (await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify(payload)])).rows[0].r;
  const status = async (s: Session, id: string) =>
    (await s.query<Row>("select readiness, fulfilled, fulfillment_gap, exceptions_fingerprint from public.billing_order_status where order_id = $1", [id])).rows[0];

  it("partial delivery stays out of billing; full delivery becomes billable without marking Completed; a new load recalculates it", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const yesterday = addDays(today, -1);
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const f = await fleet(s, owner, yesterday);
      const order = await scheduledOrder(s, owner, addDays(today, -2), addDays(today, 2), addDays(today, -2));
      await s.as(office);
      const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "20", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);
      const ticket = (qty: string) => ({ load_id: load.load_id, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30", quantity: qty, unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 8)}` });

      // 20 of 40 t delivered and accepted: partial.
      const t1 = await submit(s, ticket("20"));
      expect(await status(s, order.id)).toMatchObject({ readiness: "needs_review", fulfilled: false, fulfillment_gap: "tickets_pending" });
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t1.ticket_id]);
      expect(await status(s, order.id)).toMatchObject({ readiness: "in_progress", fulfilled: false, fulfillment_gap: "quantity_short" });

      // Corrected to the full 40 t: fulfilled. The hauling line has no ticket, so it is an exception to acknowledge first.
      await s.query("select public.correct_delivery_ticket($1, $2::jsonb, 'Scale ticket read again (test)')", [t1.ticket_id, JSON.stringify({ ...ticket("40"), external_reference: undefined })]);
      const corrected = await s.query<{ id: string }>("select id from public.delivery_tickets where load_id = $1 and status = 'needs_review'", [load.load_id]);
      if (corrected.rows[0]) await s.query("select public.review_delivery_ticket($1, 'accept', '')", [corrected.rows[0].id]);
      const full = await status(s, order.id);
      expect(full).toMatchObject({ fulfilled: true, fulfillment_gap: null, readiness: "blocked" });
      await s.query("select public.acknowledge_billing_exceptions($1, $2, 'Hauling billed on delivered tons (test)')", [order.id, full.exceptions_fingerprint]);
      expect(await status(s, order.id)).toMatchObject({ readiness: "ready" });
      expect((await s.query("select status from public.orders where id = $1", [order.id])).rows[0].status).not.toBe("completed");

      // Another load is planned: no longer fulfilled, out of billing again.
      await planLoad(s, order.id, addDays(today, 1), "07:00", "09:00");
      const after = await status(s, order.id);
      expect(after).toMatchObject({ fulfilled: false, fulfillment_gap: "loads_upcoming" });
      expect(after.readiness).not.toBe("ready");
    });
  });
});

describe("company branding", () => {
  it("is stored per company, limited to valid values, and changed only with settings.manage", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      await s.as(owner);
      const logo = `data:image/png;base64,${Buffer.from("not really a png").toString("base64")}`;
      await s.query("update public.company_settings set brand_color = '#1f6feb', brand_sidebar_color = '#102030', brand_logo = $1", [logo]);
      expect((await pgError(s.query("update public.company_settings set brand_color = 'red'"))).code).toBe("23514");
      expect((await pgError(s.query("update public.company_settings set brand_logo = 'data:image/svg+xml;base64,PHN2Zz4='"))).code).toBe("23514");

      await s.as(office);
      const r = await s.query("update public.company_settings set brand_color = '#000000' returning 1");
      expect(r.rowCount).toBe(0);

      const otherCo = await s.createCompany("Other Hauling (test)");
      const outsider = await s.createUser("owner", { companyId: otherCo });
      await s.as(outsider);
      const theirs = await s.query("select company_id, brand_color, brand_logo from public.company_settings");
      expect(theirs.rows.every((row) => row.company_id === otherCo && row.brand_color === "" && row.brand_logo === "")).toBe(true);
      await s.query("update public.company_settings set brand_color = '#000000' where company_id = $1", [TOP_LINE]);
      await s.as(owner);
      expect((await s.query("select brand_color from public.company_settings")).rows).toEqual([{ brand_color: "#1f6feb" }]);
    });
  });
});
