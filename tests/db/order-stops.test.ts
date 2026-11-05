// Stops on an order (MK2 slice 1, 20261120007800): orders editors save an ordered list of pickups and deliveries
// (first a pickup, last a delivery); stops left out are marked removed, never deleted; the change is audited; the
// assigned driver reads the stops of their own loads only; other companies and other roles are refused.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Stop = { id?: string; kind: string; name: string; address_line1?: string; city?: string; state?: string; postal_code?: string; appointment_date?: string; window_start?: string; window_end?: string; reference?: string; notes?: string };
const save = (s: Session, order: string, stops: Stop[]) => s.query<{ n: number }>("select public.save_order_stops($1, $2::jsonb) as n", [order, JSON.stringify(stops)]);
const current = async (s: Session, order: string) =>
  (await s.query<{ id: string; seq: number; kind: string; name: string; reference: string; window_start: string | null }>(
    "select id, seq, kind, name, reference, window_start::text from public.order_stops where order_id = $1 and removed_at is null order by seq", [order])).rows;
type DriverStops = Record<string, Array<{ seq: number; kind: string; name: string; address: string; reference: string; window_start: string | null }>>;
const driverStops = async (s: Session) => (await s.query<{ r: DriverStops }>("select public.driver_load_stops() as r")).rows[0].r;

async function world(s: Session) {
  const today = await businessToday(s);
  const office = await s.createUser("office");
  const f = await fleet(s, office, today);
  const order = await scheduledOrder(s, office, today, addDays(today, 1), today);
  const mine = await planLoad(s, order.id, today, "07:00", "09:00");
  await assign(s, mine.load_id, f.t1, null, f.d1);
  const other = await scheduledOrder(s, office, today, addDays(today, 1), today);
  const theirs = await planLoad(s, other.id, today, "10:00", "12:00");
  await assign(s, theirs.load_id, f.t2, null, f.d2);
  await s.asAdmin();
  const driver1 = await s.createUser("driver");
  const driver2 = await s.createUser("driver");
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driver1]);
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d2, driver2]);
  return { today, office, order, other, mine, theirs, driver1, driver2 };
}

describe("order stops", () => {
  it("saves stops in order, keeps ids on update, marks dropped stops removed, audits, and shows the driver their own loads", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const first: Stop[] = [
        { kind: "pickup", name: "Acme Steel (test)", address_line1: "100 Mill St", city: "Gary", state: "IN", postal_code: "46402", appointment_date: w.today, window_start: "07:00", window_end: "09:00", reference: "PU-4411" },
        { kind: "delivery", name: "Lakeside Build (test)", city: "Joliet", state: "IL", reference: "PO 778" },
        { kind: "delivery", name: "Harbor Supply (test)", city: "Hammond", state: "IN", notes: "Dock 3, call ahead" },
      ];
      expect((await save(s, w.order.id, first)).rows[0].n).toBe(3);
      const saved = await current(s, w.order.id);
      expect(saved.map((r) => [r.seq, r.kind, r.name])).toEqual([[1, "pickup", "Acme Steel (test)"], [2, "delivery", "Lakeside Build (test)"], [3, "delivery", "Harbor Supply (test)"]]);
      expect(saved[0].window_start).toBe("07:00:00");

      // The driver of the assigned load sees the stops with a one-line address; the other driver sees only theirs.
      await s.as(w.driver1);
      const mine = await driverStops(s);
      expect(Object.keys(mine)).toEqual([w.mine.load_id]);
      expect(mine[w.mine.load_id].map((x) => x.name)).toEqual(["Acme Steel (test)", "Lakeside Build (test)", "Harbor Supply (test)"]);
      expect(mine[w.mine.load_id][0]).toMatchObject({ kind: "pickup", address: "100 Mill St, Gary, IN 46402", reference: "PU-4411" });
      await s.as(w.driver2);
      expect(await driverStops(s)).toEqual({});

      // Reorder and drop one: ids are kept for the stops sent back; the dropped stop stays, marked removed.
      await s.as(w.office);
      const [p, d1, d2] = saved;
      await save(s, w.order.id, [{ id: p.id, kind: "pickup", name: "Acme Steel (test)", reference: "PU-4412" }, { id: d2.id, kind: "delivery", name: "Harbor Supply (test)" }]);
      const after = await current(s, w.order.id);
      expect(after.map((r) => [r.id, r.seq, r.reference])).toEqual([[p.id, 1, "PU-4412"], [d2.id, 2, ""]]);
      await s.asAdmin();
      expect((await s.query("select removed_at from public.order_stops where id = $1 and removed_at is not null", [d1.id])).rowCount).toBe(1);
      const audit = (await s.query<{ summary: string }>("select summary from public.audit_events where action = 'order.stops_saved' and entity_id = $1 order by occurred_at", [w.order.id])).rows.map((r) => r.summary);
      expect(audit).toEqual([expect.stringMatching(/1 pickup, 2 deliveries/), expect.stringMatching(/1 pickup, 1 delivery$/)]);

      // An empty list clears them; the driver's card goes back to the order's pickup and job site.
      await s.as(w.office);
      expect((await save(s, w.order.id, [])).rows[0].n).toBe(0);
      expect(await current(s, w.order.id)).toEqual([]);
      await s.as(w.driver1);
      expect(await driverStops(s)).toEqual({});
    });
  });

  it("refuses bad lists, closed orders, other companies' orders and roles without orders.edit", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const ok: Stop[] = [{ kind: "pickup", name: "A (test)" }, { kind: "delivery", name: "B (test)" }];
      expect((await pgError(save(s, w.order.id, [{ kind: "delivery", name: "B" }, { kind: "pickup", name: "A" }]))).message).toMatch(/first stop must be a pickup/);
      expect((await pgError(save(s, w.order.id, [{ kind: "pickup", name: "A" }]))).message).toMatch(/last stop must be a delivery/);
      expect((await pgError(save(s, w.order.id, [{ kind: "pickup", name: " " }, { kind: "delivery", name: "B" }]))).message).toMatch(/Stop 1: enter the place name/);
      expect((await pgError(save(s, w.order.id, [{ kind: "pickup", name: "A", appointment_date: w.today, window_start: "09:00", window_end: "08:00" }, { kind: "delivery", name: "B" }]))).message).toMatch(/end after it starts/);
      expect((await pgError(save(s, w.order.id, [{ kind: "pickup", name: "A", window_start: "08:00", window_end: "09:00" }, { kind: "delivery", name: "B" }]))).message).toMatch(/needs an appointment date/);
      expect((await pgError(save(s, w.order.id, [{ kind: "pickup", name: "A", appointment_date: "soon" }, { kind: "delivery", name: "B" }]))).message).toMatch(/check the appointment date/);
      expect((await pgError(save(s, w.order.id, Array.from({ length: 26 }, (_, i) => ({ kind: i === 0 ? "pickup" : "delivery", name: `S${i}` }))))).message).toMatch(/at most 25/);
      expect(await current(s, w.order.id)).toEqual([]);

      // An id from another order is not taken over: a new stop is added instead.
      await save(s, w.other.id, ok);
      const foreignStop = (await current(s, w.other.id))[0].id;
      await save(s, w.order.id, [{ id: foreignStop, kind: "pickup", name: "A2 (test)" }, { kind: "delivery", name: "B2 (test)" }]);
      expect((await current(s, w.other.id))[0]).toMatchObject({ id: foreignStop, name: "A (test)" });
      expect((await current(s, w.order.id)).map((r) => r.id)).not.toContain(foreignStop);

      // Roles without orders.edit, and the driver, are refused; so is another company's order.
      for (const role of ["driver", "mechanic"] as const) {
        await s.as(await s.createUser(role));
        expect((await pgError(save(s, w.order.id, ok))).code).toBe("42501");
      }
      await s.asAdmin();
      const otherCo = await s.createCompany("Other Co (test)");
      const outsider = await s.createUser("office", { companyId: otherCo });
      await s.as(outsider);
      expect((await pgError(save(s, w.order.id, ok))).message).toMatch(/Order not found/);
      expect((await s.query("select 1 from public.order_stops where order_id = $1", [w.order.id])).rowCount).toBe(0);

      // Clients cannot write the table directly.
      await s.as(w.office);
      expect((await pgError(s.query("update public.order_stops set name = 'x' where order_id = $1", [w.order.id]))).code).toBe("42501");

      // Completed and canceled orders keep their stops as they were.
      await s.asAdmin();
      await s.query("update public.orders set status = 'canceled', canceled_at = now(), status_note = 'test' where id = $1", [w.order.id]);
      await s.as(w.office);
      expect((await pgError(save(s, w.order.id, ok))).message).toMatch(/completed or canceled/);
    });
  });
});
