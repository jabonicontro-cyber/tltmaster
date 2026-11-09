// Demo feature parity (CLAUDE.md, docs/DEMO_TENANTS.md §3): the shared samples (src/server/demo/samples.ts) give a
// demo company data for every released feature, existing demos receive them through Refresh, a second run adds
// nothing and keeps every demo user, and a real company is refused. Runs the real seed and Refresh against the
// local stack with real signed user tokens (PostgREST + RLS); skipped when the local stack is not running.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planningSpeed, reviewPace, billingReadySpeed } from "@/lib/command-center/speed";
import { todayIn } from "@/lib/dates";
import { seedPrairieLantern } from "@/server/demo/prairie-lantern";
import { refreshPrairieLantern } from "@/server/demo/prairie-lantern-refresh";
import { ensureFeatureSamples } from "@/server/demo/samples";

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
if (!available) console.warn("Local Supabase is not running: demo sample tests are skipped (scripts/dev-stack/stack.sh up).");

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
  const { data, error } = await admin.auth.admin.createUser({ email: `${label}-${randomUUID().slice(0, 8)}@demosamples.example`, password: `Pw-${randomUUID()}`, email_confirm: true });
  if (error) throw error;
  return data.user.id;
}
async function counts(company: string) {
  const one = async (sql: string) => Number((await q<{ n: string }>(sql, [company])).rows[0].n);
  return {
    workOrders: await one("select count(*) n from public.work_orders where company_id = $1"),
    schedules: await one("select count(*) n from public.maintenance_schedules where company_id = $1"),
    documents: await one("select count(*) n from public.vehicle_documents where company_id = $1"),
    timeOff: await one("select count(*) n from public.time_off_requests where company_id = $1"),
    ptoEntries: await one("select count(*) n from public.pto_ledger where company_id = $1"),
    quotes: await one("select count(*) n from public.quotes where company_id = $1"),
    workspaces: await one("select count(*) n from public.operation_workspaces where company_id = $1"),
    loads: await one("select count(*) n from public.order_loads where company_id = $1"),
    drivers: await one("select count(*) n from public.drivers where company_id = $1"),
    handoffs: await one("select count(*) n from public.billing_handoffs where company_id = $1"),
    memberships: (await q<{ user_id: string; role: string; active: boolean }>("select user_id, role, active from public.company_memberships where company_id = $1 order by user_id", [company])).rows,
  };
}

describe.skipIf(!available)("demo feature samples", () => {
  beforeAll(async () => {
    w.company = (await q<{ id: string }>("select private.create_company($1, $2) as id", [`Samples Demo ${randomUUID().slice(0, 6)}`, `prospect-samples-${randomUUID().slice(0, 6)}`])).rows[0].id;
    await q("update public.companies set is_demo = true, demo_kind = 'prospect', timezone = $2 where id = $1", [w.company, TZ]).catch(() => q("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [w.company]));
    // Hired trucks is the platform owner's switch (B83); switched on here as the console would.
    await q("insert into private.hired_trucks_entitlements (company_id, entitled) values ($1, true) on conflict do nothing", [w.company]).catch(() => undefined);
    w.owner = await newUser("demo-owner");
    await q("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [w.company, w.owner]);
    await q("update public.profiles set active_company_id = $1 where id = $2", [w.company, w.owner]);
    w.realOwner = await newUser("real-owner");
    await q("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [TOP_LINE, w.realOwner]);
    await q("update public.profiles set active_company_id = $1 where id = $2", [TOP_LINE, w.realOwner]);
  }, 60_000);
  afterAll(async () => {
    if (w.company) await q("update public.companies set active = false where id = $1", [w.company]);
    if (w.realOwner) await q("update public.company_memberships set active = false where company_id = $1 and user_id = $2", [TOP_LINE, w.realOwner]);
    await pool.end();
  });

  it("a new demo has sample data for every released feature", async () => {
    await seedPrairieLantern(as(w.owner), TZ);
    const c = await counts(w.company);
    expect(c.workOrders).toBeGreaterThanOrEqual(3);
    expect(c.schedules).toBeGreaterThan(0);
    expect(c.documents).toBeGreaterThan(0);
    expect(c.timeOff).toBe(5); // two earlier samples and three on the Schedule (approved, pending, denied)
    expect(c.quotes).toBeGreaterThanOrEqual(1);
    expect(c.workspaces).toBe(1);
    // Plan the day has open loads to plan tomorrow (docs/OPTIMIZATION.md §4).
    const open = await q<{ n: string }>(
      "select count(*) n from public.order_loads l where l.company_id = $1 and l.load_date = ($2::date + 1) and l.status = 'planned' and not exists (select 1 from public.dispatch_assignments a where a.load_id = l.id and a.status = 'active')",
      [w.company, todayIn(TZ)],
    );
    expect(Number(open.rows[0].n)).toBeGreaterThanOrEqual(4);
    // Copy the previous crew (B85): at least one of tomorrow's open loads belongs to an order a crew worked earlier.
    const copyable = await q<{ n: string }>(
      `select count(*) n from public.order_loads l
        where l.company_id = $1 and l.load_date = ($2::date + 1) and l.status = 'planned'
          and not exists (select 1 from public.dispatch_assignments a where a.load_id = l.id and a.status = 'active')
          and exists (select 1 from public.order_loads e join public.dispatch_assignments a on a.load_id = e.id and a.status = 'active'
                       where e.order_id = l.order_id and e.load_date < l.load_date and e.load_date >= l.load_date - 14)`,
      [w.company, todayIn(TZ)],
    );
    expect(Number(copyable.rows[0].n)).toBeGreaterThanOrEqual(1);
    // Time-off balances (20261112000100): one Paid time off bank and an opening grant (demo data) per current employee.
    const banks = await q<{ name: string }>("select name from public.pto_banks where company_id = $1 and active", [w.company]);
    expect(banks.rows.map((r) => r.name)).toEqual(["Paid time off"]);
    const grants = await q<{ n: string; note: string }>("select count(*) n, min(note) note from public.pto_ledger where company_id = $1 and kind = 'grant'", [w.company]);
    expect(Number(grants.rows[0].n)).toBeGreaterThanOrEqual(3);
    expect(grants.rows[0].note).toMatch(/^Demo:/);
    const accrued = await q<{ n: string }>("select count(*) n from public.pto_ledger where company_id = $1 and kind = 'accrual'", [w.company]);
    expect(Number(accrued.rows[0].n)).toBeGreaterThan(0); // the demo policy's pay periods so far
    // Billing shows every state: an order delivered exactly as ordered (ready) and one handed off (internal batch).
    const readiness = ((await as(w.owner).from("billing_order_status").select("readiness")).data ?? []).map((r) => (r as { readiness: string }).readiness);
    expect(readiness).toContain("ready");
    expect(readiness).toContain("handed_off");
    expect(c.handoffs).toBeGreaterThanOrEqual(1); // the billing sample's batch (and the invoice sample's, when it hands off more)
    // Trailer work orders (20261115000100): one scheduled trailer inspection, nothing taken out of service.
    const trailerWo = await q<{ n: string; down: string }>(
      "select count(*) n, count(*) filter (where t.service_status = 'out_of_service') down from public.work_orders w join public.trailers t on t.id = w.trailer_id where w.company_id = $1", [w.company]);
    expect([Number(trailerWo.rows[0].n), Number(trailerWo.rows[0].down)]).toEqual([1, 0]);
    // Site directions verification (20261115000200): a flagged critical site, a verified critical site (audited),
    // and a standard unverified one.
    const sites = await q<{ risk: string; verified: boolean }>(
      "select directions_risk risk, directions_verified_at is not null verified from public.customer_sites where company_id = $1 and coalesce(directions, '') <> '' order by 1, 2", [w.company]);
    expect(sites.rows).toEqual([{ risk: "safety_access", verified: false }, { risk: "safety_access", verified: true }, { risk: "standard", verified: false }]);
    const verifiedAudit = await q<{ n: string }>("select count(*) n from public.audit_events where company_id = $1 and action = 'site_directions_verified'", [w.company]);
    expect(Number(verifiedAudit.rows[0].n)).toBe(1);
    // Upcoming orders at the sample sites are linked to them (normal order edit), so dispatch and My Day show the status.
    const linkedOrders = await q<{ n: string }>(
      "select count(*) n from public.orders o join public.customer_sites cs on cs.id = o.site_id where o.company_id = $1 and coalesce(cs.directions, '') <> ''", [w.company]);
    expect(Number(linkedOrders.rows[0].n)).toBeGreaterThan(0);
    // Quotes show an issued, locked version: one quote marked handed over outside Taviron (nothing sent).
    const sent = await q<{ n: string }>("select count(*) n from public.quotes q join public.quote_versions v on v.id = q.current_version_id where q.company_id = $1 and q.status = 'sent' and v.sent_at is not null", [w.company]);
    expect(Number(sent.rows[0].n)).toBe(1);
    const delivered = await q<{ n: string }>("select count(*) n from public.email_deliveries d join public.quotes q on q.id = d.quote_id where q.company_id = $1 and d.channel <> 'manual'", [w.company]);
    expect(Number(delivered.rows[0].n)).toBe(0); // no email was recorded as sent
    // The Command Center's "Assigned to you" has one item for the person viewing the demo.
    const mine = await q<{ n: string }>("select count(*) n from public.exception_assignments where company_id = $1 and assigned_to = $2 and ended_at is null", [w.company, w.owner]);
    expect(Number(mine.rows[0].n)).toBe(1);
    // Dispatch's "Needs scheduling" queue has a confirmed order without a date.
    const waiting = await q<{ n: string }>("select count(*) n from public.orders where company_id = $1 and status = 'confirmed' and scheduled_start is null", [w.company]);
    expect(Number(waiting.rows[0].n)).toBeGreaterThanOrEqual(1);
    // Payroll: one open period over the last two weeks, and no pay rule (rules are never invented, docs/PAYROLL.md).
    const periods = await q<{ status: string }>("select status from public.payroll_periods where company_id = $1", [w.company]);
    expect(periods.rows).toEqual([{ status: "open" }]);
    const rules = await q<{ n: string }>("select count(*) n from public.pay_rules where company_id = $1", [w.company]);
    expect(Number(rules.rows[0].n)).toBe(0);
    // CRM: two opportunities (one valued from the customer's own latest order, one without a value) and an overdue
    // follow-up; all on real demo customers.
    const opps = await q<{ stage: string; valued: boolean }>("select stage, value_cents is not null valued from public.crm_opportunities where company_id = $1 order by stage", [w.company]);
    expect(opps.rows).toEqual([{ stage: "negotiation", valued: false }, { stage: "quoting", valued: true }]);
    const overdue = await q<{ n: string }>("select count(*) n from public.customer_tasks where company_id = $1 and status = 'open' and due_on < current_date", [w.company]);
    expect(Number(overdue.rows[0].n)).toBe(1);
    // Customer portal (20261120000700): three published sample help articles. The entitlement is the platform owner's
    // decision, so a demo owner alone does not get a portal turned on (the owner's Refresh entitles demo portals).
    const help = await q<{ n: string }>("select count(*) n from public.portal_help_articles where company_id = $1 and status = 'published'", [w.company]);
    expect(Number(help.rows[0].n)).toBe(3);
    const portal = await q<{ n: string }>("select count(*) n from public.portal_settings where company_id = $1 and enabled", [w.company]);
    expect(Number(portal.rows[0].n)).toBe(0);
    // Route Planner (20261120002600): one fictional place of each kind around the demo yard, addressed to the demo's
    // town, and one not located yet; two trucks with routing dimensions; two saved routes; and some of today's loads
    // assigned (through assign_load) so today's routes are not empty.
    const places = await q<{ kind: string; located: boolean; city: string }>("select kind, latitude is not null located, city from public.company_locations where company_id = $1 order by kind, name", [w.company]);
    expect(places.rows.map((r) => r.kind)).toEqual(["other", "pickup", "plant", "quarry", "quarry", "terminal", "yard"]);
    expect(places.rows.filter((r) => !r.located).map((r) => r.kind)).toEqual(["other"]);
    expect(places.rows.every((r) => r.city !== "")).toBe(true);
    const sized = await q<{ n: string }>("select count(*) n from public.trucks where company_id = $1 and height_cm is not null", [w.company]);
    expect(Number(sized.rows[0].n)).toBe(2);
    const routes = await q<{ name: string; stops: string; truck: boolean }>("select r.name, count(s.id) stops, r.truck_id is not null truck from public.saved_routes r join public.saved_route_stops s on s.route_id = r.id where r.company_id = $1 group by r.id order by r.name", [w.company]);
    expect(routes.rows.map((r) => [Number(r.stops), r.truck])).toEqual([[5, true], [4, false]]);
    const routed = await q<{ n: string }>("select count(*) n from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id where a.company_id = $1 and a.status = 'active' and l.load_date = (now() at time zone $2)::date", [w.company, TZ]);
    expect(Number(routed.rows[0].n)).toBeGreaterThanOrEqual(1);
    // The Maintenance board's later columns (2026-10-26): in progress, awaiting parts, awaiting inspection.
    const board = await q<{ status: string }>("select distinct status::text as status from public.work_orders where company_id = $1 and status in ('in_progress', 'awaiting_parts', 'awaiting_inspection') order by 1", [w.company]);
    expect(board.rows.map((r) => r.status)).toEqual(["awaiting_inspection", "awaiting_parts", "in_progress"]);
    // Spreadsheet import (B106): one customer file waiting for review, with ready, duplicate and needs-fixing rows.
    const imports = await q<{ status: string }>("select r.status from private.import_rows r join private.import_batches b on b.id = r.batch_id where b.company_id = $1 and b.source = 'company' order by r.row_number", [w.company]);
    expect(imports.rows.map((r) => r.status)).toEqual(["valid", "valid", "duplicate", "error"]);
    // Shift offers (B102): an open driver shift two days out, asked for by one qualified driver.
    const shiftOffers = await q<{ status: string; answers: string }>("select o.status, count(r.id) answers from public.shift_offers o left join public.shift_offer_responses r on r.offer_id = o.id and r.status = 'requested' where o.company_id = $1 group by o.id", [w.company]);
    expect(shiftOffers.rows.map((r) => [r.status, Number(r.answers)])).toEqual([["open", 1]]);
    // Invoicing (B99): Taviron issues the demo's invoices; issued invoices with at least one past due and one payment.
    const invoices = await q<{ status: string; overdue: boolean; paid: string; orders: string }>("select i.status, i.due_date < (now() at time zone $2)::date overdue, coalesce((select sum(amount_cents) from public.invoice_payments p where p.invoice_id = i.id and p.voided_at is null), 0) paid, (select count(*) from public.invoice_orders o where o.invoice_id = i.id) orders from public.invoices i where i.company_id = $1", [w.company, TZ]);
    expect(invoices.rows.length).toBeGreaterThanOrEqual(1);
    // One invoice for several orders (UX10): a draft that bills two orders of one customer; every other one is issued.
    expect(invoices.rows.filter((r) => Number(r.orders) === 1).every((r) => r.status === "issued")).toBe(true);
    // Only when some customer had two orders to bill (it depends on the hour the seed ran); never invented otherwise.
    const combined = invoices.rows.filter((r) => Number(r.orders) > 1).map((r) => [r.status, Number(r.orders)]);
    const twoReady = await q("select o.customer_id from public.billing_order_status s join public.orders o on o.id = s.order_id where s.company_id = $1 and s.readiness = 'ready' group by 1 having count(*) >= 2", [w.company]);
    if (combined.length === 0) expect(twoReady.rows.length).toBe(0);
    else expect(combined).toEqual([["draft", 2]]);
    expect(invoices.rows.some((r) => r.overdue && Number(r.paid) === 0)).toBe(true);
    // Support (owner 2026-11-09): the sample late-delivery case already has the office's first reply; nothing is overdue.
    const unanswered = await q<{ n: string }>("select count(*) n from public.portal_support_requests where company_id = $1 and first_reply_at is null and status = 'open'", [w.company]);
    expect(Number(unanswered.rows[0].n)).toBe(0);
    // Payments by ticket (TP1): one check on a partly paid invoice's tickets, one ticket paid in part, $25 kept as credit;
    // the invoice it paid follows (an invoice payment linked to it).
    const tp = await q<{ amount: string; apps: string; applied: string; linked: string }>("select p.amount_cents amount, (select count(*) from public.ticket_payment_applications a where a.payment_id = p.id) apps, (select coalesce(sum(a.amount_cents), 0) from public.ticket_payment_applications a where a.payment_id = p.id) applied, (select count(*) from public.invoice_payments ip where ip.customer_payment_id = p.id and ip.voided_at is null) linked from public.customer_payments p where p.company_id = $1", [w.company]);
    expect(tp.rows).toHaveLength(1);
    expect(Number(tp.rows[0].apps)).toBeGreaterThanOrEqual(1);
    expect(Number(tp.rows[0].amount) - Number(tp.rows[0].applied)).toBe(2500);
    expect(Number(tp.rows[0].linked)).toBe(1);
    // GPS and hours (B101): hand entry turned on, current positions plus one stale truck, hours with one under an hour.
    const gps = await q<{ current: string; stale: string; low: string; source: string }>("select (select count(*) from public.vehicle_positions where company_id = $1 and recorded_at > now() - interval '30 minutes') current, (select count(*) from public.vehicle_positions where company_id = $1 and recorded_at <= now() - interval '30 minutes') stale, (select count(*) from public.driver_hours where company_id = $1 and drive_minutes_left < 60) low, (select source from public.telematics_settings where company_id = $1) source", [w.company]);
    expect(gps.rows[0].source).toBe("manual");
    expect(Number(gps.rows[0].current)).toBeGreaterThanOrEqual(1);
    expect(Number(gps.rows[0].stale)).toBeGreaterThanOrEqual(1);
    expect(Number(gps.rows[0].low)).toBeGreaterThanOrEqual(1);
    // Wait times (B111): finished stops at pickups and sites, some over the demo's 45 free minutes.
    const waits = await q<{ n: string; long: string; free: number }>("select count(*) n, count(*) filter (where departed_at - arrived_at > interval '45 minutes') long, (select free_minutes from public.wait_time_settings where company_id = $1) free from public.load_stop_times where company_id = $1 and departed_at is not null", [w.company]);
    expect(Number(waits.rows[0].n)).toBeGreaterThanOrEqual(2);
    expect(Number(waits.rows[0].long)).toBeGreaterThanOrEqual(1);
    expect(waits.rows[0].free).toBe(45);
    // Learned maintenance estimates (B91): completed jobs with recorded labor and an estimate, in several kinds of job.
    const history = await q<{ n: string; kinds: string }>("select count(distinct w.id) n, count(distinct w.category) kinds from public.work_orders w join public.work_order_time_entries t on t.work_order_id = w.id and t.voided_at is null where w.company_id = $1 and w.status = 'completed' and w.estimated_hours is not null", [w.company]);
    expect(Number(history.rows[0].n)).toBeGreaterThanOrEqual(12);
    expect(Number(history.rows[0].kinds)).toBe(4);
    // Time off on the Schedule (2026-10-26): approved, pending and denied requests, all three states.
    const offStates = await q<{ status: string }>("select distinct status from public.time_off_requests where company_id = $1 and reason = 'Demo: shows on the Schedule.' order by status", [w.company]);
    expect(offStates.rows.map((r) => r.status)).toEqual(["approved", "denied", "pending"]);
    // One truck delivers twice today, so its second drive starts where the first delivery left it (2026-10-26).
    const twice = await q<{ n: string }>("select count(*) n from (select a.truck_id from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id where a.company_id = $1 and a.status = 'active' and l.load_date = (now() at time zone $2)::date group by a.truck_id having count(*) >= 2) t", [w.company, TZ]);
    expect(Number(twice.rows[0].n)).toBeGreaterThanOrEqual(1);
    // Maintenance crews (20261120002900): a half-done checklist and logged labor that counts toward labor hours.
    const checklist = await q<{ status: string; n: string }>("select status, count(*) n from public.work_order_tasks where company_id = $1 group by status order by status", [w.company]);
    expect(checklist.rows.map((r) => [r.status, Number(r.n)])).toEqual([["done", 2], ["open", 2]]);
    const labor = await q<{ entries: string; running: string; hours: string }>("select count(*) entries, count(*) filter (where ended_at is null) running, (select sum(labor_hours) from public.work_orders where company_id = $1) hours from public.work_order_time_entries where company_id = $1 and voided_at is null", [w.company]);
    expect(Number(labor.rows[0].entries)).toBeGreaterThanOrEqual(1);
    expect(Number(labor.rows[0].running)).toBe(0);
    expect(Number(labor.rows[0].hours)).toBeGreaterThan(0);
    // Shop capacity (20261120003000): a configured shop, estimates on all but one open work order, and recorded skills.
    const shop = await q<{ bays: number }>("select bays from public.maintenance_shop_settings where company_id = $1", [w.company]);
    expect(shop.rows).toEqual([{ bays: 2 }]);
    const est = await q<{ estimated: string; unestimated: string }>("select count(*) filter (where estimated_hours is not null) estimated, count(*) filter (where estimated_hours is null) unestimated from public.work_orders where company_id = $1 and status not in ('completed', 'closed', 'canceled')", [w.company]);
    expect(Number(est.rows[0].estimated)).toBeGreaterThan(0);
    expect(Number(est.rows[0].unestimated)).toBe(1);
    // Planned work in the next two weeks, with one day holding more jobs than the shop has bays.
    const plan = await q<{ d: string; n: string }>("select scheduled_for::text as d, count(*) as n from public.work_orders where company_id = $1 and estimated_hours is not null and status not in ('completed', 'closed', 'canceled') and scheduled_for between current_date and current_date + 14 group by 1", [w.company]);
    expect(plan.rows.length).toBeGreaterThan(0);
    expect(Math.max(...plan.rows.map((r) => Number(r.n)))).toBeGreaterThan(2);
    // Shift schedules (20261120003300): a day crew, a night rotation, the shop, two one-day changes, one driver without.
    const kinds = await q<{ kind: string; n: string }>("select kind, count(*) as n from public.shift_patterns where company_id = $1 group by kind order by kind", [w.company]);
    expect(kinds.rows.map((r) => r.kind)).toEqual(["rotation", "weekly"]);
    const changes = await q<{ kind: string }>("select kind from public.shift_changes where company_id = $1 order by kind", [w.company]);
    expect(changes.rows.map((r) => r.kind)).toEqual(["off", "shift"]);
    // Fictional VINs in the VIN format on all trucks but one (the missing case), and on trailers.
    const vins = await q<{ with_vin: string; no_vin: string }>("select count(*) filter (where vin <> '') as with_vin, count(*) filter (where vin = '') as no_vin from public.trucks where company_id = $1 and active and hauler_id is null", [w.company]);
    expect(Number(vins.rows[0].with_vin)).toBeGreaterThan(0);
    expect(Number(vins.rows[0].no_vin)).toBe(1);
    // Triage (20261120003100): suggestions from the rules waiting for a person's review; nothing accepted for them.
    const tri = await q<{ source: string; status: string }>("select source, status from public.work_order_triage where company_id = $1", [w.company]);
    expect(tri.rows.length).toBeGreaterThan(0);
    expect(tri.rows.every((r) => r.source === "rules" && r.status === "suggested")).toBe(true);
    // Speed (B86, 20261120003600): past planning and review times are realistic, so every figure has measurements.
    const plans = await q<{ starts_at: Date; created_at: Date }>("select starts_at, created_at from public.dispatch_assignments where company_id = $1", [w.company]);
    const local = (d: Date) => todayIn(TZ, d);
    expect(planningSpeed(plans.rows.map((r) => ({ loadDate: local(r.starts_at), createdAt: r.created_at.toISOString() })), TZ)).not.toBeNull();
    const reviewed = await q<{ status: string; delivered_at: Date; reviewed_at: Date; reviewed_by: string }>("select status, delivered_at, reviewed_at, reviewed_by from public.delivery_tickets where company_id = $1 and reviewed_at is not null", [w.company]);
    expect(reviewPace(reviewed.rows.map((r) => ({ reviewer: r.reviewed_by, reviewedAt: r.reviewed_at.toISOString() })))).not.toBeNull();
    const ready = billingReadySpeed(reviewed.rows.filter((r) => r.status === "accepted").map((r) => ({ deliveredAt: r.delivered_at.toISOString(), reviewedAt: r.reviewed_at.toISOString() })));
    expect(ready!.medianHours).toBeLessThan(120); // twice-weekly review sittings: days, not the seed's week or more
    // History entries follow the moved times; a second run moves nothing.
    const order = await q<{ n: string }>("select count(*) n from public.delivery_tickets t join public.delivery_ticket_events e on e.ticket_id = t.id and e.action = 'accepted' where t.company_id = $1 and e.occurred_at <> t.reviewed_at and t.created_at < t.delivered_at + interval '1 day'", [w.company]);
    expect(Number(order.rows[0].n)).toBe(0);
    const { data: rerun } = await as(w.owner).rpc("demo_speed_history");
    expect(rerun).toEqual({ assignments: 0, tickets: 0 });
    // Real companies are refused, and outside the function the records stay unchangeable.
    const refused = await as(w.realOwner).rpc("demo_speed_history");
    expect(refused.error?.message).toMatch(/only added to a demo company/);
    const oneAssignment = (await q<{ id: string }>("select id from public.dispatch_assignments where company_id = $1 and status = 'active' limit 1", [w.company])).rows[0].id;
    await expect(q("update public.dispatch_assignments set created_at = created_at - interval '1 day' where id = $1", [oneAssignment])).rejects.toThrow(/cannot be edited/);
    const oneEvent = (await q<{ id: string }>("select id from public.delivery_ticket_events where company_id = $1 limit 1", [w.company])).rows[0].id;
    await expect(q("update public.delivery_ticket_events set occurred_at = occurred_at - interval '1 day' where id = $1", [oneEvent])).rejects.toThrow(/append-only/);
    // Even with the time-only switch on, anything other than the time is still refused.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('tlt.demo_timing', 'on', true)");
      await expect(client.query("update public.dispatch_assignments set note = 'changed', created_at = created_at - interval '1 day' where id = $1", [oneAssignment])).rejects.toThrow(/cannot be edited/);
    } finally {
      await client.query("rollback");
      client.release();
    }

    // Hired trucks (B83): a ready hauler and one with expired insurance; an open offer and a confirmed one, assigned.
    const haulers = await q<{ n: string }>("select count(*) n from public.haulers where company_id = $1", [w.company]);
    expect(Number(haulers.rows[0].n)).toBe(2);
    // Upcoming offers (the settlement sample's past jobs aside): one open, one confirmed and assigned.
    const offerStates = await q<{ status: string }>("select o.status from public.hauler_offers o join public.order_loads l on l.id = o.load_id where o.company_id = $1 and l.load_date > private.company_today($1) order by o.status", [w.company]);
    expect(offerStates.rows.map((r) => r.status)).toEqual(["confirmed", "offered"]);
    const hiredAssigned = await q<{ n: string }>("select count(*) n from public.dispatch_assignments a join public.trucks t on t.id = a.truck_id join public.order_loads l on l.id = a.load_id where a.company_id = $1 and a.status = 'active' and t.hauler_id is not null and l.load_date > private.company_today($1)", [w.company]);
    expect(Number(hiredAssigned.rows[0].n)).toBe(1);
    // Hauler settlements (B129): a draft for two delivered hired jobs, 10 % commission, a $75 fuel advance.
    const settlement = await q<{ status: string; gross_cents: string; commission_cents: string; deductions_cents: string; net_cents: string; jobs: string }>(
      "select s.status, s.gross_cents, s.commission_cents, s.deductions_cents, s.net_cents, (select count(*) from public.hauler_settlement_jobs j where j.settlement_id = s.id) jobs from public.hauler_settlements s where s.company_id = $1", [w.company]);
    expect(settlement.rows).toHaveLength(1);
    const st = settlement.rows[0];
    const gross = Number(st.gross_cents);
    expect([st.status, st.jobs, st.deductions_cents]).toEqual(["draft", "2", "7500"]);
    expect(gross).toBeGreaterThan(0);
    expect(Number(st.commission_cents)).toBe(Math.round(gross / 10));
    expect(Number(st.net_cents)).toBe(gross - Math.round(gross / 10) - 7500);

    // Quote history (B95): eight decided quotes — three won, three declined with a reason, two expired.
    const decided = await q<{ status: string; n: string }>("select q.status, count(*) n from public.quotes q join public.quote_versions v on v.id = q.current_version_id where q.company_id = $1 and v.project_name like 'Quote history (demo)%' group by q.status order by q.status", [w.company]);
    expect(decided.rows.map((r) => [r.status, Number(r.n)])).toEqual([["accepted", 3], ["declined", 3], ["expired", 2]]);
    // Pricing help (B114): four more decided quotes on the open draft's item (three won, one lost); their orders are closed.
    const pricing = await q<{ status: string; n: string }>("select q.status, count(*) n from public.quotes q join public.quote_versions v on v.id = q.current_version_id where q.company_id = $1 and v.project_name like 'Pricing history (demo)%' group by q.status order by q.status", [w.company]);
    expect(pricing.rows.map((r) => [r.status, Number(r.n)])).toEqual([["accepted", 3], ["declined", 1]]);
    const pricingOpen = await q<{ n: string }>("select count(*) n from public.orders where company_id = $1 and project_name like 'Pricing history (demo)%' and status <> 'canceled'", [w.company]);
    expect(Number(pricingOpen.rows[0].n)).toBe(0);
    // Customer booking (B115): switched on, eight weekdays opened (one full), one pending and one approved request.
    const booking = await q<{ enabled: boolean; days: string; pending: string; approved: string }>(
      `select (select enabled from public.booking_settings where company_id = $1) enabled,
              (select count(*) from public.booking_capacity where company_id = $1) days,
              (select count(*) from public.booking_requests where company_id = $1 and status = 'pending') pending,
              (select count(*) from public.booking_requests where company_id = $1 and status = 'approved') approved`, [w.company]);
    expect(booking.rows[0]).toEqual({ enabled: true, days: "8", pending: "1", approved: "1" });
    // Fuel and IFTA (B130): trip sheets for two trucks, some in a second state, and fuel purchases.
    const fuel = await q<{ trucks: string; sheets: string; states: string; buys: string }>(
      `select (select count(distinct truck_id) from public.trip_sheets where company_id = $1) trucks, (select count(*) from public.trip_sheets where company_id = $1) sheets,
              (select count(distinct e ->> 'jurisdiction') from public.trip_sheets t, jsonb_array_elements(t.legs) e where t.company_id = $1) states,
              (select count(*) from public.fuel_purchases where company_id = $1) buys`, [w.company]);
    expect(Number(fuel.rows[0].trucks)).toBe(2);
    expect(Number(fuel.rows[0].sheets)).toBeGreaterThan(20);
    expect(Number(fuel.rows[0].states)).toBe(2);
    expect(Number(fuel.rows[0].buys)).toBeGreaterThan(5);
    // Inspections (B132): pre-trips on past weekdays, none today, one minor defect with its inspection work order.
    const insp = await q<{ n: string; today: string; defects: string; wo: string }>(
      `select count(*) n, count(*) filter (where inspected_on = (now() at time zone coalesce((select timezone from public.company_settings where company_id = $1), 'America/Chicago'))::date) today,
              count(*) filter (where defect_count > 0) defects,
              (select count(*) from public.work_orders where company_id = $1 and source = 'inspection') wo
       from public.vehicle_inspections where company_id = $1`, [w.company]);
    expect(Number(insp.rows[0].n)).toBeGreaterThan(5);
    expect([insp.rows[0].today, insp.rows[0].defects, insp.rows[0].wo]).toEqual(["0", "1", "1"]);
    // Credit holds (B128): one customer on a manual hold, not the priority customer.
    const held = await q<{ n: string; priority: string }>("select count(*) n, count(*) filter (where is_priority) priority from public.customers where company_id = $1 and credit_hold", [w.company]);
    expect([Number(held.rows[0].n), Number(held.rows[0].priority)]).toEqual([1, 0]);

    // Proof of delivery (B98): confirmed tickets at a located job site get a position (up to five).
    const pod = await q<{ located: string; placed: string }>(
      `select (select count(*) from public.delivery_tickets t join public.orders o on o.id = t.order_id join public.customer_sites cs on cs.id = o.site_id
                where t.company_id = $1 and t.status = 'accepted' and cs.latitude is not null) located,
              (select count(*) from public.ticket_locations where company_id = $1) placed`, [w.company]);
    expect(Number(pod.rows[0].placed)).toBe(Math.min(5, Number(pod.rows[0].located)));

    // Site notes from customers (B94): one pending note for the office.
    const notes = await q<{ n: string }>("select count(*) n from public.site_info_submissions where company_id = $1 and status = 'pending'", [w.company]);
    expect(Number(notes.rows[0].n)).toBe(1);

    // Parts used per job (UX20): the brake shoe kit used from stock has its part cost line, at the received cost.
    const partCost = await q<{ n: string; cents: string }>("select count(*) n, coalesce(sum(round(quantity * unit_cost_cents)), 0) cents from public.work_order_costs where company_id = $1 and kind = 'part'", [w.company]);
    expect([Number(partCost.rows[0].n), Number(partCost.rows[0].cents)]).toEqual([1, 12800]);

    // A second run adds no places or routes.
    await ensureFeatureSamples(as(w.owner), todayIn(TZ));
    const partCostAgain = await q<{ n: string }>("select count(*) n from public.work_order_costs where company_id = $1 and kind = 'part'", [w.company]);
    expect(Number(partCostAgain.rows[0].n)).toBe(1);
    // Compliance calendar (CC1): one sample credential and one sample permit, coming due (never overdue), added once.
    const cal = await q<{ creds: string; permits: string; soonest: string }>(
      `select (select count(*) from public.driver_qualifications where company_id = $1 and description = 'Safety training refresher (sample)') creds,
              (select count(*) from public.vehicle_documents where company_id = $1 and title = 'Overweight permit (sample)') permits,
              least((select min(expires_on) from public.driver_qualifications where company_id = $1 and description = 'Safety training refresher (sample)'),
                    (select min(expires_on) from public.vehicle_documents where company_id = $1 and title = 'Overweight permit (sample)'))::text soonest`, [w.company]);
    expect([Number(cal.rows[0].creds), Number(cal.rows[0].permits)]).toEqual([1, 1]);
    expect(cal.rows[0].soonest > todayIn(TZ)).toBe(true);
    // Stops (MK2): one of today's assigned orders loads at its pickup and makes its deliveries, added once.
    const stops = await q<{ order_id: string; kinds: string[] }>("select order_id, array_agg(kind order by seq) kinds from public.order_stops where company_id = $1 and removed_at is null group by order_id", [w.company]);
    expect(stops.rows).toHaveLength(1);
    expect(stops.rows[0].kinds[0]).toBe("pickup");
    expect(stops.rows[0].kinds.slice(1).every((k) => k === "delivery") && stops.rows[0].kinds.length >= 2).toBe(true);
    const again = await q<{ l: string; r: string }>("select (select count(*) from public.company_locations where company_id = $1) l, (select count(*) from public.saved_routes where company_id = $1) r", [w.company]);
    expect([Number(again.rows[0].l), Number(again.rows[0].r)]).toEqual([7, 2]);
    const decidedAgain = await q<{ n: string }>("select count(*) n from public.quote_versions v join public.quotes q on q.id = v.quote_id where q.company_id = $1 and v.project_name like 'Quote history (demo)%'", [w.company]);
    expect(Number(decidedAgain.rows[0].n)).toBe(8);
    const pricingAgain = await q<{ n: string }>("select count(*) n from public.quote_versions v join public.quotes q on q.id = v.quote_id where q.company_id = $1 and v.project_name like 'Pricing history (demo)%'", [w.company]);
    expect(Number(pricingAgain.rows[0].n)).toBe(4);
    // A demo shown as Growth gets a yard for its second dispatch base, tied to that base.
    await q("update public.companies set demo_plan = 'growth' where id = $1", [w.company]);
    const base = (await q<{ id: string }>("insert into public.dispatch_bases (company_id, code, name, timezone) values ($1, 'EAST', 'East Yard', $2) returning id", [w.company, TZ])).rows[0].id;
    await ensureFeatureSamples(as(w.owner), todayIn(TZ));
    const baseYard = await q<{ base_id: string; located: boolean }>("select base_id, latitude is not null located from public.company_locations where company_id = $1 and name = 'East Yard yard (demo)'", [w.company]);
    expect(baseYard.rows).toEqual([{ base_id: base, located: true }]);
  }, 180_000);

  it("the owner's driver day appears once their employee record is linked, and every repeat adds nothing", async () => {
    await q("update public.employees set user_id = $2 where company_id = $1 and job_title = 'Owner' and user_id is null", [w.company, w.owner]);
    const today = todayIn(TZ);
    const first = await ensureFeatureSamples(as(w.owner), today);
    expect(first.features).toContain("driver day for the demo owner");
    const driver = (await q<{ id: string }>("select id from public.drivers where company_id = $1 and user_id = $2", [w.company, w.owner])).rows;
    expect(driver).toHaveLength(1);
    const linked = (await q("select 1 from public.employees where company_id = $1 and user_id = $2 and driver_id = $3", [w.company, w.owner, driver[0].id])).rowCount;
    expect(linked).toBe(1);
    // The owner's relief day has one earlier load still waiting for its ticket (owner 2026-11-09), never more.
    const toEnter = await q<{ n: string }>("select count(*) n from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id join public.drivers d on d.id = a.driver_id where a.company_id = $1 and a.status = 'active' and d.user_id is not null and l.load_date < (now() at time zone $2)::date and not exists (select 1 from public.delivery_tickets t where t.load_id = l.id)", [w.company, TZ]);
    expect(Number(toEnter.rows[0].n)).toBe(1);
    expect(first.features).toContain("ticket to enter for the demo owner");
    // The Command Center names the viewer by their demo employee record, never their account name (20261111000200).
    const persona = (await q<{ full_name: string }>("select full_name from public.employees where company_id = $1 and user_id = $2", [w.company, w.owner])).rows[0].full_name;
    const open = (await as(w.owner).rpc("command_center_exceptions", { p_kind: null, p_mine: false, p_limit: 1, p_offset: 0, p_hidden: false })).data as { items: Array<{ exception_key: string }> };
    const assigned = await as(w.owner).rpc("assign_exception", { p_key: open.items[0].exception_key, p_user_id: w.owner, p_note: "" });
    if (!assigned.error) expect((assigned.data as { assignee: string }).assignee).toBe(persona); // (already mine is fine)
    const mineNow = (await as(w.owner).rpc("command_center_exceptions", { p_kind: null, p_mine: true, p_limit: 5, p_offset: 0, p_hidden: false })).data as { items: Array<{ assignee_name: string | null }> };
    expect(mineNow.items.length).toBeGreaterThan(0);
    expect(mineNow.items.every((x) => x.assignee_name === persona)).toBe(true);
    const options = (await as(w.owner).rpc("exception_assignee_options")).data as Array<{ user_id: string; name: string }>;
    expect(options.find((o) => o.user_id === w.owner)?.name).toBe(persona);
    // History lines ("by …") name people through user_directory: the persona in a demo company (20261111000300) …
    const dir = (await as(w.owner).rpc("user_directory")).data as Array<{ id: string; full_name: string }>;
    expect(dir.find((u) => u.id === w.owner)?.full_name).toBe(persona);
    // … and the account's own name, unchanged, in a real company.
    const real = (await as(w.realOwner).rpc("user_directory")).data as Array<{ id: string; full_name: string }>;
    const profile = (await q<{ full_name: string }>("select full_name from public.profiles where id = $1", [w.realOwner])).rows[0].full_name;
    expect(real.find((u) => u.id === w.realOwner)?.full_name).toBe(profile);
    // My Day names the demo owner's driver record by the persona too.
    const home = (await as(w.owner).rpc("driver_portal_home")).data as { driver?: { name: string } } | null;
    if (home?.driver) expect(home.driver.name).toBe(persona);

    const before = await counts(w.company);
    expect((await ensureFeatureSamples(as(w.owner), today)).added).toBe(0);
    const r1 = await refreshPrairieLantern(as(w.owner), TZ);
    const afterFirstRefresh = await counts(w.company);
    const r2 = await refreshPrairieLantern(as(w.owner), TZ);
    expect(r2).toEqual({ added: 0, loads: 0 }); // a second Refresh adds nothing
    const after = await counts(w.company);
    expect(after).toEqual(afterFirstRefresh);
    // Refresh never removes or changes demo users, and never re-adds the shared samples.
    expect(after.memberships).toEqual(before.memberships);
    expect(after.drivers).toBe(before.drivers);
    expect(Number((await q<{ n: string }>("select count(*) n from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id join public.drivers d on d.id = a.driver_id where a.company_id = $1 and a.status = 'active' and d.user_id is not null and l.load_date < (now() at time zone $2)::date and not exists (select 1 from public.delivery_tickets t where t.load_id = l.id)", [w.company, TZ])).rows[0].n)).toBe(1);
    expect({ ...after, loads: 0 }).toMatchObject({ workOrders: before.workOrders, quotes: before.quotes, workspaces: before.workspaces, timeOff: before.timeOff });
    expect(r1.added).toBeGreaterThanOrEqual(0);
  }, 240_000);

  // Late in the day the seed's own same-day orders are delivered and become ready by themselves; the Handed off example
  // must still be added (it was skipped whenever any order was ready). Recreated here on this fictional demo company by
  // removing its handoff (fixture only: the guard triggers are bypassed inside this one transaction).
  it("adds the Handed off example when an order is already ready, and only once", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      // The demo's sample invoices hang off its handoffs (B99): they go too, or they would point at nothing.
      await client.query("delete from public.invoice_payments where company_id = $1", [w.company]);
      await client.query("delete from public.invoice_orders where company_id = $1", [w.company]);
      await client.query("delete from public.invoices where company_id = $1", [w.company]);
      await client.query("delete from public.billing_handoff_orders where handoff_id in (select id from public.billing_handoffs where company_id = $1)", [w.company]);
      await client.query("delete from public.billing_handoffs where company_id = $1", [w.company]);
      await client.query("commit");
    } finally {
      client.release();
    }
    const states = async () => ((await as(w.owner).from("billing_order_status").select("readiness")).data ?? []).map((r) => (r as { readiness: string }).readiness);
    expect(await states()).toContain("ready");
    expect(await states()).not.toContain("handed_off");
    const today = todayIn(TZ);
    const first = await ensureFeatureSamples(as(w.owner), today);
    expect(first.features).toContain("billing: ready and handed off");
    expect(await states()).toContain("handed_off");
    // The billing sample's handoff, plus any the invoice sample (B99) hands off for its invoices.
    const handoffs = (await counts(w.company)).handoffs;
    expect(handoffs).toBeGreaterThanOrEqual(1);
    await ensureFeatureSamples(as(w.owner), today);
    expect((await counts(w.company)).handoffs).toBe(handoffs); // a second run adds nothing
  }, 180_000);

  it("remembers the demo welcome per person in a demo company only", async () => {
    const seen = () => as(w.owner).from("user_preferences").select("key").eq("key", "demo_welcome").maybeSingle();
    expect((await seen()).data).toBeNull();
    expect((await as(w.owner).rpc("dismiss_demo_welcome")).error).toBeNull();
    expect((await as(w.owner).rpc("dismiss_demo_welcome")).error).toBeNull(); // idempotent
    expect((await seen()).data).toEqual({ key: "demo_welcome" });
    const rows = await q("select user_id from public.user_preferences where company_id = $1 and key = 'demo_welcome'", [w.company]);
    expect(rows.rows).toEqual([{ user_id: w.owner }]);
    // A real company has no demo welcome, and nothing is written there.
    const real = await as(w.realOwner).rpc("dismiss_demo_welcome");
    expect(real.error?.message).toMatch(/Only demo companies/);
    expect((await q("select 1 from public.user_preferences where company_id = $1 and key = 'demo_welcome'", [TOP_LINE])).rowCount).toBe(0);
  }, 60_000);

  it("a demo set to haul general freight gets shipper-to-receiver stops on a few orders, and a repeat adds none", async () => {
    await q("update public.company_settings set industry = 'freight' where company_id = $1", [w.company]);
    try {
      const today = todayIn(TZ);
      await ensureFeatureSamples(as(w.owner), today);
      const orders = async () => (await q<{ order_id: string; kinds: string[]; refs: string[] }>(
        "select order_id, array_agg(kind order by seq) kinds, array_agg(reference order by seq) refs from public.order_stops where company_id = $1 and removed_at is null group by order_id", [w.company])).rows;
      const first = await orders();
      expect(first.length).toBeGreaterThanOrEqual(2);
      expect(first.length).toBeLessThanOrEqual(3);
      expect(first.every((o) => o.kinds[0] === "pickup" && o.kinds[o.kinds.length - 1] === "delivery")).toBe(true);
      expect(first.some((o) => o.refs[0].startsWith("PU-"))).toBe(true);
      await ensureFeatureSamples(as(w.owner), today);
      expect((await orders()).length).toBe(first.length);
    } finally {
      await q("update public.company_settings set industry = 'aggregate' where company_id = $1", [w.company]);
    }
  }, 180_000);

  it("is refused for a real company, which is left untouched", async () => {
    const before = await counts(TOP_LINE);
    await expect(ensureFeatureSamples(as(w.realOwner), todayIn(TZ))).rejects.toThrow(/only added to demo companies/);
    const after = await counts(TOP_LINE);
    expect(after.workOrders).toBe(before.workOrders);
    expect(after.quotes).toBe(before.quotes);
  }, 60_000);
});
