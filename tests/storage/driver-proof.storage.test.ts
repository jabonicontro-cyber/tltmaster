// Proof of delivery from the driver's phone (MK2, 20261120020800) against the REAL Supabase Storage server and
// PostgREST, with real signed user tokens: the driver reserves through the database, but the order-documents bucket
// keeps no policies, so no person's own token (driver, office, another company, anonymous) can write, read or remove a
// file there; only the server's service role stores and signs. The office opens it through order_document_path; other
// drivers see nothing. Data is committed and removed afterwards. Refuses to run against anything but localhost.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
if (existsSync(".dev-stack/keys.env")) {
  for (const line of readFileSync(".dev-stack/keys.env", "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const DB = env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_) && /127\.0\.0\.1|localhost/.test(DB);
const available = local && Boolean(env.DEV_JWT_SECRET && env.DEV_ANON_KEY && env.DEV_SERVICE_ROLE_KEY) &&
  (await fetch(`${URL_}/storage/v1/status`).then((r) => r.ok).catch(() => false));
if (!available) console.warn("Local Supabase Storage is not running: real storage tests are skipped (DEV_STORAGE=1 scripts/dev-stack/stack.sh up).");

const TOP_LINE = "00000000-0000-4000-8000-000000000001";
const BUCKET = "order-documents";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2044, 7)]);

function token(sub: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", aud: "authenticated", aal: "aal2", iat: now, exp: now + 600 })}`;
  return `${head}.${createHmac("sha256", env.DEV_JWT_SECRET).update(head).digest("base64url")}`;
}
const as = (sub: string | null): SupabaseClient =>
  createClient(URL_, env.DEV_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: sub ? { headers: { Authorization: `Bearer ${token(sub)}` } } : {},
  });
const admin = () => createClient(URL_, env.DEV_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const w: { users: Record<string, string>; orderId?: string; a1?: string; a2?: string; drop?: string; bCompany?: string; trucks: string[]; drivers: string[]; installed: boolean } =
  { users: {}, trucks: [], drivers: [], installed: false };
const paths: string[] = [];

async function setup() {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    w.installed = (await c.query("select to_regprocedure('public.driver_pod_begin(uuid, uuid, uuid, text, integer, text)') is not null ok")).rows[0].ok;
    if (!w.installed) return;
    await c.query("begin");
    const user = async (role: string, company = TOP_LINE) => {
      const id = randomUUID();
      await c.query("reset role");
      await c.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, `pod-${role}-${id.slice(0, 6)}@test.example`]);
      await c.query("update public.profiles set full_name = $2 where id = $1", [id, `POD ${role}`]);
      await c.query("insert into public.company_memberships (company_id, user_id, role) values ($1, $2, $3)", [company, id, role]);
      return id;
    };
    const asUser = async (id: string) => {
      await c.query("reset role");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: "authenticated", aal: "aal2" })]);
    };
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await c.query(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    w.bCompany = (await c.query("select private.create_company('POD Storage Co (test)', $1) as id", [`pod-${randomUUID().slice(0, 8)}`])).rows[0].id;
    for (const r of ["office", "dispatcher", "driver", "driver2"]) w.users[r] = await user(r === "driver2" ? "driver" : r);
    w.users.bOwner = await user("owner", w.bCompany);
    const today = (await c.query("select private.business_today($1)::text as d", [TOP_LINE])).rows[0].d as string;
    const far = (await c.query("select ($1::date + 600)::text d", [today])).rows[0].d as string;
    await asUser(w.users.office);
    const verified = new Date().toISOString();
    for (const [n, uid] of [["1", w.users.driver], ["2", w.users.driver2]] as const) {
      const d = await ins("drivers", { user_id: uid });
      await ins("driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified });
      await ins("driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: far, verified_at: verified });
      w.drivers.push(d);
      w.trucks.push(await ins("trucks", { unit_number: `PD${n}-${randomUUID().slice(0, 5)}`, truck_type: "tri_axle_dump" }));
    }
    const ids = (await c.query("select (select id from public.customers where company_id = $1 and is_sample order by name limit 1) as c, (select id from public.materials where company_id = $1 and code = 'GRV-53') as m", [TOP_LINE])).rows[0];
    const o = (await c.query("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({ site_line1: "100 Test Site Rd (test)", customer_id: ids.c, order_date: today, lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.m, description: "Gravel", unit_code: "ton", quantity: "40", unit_rate_cents: 1000 }] })])).rows[0].r;
    w.orderId = o.order_id;
    await c.query("select public.set_order_status($1, 'confirmed', '')", [w.orderId]);
    await c.query("select public.update_order_schedule($1, null, $2::jsonb)", [w.orderId, JSON.stringify({ scheduled_start: today, scheduled_end: today })]);
    await c.query("select public.set_order_status($1, 'scheduled', '')", [w.orderId]);
    await c.query("select public.save_order_stops($1, $2::jsonb)", [w.orderId, JSON.stringify([{ kind: "pickup", name: "Pickup (test)" }, { kind: "delivery", name: "Receiver (test)" }])]);
    w.drop = (await c.query("select id from public.order_stops where order_id = $1 and kind = 'delivery'", [w.orderId])).rows[0].id;
    await asUser(w.users.dispatcher);
    const plan = async (start: string, end: string) => (await c.query("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: w.orderId, load_date: today, start_time: start, end_time: end })])).rows[0].r.load_id as string;
    w.a1 = (await c.query("select public.assign_load($1, $2, null, $3, '', null) as r", [await plan("00:10", "00:40"), w.trucks[0], w.drivers[0]])).rows[0].r.assignment_id;
    w.a2 = (await c.query("select public.assign_load($1, $2, null, $3, '', null) as r", [await plan("00:50", "01:20"), w.trucks[1], w.drivers[1]])).rows[0].r.assignment_id;
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    await c.end();
  }
}

async function teardown() {
  if (paths.length) await admin().storage.from(BUCKET).remove(paths);
  if (!w.installed) return;
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('tlt.sample_purge', 'on', true)");
    if (w.orderId) await c.query("delete from public.orders where id = $1", [w.orderId]);
    await c.query("delete from public.driver_qualifications where driver_id = any($1)", [w.drivers]);
    await c.query("delete from public.employees where driver_id = any($1)", [w.drivers]);
    await c.query("delete from public.drivers where id = any($1)", [w.drivers]);
    await c.query("delete from public.trucks where id = any($1)", [w.trucks]);
    await c.query("commit");
  } finally {
    await c.end();
  }
}

describe.skipIf(!available)("driver proof of delivery on the real storage server", () => {
  beforeAll(setup, 60_000);
  afterAll(teardown, 60_000);

  it("only the server stores and signs; no person's own token writes, reads or removes the file", async (ctx) => {
    if (!w.installed) ctx.skip();
    const { data: bucket } = await admin().storage.getBucket(BUCKET);
    expect(bucket).toMatchObject({ public: false });

    const begin = await as(w.users.driver).rpc("driver_pod_begin", { p_assignment: w.a1, p_stop: w.drop, p_upload_key: randomUUID(), p_mime: "image/jpeg", p_size: JPEG.length, p_name: "pod.jpg" });
    expect(begin.error).toBeNull();
    const path = (begin.data as { path: string }).path;
    paths.push(path);
    // Another driver cannot reserve on this driver's load.
    expect((await as(w.users.driver2).rpc("driver_pod_begin", { p_assignment: w.a1, p_stop: w.drop, p_upload_key: randomUUID(), p_mime: "image/jpeg", p_size: 10, p_name: "x.jpg" })).error?.code).toBe("42501");

    // Nobody's own token can write to the reserved path (not even the driver who reserved it).
    for (const who of [w.users.driver, w.users.driver2, w.users.office, w.users.bOwner, null]) {
      expect((await as(who).storage.from(BUCKET).upload(path, JPEG, { contentType: "image/jpeg" })).error).toBeTruthy();
    }
    // The server (service role) stores it at exactly that path, as the /driver/proof route does.
    expect((await admin().storage.from(BUCKET).upload(path, JPEG, { contentType: "image/jpeg", upsert: false })).error).toBeNull();
    // Still nobody's own token reads or removes it.
    for (const who of [w.users.driver, w.users.driver2, w.users.office, w.users.bOwner, null]) {
      expect((await as(who).storage.from(BUCKET).download(path)).error).toBeTruthy();
      await as(who).storage.from(BUCKET).remove([path]);
    }
    expect((await admin().storage.from(BUCKET).download(path)).error).toBeNull();

    // The office opens it through the database (orders.view), which gives the path for a short signed link.
    const doc = (await admin().from("order_documents").select("id").eq("object_path", path).single()).data as { id: string };
    const opened = await as(w.users.office).rpc("order_document_path", { p_document: doc.id });
    expect((opened.data as { path: string }).path).toBe(path);
    const signed = await admin().storage.from(BUCKET).createSignedUrl(path, 60);
    expect((await fetch(signed.data!.signedUrl)).status).toBe(200);
    // Drivers and another company get no path.
    for (const who of [w.users.driver, w.users.driver2, w.users.bOwner]) {
      expect((await as(who).rpc("order_document_path", { p_document: doc.id })).data).toBeNull();
    }
    // The driver lists their own; the other driver lists nothing.
    const mine = (await as(w.users.driver).rpc("driver_stop_proofs")).data as Record<string, Record<string, unknown[]>>;
    expect(Object.values(mine).flatMap((s) => Object.values(s)).flat()).toHaveLength(1);
    expect((await as(w.users.driver2).rpc("driver_stop_proofs")).data).toEqual({});
  });
});
