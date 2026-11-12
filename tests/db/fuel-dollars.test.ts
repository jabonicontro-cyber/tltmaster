// Fuel receipt dollars for money access only (owner 2026-11-12, master plan §12 SEC5, 20261120019800): what a fuel
// receipt cost (fuel_purchases.total_cents) is not readable from the table by anyone signed in, in SQL or through the
// REST API; public.fuel_purchase_amounts returns it to billing.view only (owner, office, outside accountant), in the
// person's own company. Dispatchers, mechanics and drivers still read gallons, odometer, state, vendor and receipt
// number, and drivers and the office still record receipts with their total.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { TOP_LINE, pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const READABLE = "id, truck_id, driver_id, purchased_on, jurisdiction, gallons, odometer, vendor, receipt_ref, voided, void_reason";

const amounts = (s: Session, from: string, to: string, truck: string | null = null) =>
  s.query<{ purchase_id: string; total_cents: number }>("select purchase_id, total_cents from public.fuel_purchase_amounts($1, $2, $3)", [from, to, truck]);

describe("fuel receipt dollars (SEC5)", () => {
  it("only billing.view reads what fuel cost; everyone else reads the receipt without it; receipts are still recorded", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const day = addDays(today, -1);
      const f = await fleet(s, owner, day);
      const order = await scheduledOrder(s, owner, day);
      const load = await planLoad(s, order.id, day, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
      await assign(s, load.load_id, f.t1, null, f.d1);
      const driverUser = await s.createUser("driver");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);
      const record = (truck: string, extra: Record<string, unknown> = {}) =>
        s.query<{ r: string }>("select public.fuel_record_purchase($1::jsonb) as r", [JSON.stringify({ truck_id: truck, purchased_on: day, jurisdiction: "IA", gallons: "80.5", total_cents: 31000, odometer: 120400, vendor: "Fuel stop (test)", receipt_ref: "R-1", ...extra })]);

      // Recording is unchanged: the driver for the truck they drove, the office for any truck, both with the total.
      await s.as(driverUser);
      const driverBuy = (await record(f.t1)).rows[0].r;
      await s.as(owner);
      const officeBuy = (await record(f.t2, { jurisdiction: "NE", total_cents: 25050, receipt_ref: "R-2" })).rows[0].r;

      const dispatcher = await s.createUser("dispatcher");
      const mechanic = await s.createUser("mechanic");
      for (const [who, label] of [[dispatcher, "dispatcher"], [mechanic, "mechanic"], [driverUser, "driver"]] as const) {
        await s.as(who);
        expect((await pgError(s.query("select total_cents from public.fuel_purchases where id = $1", [driverBuy]))).code, label).toBe("42501");
        expect((await pgError(s.query("select * from public.fuel_purchases where id = $1", [driverBuy]))).code, label).toBe("42501");
        expect((await pgError(s.query("select sum(total_cents) from public.fuel_purchases"))).code, label).toBe("42501");
        // Filtering or sorting by the amount would leak it too.
        expect((await pgError(s.query("select id from public.fuel_purchases where total_cents > 0"))).code, label).toBe("42501");
        expect((await pgError(amounts(s, day, day))).code, label).toBe("42501");
        // Everything else on the receipt reads as before (the driver: their own receipt).
        const row = (await s.query(`select ${READABLE} from public.fuel_purchases where id = $1`, [driverBuy])).rows[0];
        expect(row, label).toMatchObject({ id: driverBuy, jurisdiction: "IA", gallons: "80.500", odometer: 120400, vendor: "Fuel stop (test)", receipt_ref: "R-1" });
      }
      // The fleet roles read the whole company's receipts (the IFTA summary); the driver only their own.
      await s.as(dispatcher);
      expect((await s.query("select id from public.fuel_purchases where id = any($1)", [[driverBuy, officeBuy]])).rowCount).toBe(2);
      await s.as(driverUser);
      expect((await s.query("select id from public.fuel_purchases where id = any($1)", [[driverBuy, officeBuy]])).rows).toEqual([{ id: driverBuy }]);

      // Owner and office: the amounts through the function only (the column stays closed to them too).
      const office = await s.createUser("office");
      for (const [who, label] of [[owner, "owner"], [office, "office"]] as const) {
        await s.as(who);
        expect((await pgError(s.query("select total_cents from public.fuel_purchases where id = $1", [driverBuy]))).code, label).toBe("42501");
        const all = (await amounts(s, day, day)).rows.filter((r) => [driverBuy, officeBuy].includes(r.purchase_id));
        expect(all.sort((a, b) => a.total_cents - b.total_cents), label).toEqual([{ purchase_id: officeBuy, total_cents: 25050 }, { purchase_id: driverBuy, total_cents: 31000 }]);
        // One truck, and only the days asked for.
        expect((await amounts(s, day, day, f.t2)).rows, label).toEqual([{ purchase_id: officeBuy, total_cents: 25050 }]);
        expect((await amounts(s, addDays(day, -30), addDays(day, -1), f.t2)).rowCount, label).toBe(0);
        expect((await pgError(amounts(s, day, addDays(day, -1)))).code, label).toBe("22023");
      }
      // A voided receipt keeps its amount (listed as void).
      await s.as(owner);
      await s.query("select public.fuel_void('purchase', $1, 'Typed twice (test)')", [officeBuy]);
      expect((await amounts(s, day, day, f.t2)).rows).toEqual([{ purchase_id: officeBuy, total_cents: 25050 }]);

      // The outside accountant (billing.view and accounting.view, read-only) reads the amounts.
      const accountant = await s.createUser("driver", { membership: false });
      await s.query("insert into private.account_provisions (request_key, company_id, kind, username, user_id) values (gen_random_uuid(), $1, 'employee', $2, $3)", [TOP_LINE, `acct-${accountant.slice(0, 8)}`, accountant]);
      await s.as(owner);
      await s.query("select public.accountant_grant($1, 'Avery Ledger (test)', $2, false)", [accountant, addDays(today, 30)]);
      await s.as(accountant);
      expect((await pgError(s.query("select total_cents from public.fuel_purchases where id = $1", [driverBuy]))).code).toBe("42501");
      expect((await amounts(s, day, day, f.t1)).rows).toEqual([{ purchase_id: driverBuy, total_cents: 31000 }]);

      // A billing person of another company never sees them.
      const other = await s.createCompany(`Fuel Dollars Other ${randomUUID().slice(0, 6)} (test)`);
      await s.as(await s.createUser("office", { companyId: other }));
      expect((await amounts(s, day, day)).rows.filter((r) => [driverBuy, officeBuy].includes(r.purchase_id))).toEqual([]);

      // Taking billing.view away from the office takes the amounts away too (the permission, not the role name).
      await s.asAdmin();
      await s.query("delete from public.role_permissions where company_id = $1 and role = 'office' and permission = 'billing.view'", [TOP_LINE]);
      await s.as(office);
      expect((await pgError(amounts(s, day, day))).code).toBe("42501");
    });
  });

  it("every fuel purchase column but the amount is readable by signed-in people (a column added later needs its own grant)", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const cols = (await s.query<{ attname: string; readable: boolean }>(
        "select a.attname, has_column_privilege('authenticated', 'public.fuel_purchases', a.attname, 'select') readable from pg_attribute a where a.attrelid = 'public.fuel_purchases'::regclass and a.attnum > 0 and not a.attisdropped")).rows;
      expect(cols.filter((c) => !c.readable).map((c) => c.attname)).toEqual(["total_cents"]);
      expect((await s.query<{ t: boolean; anon: boolean }>("select has_table_privilege('authenticated', 'public.fuel_purchases', 'select') t, has_any_column_privilege('anon', 'public.fuel_purchases', 'select') anon")).rows[0]).toEqual({ t: false, anon: false });
    });
  });
});

// The same through the REST API the app uses, with real signed tokens (local stack only).
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
for (const file of [".dev-stack/keys.env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const restUp = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_) && Boolean(env.DEV_JWT_SECRET && env.DEV_ANON_KEY) &&
  (await fetch(`${URL_}/rest/v1/`, { headers: { apikey: env.DEV_ANON_KEY ?? "" } }).then((r) => r.status < 500).catch(() => false));
if (!restUp) console.warn("Local Supabase API is not running: the REST checks for fuel dollars are skipped (scripts/dev-stack/stack.sh up).");

function token(sub: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", aud: "authenticated", aal: "aal2", iat: now, exp: now + 600 })}`;
  return `${head}.${createHmac("sha256", env.DEV_JWT_SECRET).update(head).digest("base64url")}`;
}
const rest = (sub: string) => createClient(URL_, env.DEV_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token(sub)}` } } });

describe.skipIf(!restUp)("fuel receipt dollars through the REST API (SEC5)", () => {
  it("a dispatcher and a mechanic get gallons but not the amount; the office gets the amounts from the function", async () => {
    // Committed test people in Top Line (the API cannot see an open test transaction); removed afterwards.
    const people: Record<string, string> = {};
    const client = await pool.connect();
    try {
      for (const role of ["dispatcher", "mechanic", "office"]) {
        const id = randomUUID();
        await client.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, `fuel-dollars-${role}-${id.slice(0, 8)}@test.example`]);
        await client.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, $3, true)", [TOP_LINE, id, role]);
        people[role] = id;
      }
      const today = (await client.query<{ d: string }>("select private.business_today($1)::text as d", [TOP_LINE])).rows[0].d;
      const from = addDays(today, -90);
      for (const role of ["dispatcher", "mechanic"]) {
        const db = rest(people[role]);
        const money = await db.from("fuel_purchases").select("id, total_cents").limit(1);
        expect(money.error?.code, role).toBe("42501");
        const star = await db.from("fuel_purchases").select("*").limit(1);
        expect(star.error?.code, role).toBe("42501");
        const fuel = await db.from("fuel_purchases").select(READABLE).limit(1);
        expect(fuel.error, role).toBeNull();
        const fn = await db.rpc("fuel_purchase_amounts", { p_from: from, p_to: today, p_truck: null });
        expect(fn.error?.code, role).toBe("42501");
      }
      const office = rest(people.office);
      expect((await office.from("fuel_purchases").select("total_cents").limit(1)).error?.code).toBe("42501");
      const fn = await office.rpc("fuel_purchase_amounts", { p_from: from, p_to: today, p_truck: null });
      expect(fn.error).toBeNull();
      expect(Array.isArray(fn.data)).toBe(true);
    } finally {
      for (const id of Object.values(people)) {
        await client.query("delete from public.company_memberships where user_id = $1", [id]);
        await client.query("delete from auth.users where id = $1", [id]);
      }
      client.release();
    }
  });
});
