// Ticket photos against the REAL Supabase Storage server (local file backend,
// started with DEV_STORAGE=1 scripts/dev-stack/stack.sh up) and PostgREST,
// using real signed user tokens — no mocks. Data is committed and removed
// afterwards. Refuses to run against anything but localhost.
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";

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
const BUCKET = "ticket-photos";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2044, 7)]);

function token(sub: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", aud: "authenticated", iat: now, exp: now + 600 })}`;
  return `${head}.${createHmac("sha256", env.DEV_JWT_SECRET).update(head).digest("base64url")}`;
}
const as = (sub: string | null): SupabaseClient =>
  createClient(URL_, env.DEV_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: sub ? { headers: { Authorization: `Bearer ${token(sub)}` } } : {},
  });
const admin = () => createClient(URL_, env.DEV_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const w: {
  users: Record<string, string>;
  orderId?: string;
  a1?: string;
  a2?: string;
  line?: string;
  yesterday?: string;
  bCompany?: string;
  trucks: string[];
  drivers: string[];
} = { users: {}, trucks: [], drivers: [] };
const paths: string[] = [];

async function setup() {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    await c.query("begin");
    const user = async (role: string, company = TOP_LINE) => {
      const id = randomUUID();
      await c.query("reset role");
      await c.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, `storage-${role}-${id.slice(0, 6)}@test.example`]);
      await c.query("update public.profiles set full_name = $2 where id = $1", [id, `Storage ${role}`]);
      await c.query("insert into public.company_memberships (company_id, user_id, role) values ($1, $2, $3)", [company, id, role]);
      return id;
    };
    const asUser = async (id: string) => {
      await c.query("reset role");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: "authenticated" })]);
    };
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await c.query(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    w.bCompany = (await c.query("select private.create_company('Storage Test Co (test)', $1) as id", [`storage-${randomUUID().slice(0, 8)}`])).rows[0].id;
    for (const r of ["office", "mechanic", "driver", "driver2"]) w.users[r] = await user(r === "driver2" ? "driver" : r);
    w.users.bOwner = await user("owner", w.bCompany);
    const today = (await c.query("select private.business_today($1)::text as d", [TOP_LINE])).rows[0].d as string;
    w.yesterday = addDays(today, -1);
    await asUser(w.users.office);
    const verified = new Date().toISOString();
    for (const [n, uid] of [["1", w.users.driver], ["2", w.users.driver2]] as const) {
      const d = await ins("drivers", { user_id: uid });
      await ins("driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: addDays(today, 600), verified_at: verified });
      await ins("driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: addDays(today, 600), verified_at: verified });
      w.drivers.push(d);
      w.trucks.push(await ins("trucks", { unit_number: `ST${n}-${randomUUID().slice(0, 5)}`, truck_type: "tri_axle_dump" }));
    }
    const ids = (await c.query("select (select id from public.customers where company_id = $1 and is_sample order by name limit 1) as c, (select id from public.materials where company_id = $1 and code = 'GRV-53') as m", [TOP_LINE])).rows[0];
    const o = (await c.query("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({ customer_id: ids.c, order_date: w.yesterday, lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.m, description: "Gravel", unit_code: "ton", quantity: "40", unit_rate_cents: 1000 }] })])).rows[0].r;
    w.orderId = o.order_id;
    await c.query("select public.set_order_status($1, 'confirmed', '')", [w.orderId]);
    await c.query("select public.update_order_schedule($1, null, $2::jsonb)", [w.orderId, JSON.stringify({ scheduled_start: w.yesterday, scheduled_end: today })]);
    await c.query("select public.set_order_status($1, 'scheduled', '')", [w.orderId]);
    w.line = (await c.query("select id from public.order_lines where order_id = $1", [w.orderId])).rows[0].id;
    const plan = async (start: string, end: string) => (await c.query("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: w.orderId, load_date: w.yesterday, start_time: start, end_time: end })])).rows[0].r.load_id as string;
    w.a1 = (await c.query("select public.assign_load($1, $2, null, $3, '', null) as r", [await plan("07:00", "08:00"), w.trucks[0], w.drivers[0]])).rows[0].r.assignment_id;
    w.a2 = (await c.query("select public.assign_load($1, $2, null, $3, '', null) as r", [await plan("09:00", "10:00"), w.trucks[1], w.drivers[1]])).rows[0].r.assignment_id;
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
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('tlt.sample_purge', 'on', true)");
    if (w.orderId) await c.query("delete from public.orders where id = $1", [w.orderId]);
    await c.query("delete from public.driver_qualifications where driver_id = any($1)", [w.drivers]);
    await c.query("delete from public.drivers where id = any($1)", [w.drivers]);
    await c.query("delete from public.trucks where id = any($1)", [w.trucks]);
    await c.query("commit");
  } finally {
    await c.end();
  }
}

/** Reserve a path as the driver (through PostgREST with the driver's token). */
async function reserve(sub: string, assignment: string, size = JPEG.length) {
  const { data, error } = await as(sub).rpc("driver_begin_ticket_photo", {
    p_assignment_id: assignment, p_upload_key: randomUUID(), p_mime: "image/jpeg", p_size: size,
    p_sha256: "a".repeat(64),
  });
  if (error) throw new Error(error.message);
  paths.push(data.object_path);
  return data as { attachment_id: string; object_path: string };
}
const upload = (sub: string | null, path: string, body: Buffer = JPEG, contentType = "image/jpeg", upsert = false) =>
  as(sub).storage.from(BUCKET).upload(path, body, { contentType, upsert });

describe.skipIf(!available)("ticket photos on the real storage server", () => {
  beforeAll(setup, 60_000);
  afterAll(teardown, 60_000);

  it("the bucket is private and not listed to anonymous callers", async () => {
    const pub = await fetch(`${URL_}/storage/v1/object/public/${BUCKET}/${TOP_LINE}/ticket-photos/x.jpg`);
    expect(pub.ok).toBe(false);
    const { data } = await as(null).storage.listBuckets();
    expect(data ?? []).toEqual([]);
    const { data: bucket } = await admin().storage.getBucket(BUCKET);
    expect(bucket).toMatchObject({ public: false, file_size_limit: 5242880 });
  });

  it("a driver uploads only to their own reserved path; tampered paths, other drivers and other companies are refused", async () => {
    const r = await reserve(w.users.driver, w.a1!);
    expect((await upload(w.users.driver, `${TOP_LINE}/ticket-photos/${randomUUID()}.jpg`)).error).toBeTruthy(); // invented id
    expect((await upload(w.users.driver, `${w.bCompany}/ticket-photos/${r.attachment_id}.jpg`)).error).toBeTruthy(); // other company folder
    expect((await upload(w.users.driver2, r.object_path)).error).toBeTruthy(); // another driver
    expect((await upload(w.users.bOwner, r.object_path)).error).toBeTruthy(); // another company
    expect((await upload(null, r.object_path)).error).toBeTruthy(); // anonymous
    expect((await upload(w.users.driver, r.object_path, Buffer.from("<html>"), "text/html")).error).toBeTruthy(); // not an allowed type
    // Another driver cannot even reserve a path on this driver's load.
    expect((await as(w.users.driver2).rpc("driver_begin_ticket_photo", { p_assignment_id: w.a1, p_upload_key: randomUUID(), p_mime: "image/jpeg", p_size: 10, p_sha256: "a".repeat(64) })).error?.code).toBe("42501");

    const ok = await upload(w.users.driver, r.object_path);
    expect(ok.error).toBeNull();
    expect((await upload(w.users.driver, r.object_path, JPEG, "image/jpeg", true)).error).toBeTruthy(); // no overwrite
    const confirmed = await as(w.users.driver).rpc("driver_confirm_ticket_photo", { p_attachment_id: r.attachment_id });
    expect(confirmed.error).toBeNull();
    expect(confirmed.data).toMatchObject({ status: "uploaded" });
    // Drivers cannot read back or delete.
    expect((await as(w.users.driver).storage.from(BUCKET).download(r.object_path)).error).toBeTruthy();
    await as(w.users.driver).storage.from(BUCKET).remove([r.object_path]);
    expect((await admin().storage.from(BUCKET).download(r.object_path)).error).toBeNull();

    // Over the bucket's 5 MB limit (last: the server closes the connection on rejection).
    const big = await reserve(w.users.driver, w.a1!, 5 * 1024 * 1024);
    expect((await upload(w.users.driver, big.object_path, Buffer.alloc(5 * 1024 * 1024 + 10, 1))).error).toBeTruthy();
    expect((await admin().storage.from(BUCKET).download(big.object_path)).error).toBeTruthy();
  });

  it("after attachment only the office of the same company can read it, through short-lived links", async () => {
    const r = await reserve(w.users.driver, w.a1!);
    expect((await upload(w.users.driver, r.object_path)).error).toBeNull();
    await as(w.users.driver).rpc("driver_confirm_ticket_photo", { p_attachment_id: r.attachment_id });
    // Not attached yet: nobody in the app can read it.
    expect((await as(w.users.office).storage.from(BUCKET).createSignedUrl(r.object_path, 60)).error).toBeTruthy();

    const sent = await as(w.users.driver).rpc("driver_submit_ticket", { p_payload: {
      assignment_id: w.a1, order_line_id: w.line, delivered_date: w.yesterday, delivered_time: "07:30", quantity: "20",
      unit_code: "ton", external_reference: `ST-${randomUUID().slice(0, 6)}`, submission_key: randomUUID(), photo_ids: [r.attachment_id] } });
    expect(sent.error).toBeNull();
    expect(sent.data).toMatchObject({ created: true, photos: 1 });

    const signed = await as(w.users.office).storage.from(BUCKET).createSignedUrl(r.object_path, 60);
    expect(signed.error).toBeNull();
    const got = await fetch(signed.data!.signedUrl);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(JPEG)).toBe(true);
    expect((await as(w.users.office).storage.from(BUCKET).download(r.object_path)).error).toBeNull();

    for (const who of ["mechanic", "driver", "driver2", "bOwner"]) {
      expect((await as(w.users[who]).storage.from(BUCKET).createSignedUrl(r.object_path, 60)).error, who).toBeTruthy();
      expect((await as(w.users[who]).storage.from(BUCKET).download(r.object_path)).error, who).toBeTruthy();
    }
    expect((await as(null).storage.from(BUCKET).createSignedUrl(r.object_path, 60)).error).toBeTruthy();

    // Expired link.
    const short = await as(w.users.office).storage.from(BUCKET).createSignedUrl(r.object_path, 1);
    await new Promise((res) => setTimeout(res, 2500));
    expect((await fetch(short.data!.signedUrl)).ok).toBe(false);
    // A tampered link (another object) does not work either.
    expect((await fetch(signed.data!.signedUrl.replace(r.attachment_id, randomUUID()))).ok).toBe(false);
    // Office cannot change or remove it.
    expect((await upload(w.users.office, r.object_path, JPEG, "image/jpeg", true)).error).toBeTruthy();
    await as(w.users.office).storage.from(BUCKET).remove([r.object_path]);
    expect((await admin().storage.from(BUCKET).download(r.object_path)).error).toBeNull();
  });

  it("the cleanup script removes abandoned uploads and marks them discarded", async () => {
    const r = await reserve(w.users.driver, w.a1!);
    expect((await upload(w.users.driver, r.object_path)).error).toBeNull();
    await as(w.users.driver).rpc("driver_confirm_ticket_photo", { p_attachment_id: r.attachment_id });
    // Age the record past the 24-hour window (test setup only; the app cannot do this).
    const c = new pg.Client({ connectionString: DB });
    await c.connect();
    await c.query("alter table public.ticket_attachments disable trigger ticket_attachments_guard");
    await c.query("update public.ticket_attachments set created_at = now() - interval '2 days' where id = $1", [r.attachment_id]);
    await c.query("alter table public.ticket_attachments enable trigger ticket_attachments_guard");
    const out = execFileSync("node", ["scripts/cleanup-ticket-photos.mjs", "--hours=24"], {
      env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: env.DEV_SERVICE_ROLE_KEY },
      encoding: "utf8",
    });
    expect(out).toMatch(/marked \d+ record\(s\) discarded/);
    expect((await admin().storage.from(BUCKET).download(r.object_path)).error).toBeTruthy();
    expect((await c.query("select status from public.ticket_attachments where id = $1", [r.attachment_id])).rows[0].status).toBe("discarded");
    await c.end();
  });
});
