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
    // Billing shows every state: an order delivered exactly as ordered (ready) and one handed off (internal batch).
    const readiness = ((await as(w.owner).from("billing_order_status").select("readiness")).data ?? []).map((r) => (r as { readiness: string }).readiness);
    expect(readiness).toContain("ready");
    expect(readiness).toContain("handed_off");
    expect(c.handoffs).toBe(1);
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
