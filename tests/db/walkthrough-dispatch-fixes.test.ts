// Dispatch and order fixes from the first-day walkthroughs (2026-11-14), batch 2:
//   D9 (20261120024110): an order whose delivery location is a delivery stop can be scheduled; with neither a site nor
//       a delivery stop it is still refused; the rollback restores the earlier rule.
//   D2 (20261120024120): the "already assigned" refusal names the day; the rollback restores the earlier sentence.
// D1 (20261120024100) is in tests/db/hired-trucks.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, sampleIds, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const rollback = (n: string) => readFileSync(join(__dirname, `../../supabase/rollbacks/${n}.down.sql`), "utf8").replace(/^\s*begin;\s*$/m, "").replace(/^\s*commit;\s*$/m, "");

/** A confirmed order dated `on` with no job site, optionally with extra draft fields. */
async function confirmedOrder(s: Session, user: string, on: string, extra: Record<string, unknown> = {}) {
  const ids = await sampleIds(s);
  await s.as(user);
  const r = await s.query<{ r: { order_id: string; order_number: string } }>("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
    customer_id: ids.customerId, order_date: on,
    lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel", unit_code: "ton", quantity: "10", unit_rate_cents: 1000 }],
    ...extra,
  })]);
  const id = r.rows[0].r.order_id;
  await s.query("select public.set_order_status($1, 'confirmed', '')", [id]);
  await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [id, JSON.stringify({ scheduled_start: on })]);
  return { id, number: r.rows[0].r.order_number };
}
const stops = (s: Session, order: string, list: Array<{ kind: string; name: string; city?: string; state?: string }>) =>
  s.query("select public.save_order_stops($1, $2::jsonb)", [order, JSON.stringify(list)]);
const schedule = (s: Session, order: string) => s.query("select public.set_order_status($1, 'scheduled', '')", [order]);
const status = async (s: Session, order: string) => (await s.query<{ status: string }>("select status from public.orders where id = $1", [order])).rows[0].status;

describe("D9: scheduling an order whose delivery location is a stop", () => {
  it("schedules an order with a delivery stop and no job site; refuses one with neither; a removed stop no longer counts", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const on = addDays(await businessToday(s), 2);

      // Freight entered the normal way: stops, and only the default state on the order (the walkthrough's "IN").
      const freight = await confirmedOrder(s, office, on, { site_state: "IN" });
      await stops(s, freight.id, [{ kind: "pickup", name: "Acme Steel (test)", city: "Gary", state: "IN" }, { kind: "delivery", name: "Willowmere Works (test)", city: "Goshen", state: "IN" }]);
      await schedule(s, freight.id);
      expect(await status(s, freight.id)).toBe("scheduled");

      // Neither a site nor a stop: refused as before, now naming the stop option.
      const bare = await confirmedOrder(s, office, on);
      expect((await pgError(schedule(s, bare.id))).message).toMatch(new RegExp(`^Add the delivery location to order ${bare.number} before scheduling it: .*or a delivery stop\\.$`));
      expect(await status(s, bare.id)).toBe("confirmed");

      // Stops taken off the order (marked removed) do not count.
      const cleared = await confirmedOrder(s, office, on);
      await stops(s, cleared.id, [{ kind: "pickup", name: "Yard (test)" }, { kind: "delivery", name: "Site (test)" }]);
      await stops(s, cleared.id, []);
      expect((await pgError(schedule(s, cleared.id))).message).toMatch(/Add the delivery location/);

      // A site name alone still counts (unchanged).
      const pickup = await confirmedOrder(s, office, on, { site_label: "Customer pickup at the yard" });
      await schedule(s, pickup.id);
      expect(await status(s, pickup.id)).toBe("scheduled");
    });
  });

  it("other refusals are unchanged: no date, a driver, another company's order", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const on = addDays(await businessToday(s), 2);
      const o = await confirmedOrder(s, office, on);
      await stops(s, o.id, [{ kind: "pickup", name: "Yard (test)" }, { kind: "delivery", name: "Site (test)" }]);
      await s.query("select public.update_order_schedule($1, null, $2::jsonb)", [o.id, JSON.stringify({ scheduled_start: null })]);
      expect((await pgError(schedule(s, o.id))).message).toMatch(/Set a scheduled date before marking the order scheduled/);
      const driver = await s.createUser("driver");
      await s.as(driver);
      expect((await pgError(schedule(s, o.id))).message).toMatch(/Order not found|permission|not allowed/i);
      const other = await s.createCompany("Other Co (test)");
      const stranger = await s.createUser("owner", { companyId: other });
      await s.as(stranger);
      expect((await pgError(schedule(s, o.id))).message).toMatch(/Order not found/);
    });
  });

  it("rollback 20261120024110 restores the earlier rule (a delivery stop alone does not count)", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const on = addDays(await businessToday(s), 2);
      const o = await confirmedOrder(s, office, on);
      await stops(s, o.id, [{ kind: "pickup", name: "Yard (test)" }, { kind: "delivery", name: "Site (test)" }]);
      await s.asAdmin();
      await s.query(rollback("20261120024110_schedule_order_with_stops"));
      await s.as(office);
      expect((await pgError(schedule(s, o.id))).message).toMatch(/^Add the delivery location to order .*"Customer pickup at the yard"\.$/);
      const named = await confirmedOrder(s, office, on, { site_label: "Customer pickup at the yard" });
      await schedule(s, named.id);
      expect(await status(s, named.id)).toBe("scheduled");
    });
  });
});

describe("D2: the conflict refusal names the day", () => {
  it("says the day of the other booking; the rollback restores the sentence without it", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const on = addDays(await businessToday(s), 4);
      const f = await fleet(s, office, on);
      const o1 = await scheduledOrder(s, office, on);
      const o2 = await scheduledOrder(s, office, on);
      const a = await planLoad(s, o1.id, on, "07:30", "09:00");
      const b = await planLoad(s, o2.id, on, "08:00", "10:00");
      await assign(s, a.load_id, f.t1, null, f.d1);
      const day = new Date(`${on}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
      expect((await pgError(assign(s, b.load_id, f.t1, null, f.d2))).message).toBe(`Truck ${(await s.query<{ u: string }>("select unit_number as u from public.trucks where id = $1", [f.t1])).rows[0].u} is already assigned to ${o1.number} load 1 on ${day} from 7:30 AM to 9:00 AM.`);
      await s.asAdmin();
      await s.query(rollback("20261120024120_conflict_message_date"));
      await s.as(office);
      expect((await pgError(assign(s, b.load_id, f.t1, null, f.d2))).message).toMatch(new RegExp(`is already assigned to ${o1.number} load 1 from 7:30 AM to 9:00 AM\\.$`));
    });
  });
});
