// Hired trucks (B83, migration 20261120003700): the add-on switch, haulers and their documents, offers sent only when
// documents are current, answers by the hired driver (or recorded by dispatch), confirmation through assign_load, the
// guard that keeps hired trucks off every other assignment path, and company isolation.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const one = async <T>(s: Session, sql: string, params: unknown[] = []) => (await s.query<{ r: T }>(sql, params)).rows[0].r;

async function entitle(s: Session, company = TOP_LINE) {
  await s.asAdmin();
  await s.query("insert into private.hired_trucks_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [company]);
}

/** A hauler with one truck and one driver (linked to a driver sign-in), all documents current unless told otherwise. */
async function hauler(s: Session, owner: string, on: string, skip: string[] = []) {
  await s.as(owner);
  const h = await one<string>(s, "select public.hauler_save(null, 'Ridgeline Hauling (test)', 'Pat', '555-0100', '', '', true) as r");
  const truck = await one<string>(s, "select public.hauler_add_truck($1, $2, 'tri_axle_dump', 'HT123') as r", [h, `H-${Math.random().toString(36).slice(2, 6)}`]);
  const driver = await one<string>(s, "select public.hauler_add_driver($1, 'Hired Driver (test)', '555-0101') as r", [h]);
  const far = addDays(on, 200);
  for (const [kind, truckId, exp] of [["insurance", null, far], ["w9", null, null], ["agreement", null, null], ["registration", truck, far], ["inspection", truck, far]] as const) {
    if (skip.includes(kind)) continue;
    await s.query("select public.hauler_record_document($1, $2, $3, 'ref', $4)", [h, truckId, kind, exp]);
  }
  // Hired drivers need the same qualifications as the company's own drivers.
  for (const kind of ["cdl", "medical_card"]) await s.query("insert into public.driver_qualifications (driver_id, kind, cdl_class, expires_on, verified_at) values ($1, $2, $3, $4, now())", [driver, kind, kind === "cdl" ? "A" : null, far]);
  const driverUser = await s.createUser("driver");
  await s.asAdmin();
  await s.query("update public.drivers set user_id = $2 where id = $1", [driver, driverUser]);
  await s.as(owner);
  return { h, truck, driver, driverUser };
}

describe("hired trucks", () => {
  it("is off until the platform owner switches it on; a company owner cannot switch it on", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect(await one<boolean>(s, "select public.hired_trucks_enabled() as r")).toBe(false);
      expect((await pgError(s.query("select public.hauler_save(null, 'X', '', '', '', '', true)"))).message).toMatch(/not switched on/);
      expect((await pgError(s.query("select public.platform_hired_trucks_set($1, true, '')", [TOP_LINE]))).message).toMatch(/Not available/);
      await entitle(s);
      await s.as(owner);
      expect(await one<boolean>(s, "select public.hired_trucks_enabled() as r")).toBe(true);
    });
  });

  it("an offer needs current documents; the hired driver accepts; dispatch confirms through assign_load", async () => {
    await withSession(async (s) => {
      await entitle(s);
      const owner = await s.createUser("owner");
      const on = addDays(await businessToday(s), 3);
      const order = await scheduledOrder(s, owner, on);
      const load = await planLoad(s, order.id, on, "08:00", "10:00", { planned_quantity: "20", unit_code: "ton" });
      const missing = await hauler(s, owner, on, ["w9", "inspection"]);
      const send = (truck: string, driver: string) => s.query("select public.hauler_offer_send($1, $2, null, $3, 1500, 'ton', 'Two loads of base') as r", [load.load_id, truck, driver]);
      const refused = await pgError(send(missing.truck, missing.driver));
      expect(refused.message).not.toMatch(/CDL/); // documents are checked first
      expect(refused.message).toMatch(/Not eligible: no W-9 on file; no truck inspection on file/);

      const ok = await hauler(s, owner, on);
      // The other hauler's driver cannot drive this hauler's truck.
      expect((await pgError(send(ok.truck, missing.driver))).message).toMatch(/same hauler/);
      // A hired truck cannot be assigned directly (board, Plan the day, Smart Dispatch).
      expect((await pgError(assign(s, load.load_id, ok.truck, null, ok.driver))).message).toMatch(/only through an accepted offer/);
      // Nor can a hired driver be put on one of the company's own trucks.
      const own = await fleet(s, owner, on);
      await s.as(owner);
      expect((await pgError(assign(s, load.load_id, own.t1, null, ok.driver))).message).toMatch(/only through an accepted offer/);

      const offer = (await send(ok.truck, ok.driver)).rows[0].r as string;
      expect((await pgError(send(ok.truck, ok.driver))).message).toMatch(/already has an open offer/);
      // Confirming before the hauler accepts is refused.
      expect((await pgError(s.query("select public.hauler_offer_confirm($1)", [offer]))).message).toMatch(/Only an accepted offer/);

      // The hired driver sees and answers their offer; another driver cannot.
      const stranger = await s.createUser("driver");
      await s.as(stranger);
      expect((await s.query("select id from public.hauler_offers where id = $1", [offer])).rows).toHaveLength(0);
      expect((await pgError(s.query("select public.hauler_offer_respond($1, true, '')", [offer]))).message).toMatch(/not yours|not found/);
      await s.as(ok.driverUser);
      expect((await s.query("select rate_cents, rate_unit from public.hauler_offers where id = $1", [offer])).rows).toEqual([{ rate_cents: 1500, rate_unit: "ton" }]);
      const mine = await one<Array<{ id: string; rate_cents: number; order_number: string; truck: string }>>(s, "select public.my_hauler_offers() as r");
      expect(mine.map((m) => [m.id, m.rate_cents, m.order_number])).toEqual([[offer, 1500, order.number]]);
      await s.as(stranger);
      expect(await one<unknown[]>(s, "select public.my_hauler_offers() as r")).toEqual([]);
      await s.as(ok.driverUser);
      expect(await one<string>(s, "select public.hauler_offer_respond($1, true, 'On my way') as r", [offer])).toBe("accepted");

      await s.as(owner);
      const assignment = await one<string>(s, "select public.hauler_offer_confirm($1) as r", [offer]);
      const a = (await s.query<{ truck_id: string; driver_id: string; status: string }>("select truck_id, driver_id, status from public.dispatch_assignments where id = $1", [assignment])).rows[0];
      expect(a).toEqual({ truck_id: ok.truck, driver_id: ok.driver, status: "active" });
      expect((await s.query("select status, by_phone from public.hauler_offers where id = $1", [offer])).rows[0]).toEqual({ status: "confirmed", by_phone: false });
    });
  });

  it("dispatch can record an answer given by phone, withdraw an open offer, and expired insurance stops confirmation", async () => {
    await withSession(async (s) => {
      await entitle(s);
      const owner = await s.createUser("owner");
      const on = addDays(await businessToday(s), 3);
      const order = await scheduledOrder(s, owner, on);
      const l1 = await planLoad(s, order.id, on, "08:00", "10:00");
      const l2 = await planLoad(s, order.id, on, "11:00", "12:00");
      const h = await hauler(s, owner, on);
      const o1 = await one<string>(s, "select public.hauler_offer_send($1, $2, null, $3, 9000, 'load', '') as r", [l1.load_id, h.truck, h.driver]);
      expect(await one<string>(s, "select public.hauler_offer_respond($1, false, 'Busy') as r", [o1])).toBe("declined");
      expect((await s.query("select by_phone from public.hauler_offers where id = $1", [o1])).rows[0].by_phone).toBe(true);

      const o2 = await one<string>(s, "select public.hauler_offer_send($1, $2, null, $3, 9000, 'load', '') as r", [l2.load_id, h.truck, h.driver]);
      await s.query("select public.hauler_offer_respond($1, true, '')", [o2]);
      // Insurance recorded again, now already expired: the newest record counts, so confirmation stops.
      await s.query("select public.hauler_record_document($1, null, 'insurance', 'lapsed', $2)", [h.h, addDays(on, -1)]);
      expect((await pgError(s.query("select public.hauler_offer_confirm($1)", [o2]))).message).toMatch(/certificate of insurance expired/);
      await s.query("select public.hauler_offer_withdraw($1, 'Insurance lapsed')", [o2]);
      expect((await s.query("select status from public.hauler_offers where id = $1", [o2])).rows[0].status).toBe("withdrawn");
    });
  });

  it("another company sees none of it and cannot use another company's hauler", async () => {
    await withSession(async (s) => {
      await entitle(s);
      const owner = await s.createUser("owner");
      const on = addDays(await businessToday(s), 3);
      const h = await hauler(s, owner, on);
      const other = await s.createCompany("Other Co (test)");
      await entitle(s, other);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select id from public.haulers where id = $1", [h.h])).rows).toHaveLength(0);
      expect((await s.query("select id from public.hauler_documents where hauler_id = $1", [h.h])).rows).toHaveLength(0);
      expect((await pgError(s.query("select public.hauler_add_driver($1, 'Sneaky', '')", [h.h]))).message).toMatch(/Hauler not found/);
      expect((await pgError(s.query("select public.hauler_record_document($1, null, 'w9', '', null)", [h.h]))).message).toMatch(/Hauler not found/);
    });
  });
});
