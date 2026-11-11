// Freight demo (MK3, owner 2026-11-05: a separate freight demo company): Cobalt Plains Freight is set up through the
// same app functions as every company, says bills of lading (What you haul = General freight), every load has
// shipper-to-receiver stops, recent days are delivered with BOL references, tomorrow has an open load, a second
// Refresh adds nothing, and a real company is refused. Runs against the local stack with real signed user tokens.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, todayIn } from "@/lib/dates";
import { FREIGHT_DEMO, FREIGHT_LANES, refreshFreightDemo, seedFreightDemo } from "@/server/demo/freight-demo";

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
if (existsSync(".dev-stack/keys.env")) {
  for (const line of readFileSync(".dev-stack/keys.env", "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const DB = env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54322/postgres";
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_) && /127\.0\.0\.1|localhost/.test(DB);
const available = local && Boolean(env.DEV_JWT_SECRET && env.DEV_ANON_KEY && env.DEV_SERVICE_ROLE_KEY) &&
  (await fetch(`${URL_}/rest/v1/`, { headers: { apikey: env.DEV_ANON_KEY ?? "" } }).then((r) => r.status < 500).catch(() => false));
if (!available) console.warn("Local Supabase is not running: freight demo tests are skipped (scripts/dev-stack/stack.sh up).");

const TOP_LINE = "00000000-0000-4000-8000-000000000001";
const TZ = "America/Chicago";

function token(sub: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", aud: "authenticated", iat: now, exp: now + 1800 })}`;
  return `${head}.${createHmac("sha256", env.DEV_JWT_SECRET).update(head).digest("base64url")}`;
}
const as = (sub: string): SupabaseClient =>
  createClient(URL_, env.DEV_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token(sub)}` } } });

const pool = new pg.Pool({ connectionString: DB, max: 2 });
const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => pool.query<T>(sql, params);
const w: { company: string; owner: string; realOwner: string } = { company: "", owner: "", realOwner: "" };

async function newUser(label: string) {
  const admin = createClient(URL_, env.DEV_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.createUser({ email: `${label}-${randomUUID().slice(0, 8)}@freightdemo.example`, password: `Pw-${randomUUID()}`, email_confirm: true });
  if (error) throw error;
  return data.user.id;
}

describe.skipIf(!available)("freight demo company", () => {
  beforeAll(async () => {
    w.company = (await q<{ id: string }>("select private.create_company($1, $2) as id", [`${FREIGHT_DEMO.name} ${randomUUID().slice(0, 6)}`, `prospect-freight-${randomUUID().slice(0, 6)}`])).rows[0].id;
    await q("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [w.company]);
    await q("update public.company_settings set timezone = $2 where company_id = $1", [w.company, TZ]);
    w.owner = await newUser("freight-owner");
    await q("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [w.company, w.owner]);
    await q("update public.profiles set active_company_id = $1 where id = $2", [w.company, w.owner]);
    w.realOwner = await newUser("real-owner");
    await q("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [TOP_LINE, w.realOwner]);
    await q("update public.profiles set active_company_id = $1 where id = $2", [TOP_LINE, w.realOwner]);
  }, 60_000);
  afterAll(() => pool.end());

  it("is a general-freight carrier with stops on every load, delivered days with BOLs and an open load tomorrow", async () => {
    const r = await seedFreightDemo(as(w.owner), TZ);
    expect(r.loads).toBeGreaterThanOrEqual(20);
    const settings = (await q<{ industry: string; company_name: string }>("select industry, company_name from public.company_settings where company_id = $1", [w.company])).rows[0];
    expect(settings).toEqual({ industry: "freight", company_name: FREIGHT_DEMO.name });

    const orders = (await q<{ id: string; stops: string[] }>(
      `select o.id, coalesce((select array_agg(s.kind order by s.seq) from public.order_stops s where s.order_id = o.id and s.removed_at is null), '{}') stops
         from public.orders o where o.company_id = $1 and o.project_name = any($2)`, [w.company, FREIGHT_LANES.map((l) => l.project)])).rows;
    expect(orders.length).toBeGreaterThanOrEqual(20);
    expect(orders.every((o) => o.stops.length >= 2 && o.stops[0] === "pickup" && o.stops[o.stops.length - 1] === "delivery")).toBe(true);
    expect(orders.some((o) => o.stops.length === 3)).toBe(true); // a two-drop load

    const priced = (await q<{ units: string[] }>("select array_agg(distinct l.unit_code) units from public.order_lines l join public.orders o on o.id = l.order_id where l.company_id = $1 and o.project_name = any($2)", [w.company, FREIGHT_LANES.map((x) => x.project)])).rows[0].units;
    expect(priced.sort()).toEqual(["load", "mile"]);
    const bols = (await q<{ n: string }>("select count(*) n from public.delivery_tickets where company_id = $1 and status = 'accepted' and external_reference like 'BOL %'", [w.company])).rows[0].n;
    expect(Number(bols)).toBeGreaterThanOrEqual(15);

    const tomorrow = addDays(todayIn(TZ), 1);
    const open = (await q<{ n: string }>(
      `select count(*) n from public.order_loads l where l.company_id = $1 and l.load_date = $2
         and not exists (select 1 from public.dispatch_assignments a where a.load_id = l.id and a.status = 'active')`, [w.company, tomorrow])).rows[0].n;
    expect(Number(open)).toBeGreaterThanOrEqual(1);
    // Freight equipment (MK4, 20261120008100): dry vans, a reefer, a flatbed and a step deck, payloads in pounds;
    // no dump bodies anywhere (the shared hired-truck sample hires box trucks), and tons are not offered as a unit.
    const fleet = (await q<{ trucks: string; vans: string; reefers: string; decks: string; drivers: string; dumps: string; tons: string; lb: string }>(
      `select (select count(*) from public.trucks where company_id = $1 and truck_type = 'tractor') trucks,
              (select count(*) from public.trailers where company_id = $1 and trailer_type = 'dry_van') vans,
              (select count(*) from public.trailers where company_id = $1 and trailer_type = 'reefer') reefers,
              (select count(*) from public.trailers where company_id = $1 and trailer_type in ('flatbed', 'step_deck')) decks,
              (select count(*) from public.drivers where company_id = $1) drivers,
              (select count(*) from public.trucks where company_id = $1 and truck_type::text like '%dump%')
                + (select count(*) from public.trailers where company_id = $1 and trailer_type::text like '%dump%') dumps,
              (select count(*) from public.units_of_measure where company_id = $1 and code in ('ton', 'cu_yd') and active) tons,
              (select count(*) from public.trailers where company_id = $1 and weight_unit = 'lb') lb`, [w.company])).rows[0];
    expect([fleet.trucks, fleet.vans, fleet.reefers, fleet.decks, fleet.dumps, fleet.tons, fleet.lb].map(Number)).toEqual([8, 3, 1, 2, 0, 0, 6]);
    expect(Number(fleet.drivers)).toBeGreaterThanOrEqual(8);
    // Shared samples speak freight: shippers and receivers instead of quarries, a brokerage instead of a stone yard,
    // and the database-written sample cases reworded.
    const words = (await q<{ quarries: string; stone: string; shippers: string; logistics: string }>(
      `select (select count(*) from public.company_locations where company_id = $1 and kind in ('quarry', 'plant', 'pickup')) quarries,
              (select count(*) from public.portal_support_requests where company_id = $1 and subject ilike '%stone%')
                + (select count(*) from public.booking_requests where company_id = $1 and material ilike '%pour%')
                + (select count(*) from public.billing_entities where company_id = $1 and name ilike '%stone%') stone,
              (select count(*) from public.company_locations where company_id = $1 and kind in ('shipper', 'receiver', 'warehouse')) shippers,
              (select count(*) from public.billing_entities where company_id = $1 and name ilike '%logistics%') logistics`, [w.company])).rows[0];
    expect([words.quarries, words.stone].map(Number)).toEqual([0, 0]);
    expect(Number(words.shippers)).toBeGreaterThanOrEqual(4);
    // Detention (DT1): one demo customer has free time and a rate; extra charges are billed without a ticket.
    const det = (await q<{ customers: string; ticketless: string }>(
      `select (select count(*) from public.customers where company_id = $1 and detention_rate_cents is not null) customers,
              (select count(*) from public.charge_items where company_id = $1 and code in ('DET-HR', 'LUMPER', 'TONU') and not ticket_required) ticketless`, [w.company])).rows[0];
    expect([Number(det.customers), Number(det.ticketless)]).toEqual([1, 3]);
    // Shop decisions (MD1, demo_shop_decision_samples): every truck of the freight demo already has open shop work, so
    // the certificate and the unit parked by hand fall back to a trailer, or to a truck without safety-critical open
    // work for the certificate (20261120019500). All four samples are there, each once.
    const md1 = (await q<{ waiting: string; ignored: string; unchecked: string; parked: string; unsafe: string }>(`select
        (select count(*) from public.work_orders where company_id = $1 and status = 'awaiting_parts' and work_started_at is null and not safety_critical and title = 'Replace torn driver seat cushion (demo)') waiting,
        (select count(*) from public.audit_events where company_id = $1 and action = 'truck.reading_ignored') ignored,
        (select count(*) from public.vehicle_documents where company_id = $1 and work_order_id is not null and verified_at is null and archived_at is null) unchecked,
        (select count(*) from public.trucks t where t.company_id = $1 and t.service_status = 'out_of_service'
           and not exists (select 1 from public.work_orders o where o.truck_id = t.id and o.status not in ('completed', 'closed', 'canceled'))
           and exists (select 1 from public.work_orders o where o.truck_id = t.id and o.status in ('completed', 'closed') and o.completed_at >= t.out_of_service_since))
        + (select count(*) from public.trailers t where t.company_id = $1 and t.service_status = 'out_of_service'
           and not exists (select 1 from public.work_orders o where o.trailer_id = t.id and o.status not in ('completed', 'closed', 'canceled'))
           and exists (select 1 from public.work_orders o where o.trailer_id = t.id and o.status in ('completed', 'closed') and o.completed_at >= t.out_of_service_since)) parked,
        -- The certificate never lands on a vehicle with an open safety-critical job.
        (select count(*) from public.vehicle_documents d join public.work_orders o on o.company_id = d.company_id and o.safety_critical
            and o.status not in ('completed', 'closed', 'canceled') and (o.truck_id = d.truck_id or o.trailer_id = d.trailer_id)
          where d.company_id = $1 and d.work_order_id is not null and d.verified_at is null and d.archived_at is null) unsafe`, [w.company])).rows[0];
    expect([md1.waiting, md1.unchecked, md1.parked, md1.unsafe].map(Number)).toEqual([1, 1, 1, 0]);
    expect(Number(md1.ignored)).toBeGreaterThanOrEqual(1);
    // The office's lists read them through the app's own functions.
    const back = await as(w.owner).rpc("units_back_from_shop");
    expect(back.error).toBeNull();
    expect((back.data as unknown[]).length).toBe(1);
  }, 300_000);

  it("a second Refresh adds no loads or records, and keeps the stops", async () => {
    const before = (await q<{ loads: string; stops: string; customers: string }>(
      `select (select count(*) from public.order_loads where company_id = $1) loads, (select count(*) from public.order_stops where company_id = $1) stops,
              (select count(*) from public.customers where company_id = $1) customers`, [w.company])).rows[0];
    const r = await refreshFreightDemo(as(w.owner), TZ);
    expect(r.loads).toBe(0);
    const after = (await q<{ loads: string; stops: string; customers: string }>(
      `select (select count(*) from public.order_loads where company_id = $1) loads, (select count(*) from public.order_stops where company_id = $1) stops,
              (select count(*) from public.customers where company_id = $1) customers`, [w.company])).rows[0];
    expect(after).toEqual(before);
  }, 300_000);

  it("is refused for a real company, which is left untouched", async () => {
    const loads = async () => Number((await q<{ n: string }>("select count(*) n from public.order_loads where company_id = $1", [TOP_LINE])).rows[0].n);
    const before = await loads();
    await expect(seedFreightDemo(as(w.realOwner), TZ)).rejects.toThrow(/only set up in a demo company/);
    await expect(refreshFreightDemo(as(w.realOwner), TZ)).rejects.toThrow(/only set up in a demo company/);
    expect(await loads()).toBe(before);
  }, 60_000);
});
