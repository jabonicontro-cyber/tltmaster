// Hauler settlements (B129, 20261120005700): a draft for one hauler and period with each confirmed job whose accepted
// tickets are in the offer's unit (others left out and counted), the hauler's commission and one-off deductions off the
// gross, approve → paid (recorded only) or void (jobs free again), a job in one live settlement at most, payroll.manage
// only, and company isolation.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const one = async <T>(s: Session, sql: string, params: unknown[] = []) => (await s.query<{ r: T }>(sql, params)).rows[0].r;

type Settlement = { status: string; gross_cents: string; commission_cents: string; deductions_cents: string; net_cents: string; commission_bp: number };
const row = async (s: Session, id: string) => (await s.query<Settlement>("select status, gross_cents, commission_cents, deductions_cents, net_cents, commission_bp from public.hauler_settlements where id = $1", [id])).rows[0];

describe("hauler settlements", () => {
  it("settles confirmed jobs with accepted tickets, takes commission and deductions, and moves through approve, paid and void", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      await s.query("insert into private.hired_trucks_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [TOP_LINE]);
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const today = await businessToday(s);
      const day = addDays(today, -2);
      const order = await scheduledOrder(s, owner, day);

      // A hauler with current documents; its driver signs in to answer offers.
      await s.as(owner);
      const h = await one<string>(s, "select public.hauler_save(null, 'Settlement Hauling (test)', 'Pat', '555-0100', '', '', true) as r");
      const truck = await one<string>(s, "select public.hauler_add_truck($1, $2, 'tri_axle_dump', '') as r", [h, `HS-${randomUUID().slice(0, 4)}`]);
      const driver = await one<string>(s, "select public.hauler_add_driver($1, 'Settled Driver (test)', '') as r", [h]);
      const far = addDays(today, 200);
      for (const [kind, truckId, exp] of [["insurance", null, far], ["w9", null, null], ["agreement", null, null], ["registration", truck, far], ["inspection", truck, far]] as const) {
        await s.query("select public.hauler_record_document($1, $2, $3, 'ref', $4)", [h, truckId, kind, exp]);
      }
      for (const kind of ["cdl", "medical_card"]) await s.query("insert into public.driver_qualifications (driver_id, kind, cdl_class, expires_on, verified_at) values ($1, $2, $3, $4, now())", [driver, kind, kind === "cdl" ? "A" : null, far]);
      const driverUser = await s.createUser("driver");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [driver, driverUser]);

      // Two confirmed jobs: one with an accepted 20-ton ticket at $15/ton, one with no ticket yet.
      const job = async (start: string, end: string) => {
        await s.as(owner);
        const load = await planLoad(s, order.id, day, start, end, { planned_quantity: "20", unit_code: "ton" });
        const offer = await one<string>(s, "select public.hauler_offer_send($1, $2, null, $3, 1500, 'ton', '') as r", [load.load_id, truck, driver]);
        await s.as(driverUser);
        await s.query("select public.hauler_offer_respond($1, true, '')", [offer]);
        await s.as(owner);
        await s.query("select public.hauler_offer_confirm($1)", [offer]);
        return { load: load.load_id, offer };
      };
      const paid = await job("07:00", "08:00");
      await job("09:00", "10:00");
      const t = await one<{ ticket_id: string }>(s, "select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
        load_id: paid.load, order_line_id: order.materialLine, delivered_date: day, delivered_time: "08:00", quantity: "20", unit_code: "ton", external_reference: `HS-${randomUUID().slice(0, 8)}` })]);
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);

      // Only payroll managers settle; commission 0–50 %.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.hauler_settlement_create($1, $2, $3)", [h, day, day]))).code).toBe("42501");
      await s.as(owner);
      expect((await pgError(s.query("select public.hauler_set_commission($1, 6000)", [h]))).message).toMatch(/0 to 50/);
      await s.query("select public.hauler_set_commission($1, 1000)", [h]);

      const first = await one<{ id: string; jobs: number; left_out: number }>(s, "select public.hauler_settlement_create($1, $2, $3) as r", [h, day, day]);
      expect([first.jobs, first.left_out]).toEqual([1, 1]);
      expect(await row(s, first.id)).toMatchObject({ status: "draft", gross_cents: "30000", commission_bp: 1000, commission_cents: "3000", deductions_cents: "0", net_cents: "27000" });

      // A one-off deduction with a reason; removing it restores the net.
      expect((await pgError(s.query("select public.hauler_settlement_deduct($1, ' ', 500)", [first.id]))).message).toMatch(/what the deduction/);
      await s.query("select public.hauler_settlement_deduct($1, 'Fuel advance', 5000)", [first.id]);
      expect((await row(s, first.id)).net_cents).toBe("22000");
      const extra = await one<string>(s, "select id as r from public.hauler_settlement_deductions where settlement_id = $1", [first.id]);
      await s.query("select public.hauler_settlement_deduct($1, 'Damage', 1000)", [first.id]);
      expect((await row(s, first.id)).net_cents).toBe("21000");
      await s.query("select public.hauler_settlement_remove_deduction($1)", [extra]);
      expect((await row(s, first.id)).net_cents).toBe("26000");

      // The settled job cannot go on a second settlement while this one is live.
      const second = await one<{ id: string; jobs: number }>(s, "select public.hauler_settlement_create($1, $2, $3) as r", [h, day, day]);
      expect(second.jobs).toBe(0);
      await s.query("select public.hauler_settlement_set_status($1, 'void', null, '', 'Empty')", [second.id]);

      // Paid only after approval; approved settlements are locked; a paid one cannot be voided.
      expect((await pgError(s.query("select public.hauler_settlement_set_status($1, 'paid', $2, 'CHK 1001', '')", [first.id, today]))).message).toMatch(/Approve/);
      await s.query("select public.hauler_settlement_set_status($1, 'approved', null, '', '')", [first.id]);
      expect((await pgError(s.query("select public.hauler_settlement_deduct($1, 'Late', 100)", [first.id]))).message).toMatch(/Only a draft/);
      expect((await pgError(s.query("select public.hauler_settlement_set_status($1, 'paid', $2, '', '')", [first.id, addDays(today, 1)]))).message).toMatch(/not in the future/);
      await s.query("select public.hauler_settlement_set_status($1, 'paid', $2, 'CHK 1001', '')", [first.id, today]);
      expect((await row(s, first.id)).status).toBe("paid");
      expect((await pgError(s.query("select public.hauler_settlement_set_status($1, 'void', null, '', 'Oops')", [first.id]))).message).toMatch(/paid settlement/);

      // A void needs a reason and frees its jobs for a new settlement.
      const third = await one<{ id: string; jobs: number }>(s, "select public.hauler_settlement_create($1, $2, $3) as r", [h, addDays(day, -10), addDays(day, 10)]);
      expect(third.jobs).toBe(0); // the settled job is in the paid one
      expect((await pgError(s.query("select public.hauler_settlement_set_status($1, 'void', null, '', '')", [third.id]))).message).toMatch(/why/);

      // Other companies see nothing and change nothing.
      const other = await s.createCompany(`Settle Other ${randomUUID().slice(0, 6)} (test)`);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await s.query("select 1 from public.hauler_settlements where id = $1", [first.id])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.hauler_settlement_set_status($1, 'void', null, '', 'x')", [third.id]))).code).toBe("P0002");
      // A dispatcher without payroll or billing access does not see settlements.
      await s.as(dispatcher);
      expect((await s.query("select 1 from public.hauler_settlements where id = $1", [first.id])).rowCount).toBe(0);
    });
  });
});
