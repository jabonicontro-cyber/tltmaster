// Demo feature parity (CLAUDE.md, docs/DEMO_TENANTS.md §3): the shared samples (src/server/demo/samples.ts) give a
// demo company data for every released feature, existing demos receive them through Refresh, a second run adds
// nothing and keeps every demo user, and a real company is refused. Runs the real seed and Refresh against the
// local stack with real signed user tokens (PostgREST + RLS); skipped when the local stack is not running.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    expect(c.timeOff).toBe(2);
    expect(c.quotes).toBeGreaterThanOrEqual(1);
    expect(c.workspaces).toBe(1);
    // Plan the day has open loads to plan tomorrow (docs/OPTIMIZATION.md §4).
    const open = await q<{ n: string }>(
      "select count(*) n from public.order_loads l where l.company_id = $1 and l.load_date = ($2::date + 1) and l.status = 'planned' and not exists (select 1 from public.dispatch_assignments a where a.load_id = l.id and a.status = 'active')",
      [w.company, todayIn(TZ)],
    );
    expect(Number(open.rows[0].n)).toBeGreaterThanOrEqual(4);
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
    expect(c.handoffs).toBe(1);
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
    expect((await counts(w.company)).handoffs).toBe(1);
    await ensureFeatureSamples(as(w.owner), today);
    expect((await counts(w.company)).handoffs).toBe(1); // a second run adds nothing
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

  it("is refused for a real company, which is left untouched", async () => {
    const before = await counts(TOP_LINE);
    await expect(ensureFeatureSamples(as(w.realOwner), todayIn(TZ))).rejects.toThrow(/only added to demo companies/);
    const after = await counts(TOP_LINE);
    expect(after.workOrders).toBe(before.workOrders);
    expect(after.quotes).toBe(before.quotes);
  }, 60_000);
});
