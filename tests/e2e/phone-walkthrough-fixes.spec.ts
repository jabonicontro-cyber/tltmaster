// Phone walkthrough fixes, driver and mechanic (2026-11-16, items P1–P16 of the first-day walkthroughs). Phone size,
// touch. Own test logins (a driver and a mechanic of Top Line made here), so the shared e2e users are not signed out or
// re-linked. Fictional records only; nothing is sent anywhere.
import { mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, unique } from "./helpers";
import { PASSWORD, TOP_LINE_SLUG, USERS } from "./users";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const SHOTS = process.env.FIX3_SHOTS;
const shot = async (page: Page, name: string, fullPage = false) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
};

const ME = {
  driver: { email: "e2e-b3-driver@toplinetest.example", name: "Bea Batch Driver", role: "driver" },
  mechanic: { email: "e2e-b3-mechanic@toplinetest.example", name: "Mo Batch Mechanic", role: "mechanic" },
} as const;

/** This spec's own logins in Top Line (created once, password reset each run). */
async function ensureUser(u: (typeof ME)[keyof typeof ME]): Promise<string> {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: existing } = await admin.from("profiles").select("id").eq("email", u.email).maybeSingle();
  let id = existing?.id as string | undefined;
  if (!id) {
    const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: u.name } });
    if (error) throw new Error(error.message);
    id = data.user.id;
  } else await admin.auth.admin.updateUserById(id, { password: PASSWORD });
  await admin.from("profiles").update({ full_name: u.name }).eq("id", id);
  const { data: co } = await admin.from("companies").select("id").eq("slug", TOP_LINE_SLUG).single();
  const { error } = await admin.from("company_memberships").upsert({ company_id: co!.id, user_id: id, role: u.role, active: true }, { onConflict: "company_id,user_id" });
  if (error) throw new Error(error.message);
  return id;
}

async function signInAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/** The phone menu (retried until the page has hydrated and the menu opens). */
async function openMenu(page: Page) {
  await expect(async () => {
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("dialog").getByRole("navigation", { name: "Main" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;

/** This spec's driver linked to a fresh driver record with a truck and a load late today (as tests/e2e/driver-fixture.ts). */
async function driverDay(userId: string) {
  const id = unique();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    await q("update public.drivers set user_id = null, name = 'Bea Batch Driver (earlier e2e run)', active = false where user_id = $1", [userId]);
    const me = await ins("drivers", { user_id: userId });
    const future = new Date(Date.now() + 600 * 86_400_000).toISOString().slice(0, 10);
    await ins("driver_qualifications", { driver_id: me, kind: "cdl", cdl_class: "A", expires_on: future, verified_at: new Date().toISOString() });
    await ins("driver_qualifications", { driver_id: me, kind: "medical_card", expires_on: future, verified_at: new Date().toISOString() });
    const truck = `B3-${id}`;
    const truckId = await ins("trucks", { unit_number: truck, truck_type: "tri_axle_dump" });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "200 Batch Site Rd (test)", customer_id: cust.rows[0].id, order_date: today, project_name: `Phone fixes e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 }],
    })]);
    const o = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: today, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    const load = ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: o.order_id, load_date: today, start_time: "23:00", end_time: "23:59", planned_quantity: "22", unit_code: "ton" })])).rows[0].r as { load_id: string }).load_id;
    const assignment = ((await q("select public.assign_load($1, $2, null, $3, '', null) as r", [load, truckId, me])).rows[0].r as { assignment_id: string }).assignment_id;
    const number = ((await q("select load_number from public.order_loads where id = $1", [load])).rows[0].load_number) as number;
    return { orderNumber: o.order_number, assignment, truck, truckId, loadNumber: number, ref: `B3-${id}` };
  });
}

/** A small real PNG so the phone's re-encoding has something to decode. */
function png(width = 64, height = 48) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x88)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test.describe.configure({ mode: "serial" });

test("driver: without signal a breakdown report and a ticket with its photo wait on the phone and reach the office", async ({ page, context }) => {
  test.setTimeout(240_000);
  const userId = await ensureUser(ME.driver);
  const f = await driverDay(userId);
  await signInAs(page, ME.driver.email);
  await expect(page).toHaveURL(/\/driver/);
  await expect(page.getByRole("heading", { name: "My Day" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("taviron-offline-day")), { timeout: 20_000 }).toContain(f.truck);

  // P14: a driver-only login has no Settings in the menu, and the page sends them to My Day.
  await openMenu(page);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Time Off" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" })).toHaveCount(0);
  await shot(page, "p14-driver-menu-no-settings");
  await page.keyboard.press("Escape");
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/driver$/);
  // P13/P16: the logo is named after the company and leads to the person's own start page.
  await expect(page.getByRole("link", { name: /Top Line Trucking, home/ }).first()).toHaveAttribute("href", "/driver");

  // P1: a breakdown reported with no signal is saved on the phone with its photo.
  await page.goto(`/driver/assignments/${f.assignment}/report`);
  await expect(page.getByRole("heading", { name: "Report a problem" })).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel(/^Breakdown/).check();
  await page.getByLabel("What happened?").fill(`Engine quit on the ramp (${f.ref})`);
  await page.locator("#r-photos").setInputFiles({ name: "engine.png", mimeType: "image/png", buffer: png() });
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved on this phone with its photo, not sent yet" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Saved on this phone" })).toBeInViewport();
  await page.waitForTimeout(800); // the smooth scroll that brings it above the Send bar
  await shot(page, "p1-report-saved-offline");

  // P2: a ticket photo taken without signal stays on the phone and goes with the ticket.
  await context.setOffline(false);
  await page.goto(`/driver/assignments/${f.assignment}/ticket`);
  await expect(page.getByLabel(/Paper \/ scale ticket number/)).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel(/Paper \/ scale ticket number/).fill(f.ref);
  await page.getByLabel("Quantity on the ticket").fill("18.5");
  await page.locator("#ticket-photo").setInputFiles({ name: "ticket.png", mimeType: "image/png", buffer: png() });
  const photo = page.getByRole("listitem", { name: "Photo 1" });
  await expect(photo).toContainText("No signal. The photo stays on this phone and goes with the ticket.");
  // The message keeps the card's width (it used to wrap one word per line).
  expect((await photo.getByRole("status").boundingBox())!.width).toBeGreaterThan(200);
  await photo.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(page, "p2-ticket-photo-kept-offline");
  await page.getByRole("button", { name: "Send ticket" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved on this phone with its photo, not sent yet" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Saved on this phone with its photo" })).toBeInViewport();
  await page.waitForTimeout(800); // the smooth scroll that brings it above the Send bar
  await shot(page, "p2-ticket-saved-offline");

  // Signal back on My Day: both are sent by themselves, photos first, and the driver is told (P3).
  await context.setOffline(false);
  await page.goto("/driver");
  const reached = () => office(async (q) => ({
    report: (await q("select r.kind, r.description, (select count(*)::int from public.field_report_photos p where p.report_id = r.id and p.failed_at is null) photos from public.field_reports r where r.description like $1", [`%${f.ref}%`])).rows,
    tickets: (await q("select t.id, (select count(*)::int from public.ticket_attachments a where a.ticket_id = t.id) photos from public.delivery_tickets t where t.external_reference = $1", [f.ref])).rows,
  }));
  await expect.poll(async () => { const r = await reached(); return r.report.length === 1 && r.tickets.length === 1 && r.report[0].photos === 1 && r.tickets[0].photos === 1; }, { timeout: 45_000 }).toBe(true);
  const rows = await reached();
  expect(rows.report[0]).toMatchObject({ kind: "breakdown" });
  expect(rows.report[0].description).toMatch(/Written at .* with no signal; sent once the phone had signal\./);
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: /sent to the office/i }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Waiting to send" })).toHaveCount(0);
  await shot(page, "p3-sent-toast");
  expect(await page.evaluate(() => localStorage.getItem("taviron-offline-photos"))).toBeNull();
});

test("driver: the offline page offers Report a problem, and says what was sent when signal returns", async ({ page, context }) => {
  test.setTimeout(180_000);
  const userId = await ensureUser(ME.driver);
  const f = await driverDay(userId);
  await signInAs(page, ME.driver.email);
  await expect(page.getByRole("heading", { name: "My Day" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("taviron-offline-day")), { timeout: 20_000 }).toContain(f.truck);
  await context.setOffline(true);
  await page.goto("/driver").catch(() => undefined);
  await expect(page.getByText(/Your day as of .*No connection/)).toBeVisible();
  const load = page.getByRole("listitem", { name: `Load ${f.loadNumber}, ${f.orderNumber}` });
  await load.getByRole("button", { name: "Report a problem" }).click();
  const form = page.getByRole("region", { name: "Report a problem" });
  await form.getByLabel(/^Running late/).check();
  await form.getByLabel("What happened?").fill(`Road closed at the bridge (${f.ref})`);
  await shot(page, "p1-offline-page-report");
  await form.getByRole("button", { name: "Send report" }).click();
  await expect(form.getByRole("status")).toContainText("Saved on this phone");
  await expect(page.getByRole("region", { name: "Waiting to send" })).toContainText(`Running late · ${f.orderNumber} load ${f.loadNumber}`);
  await shot(page, "p1-offline-page-waiting");
  await expect(form).toHaveCount(0); // back to the saved day once it is kept
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("sent-confirmation")).toContainText(`Sent to the office: Running late · ${f.orderNumber} load ${f.loadNumber}.`, { timeout: 45_000 });
  await shot(page, "p3-my-day-sent-banner");
  const n = await office(async (q) => (await q("select count(*)::int n from public.field_reports where description like $1", [`%${f.ref}%`])).rows[0].n);
  expect(n).toBe(1);
});

test("driver: the inspection count sits by Save and counts down; fuel takes $231.50; stop buttons say what they do", async ({ page }) => {
  test.setTimeout(180_000);
  const userId = await ensureUser(ME.driver);
  const f = await driverDay(userId);
  await signInAs(page, ME.driver.email);
  await expect(page.getByRole("heading", { name: "My Day" })).toBeVisible({ timeout: 30_000 });

  // P5
  await page.getByText(/Pre-trip inspection: do this before you drive/).click();
  const form = page.getByRole("form", { name: "Vehicle inspection" });
  const truck = form.getByLabel("Truck", { exact: true });
  if (await truck.count()) await truck.selectOption({ label: `Truck ${f.truck}` });
  await form.getByRole("button", { name: "Save inspection" }).click();
  const left = form.getByTestId("inspection-left");
  await expect(left).toHaveText(/^16 items are not marked yet/);
  await expect(form.getByRole("group", { name: "Service brakes" }).getByRole("button", { name: "OK" })).toBeFocused();
  await shot(page, "p5-inspection-first-unmarked");
  await form.getByRole("group", { name: "Service brakes" }).getByRole("button", { name: "OK" }).click();
  await expect(left).toHaveText(/^15 items are not marked yet/);
  await left.scrollIntoViewIfNeeded();
  await shot(page, "p5-inspection-count-by-save");
  await form.getByRole("button", { name: "Mark the rest OK" }).click();
  await expect(left).toHaveCount(0);

  // P8: the stop buttons are actions, and the confirmation says what was saved and when.
  const card = page.getByRole("listitem", { name: new RegExp(`Load ${f.loadNumber}.*${f.orderNumber}`) }).first();
  await card.getByRole("button", { name: "Record arrival at the pickup" }).click();
  await expectToast(page, /^Arrival at the pickup saved: \d/);
  await shot(page, "p8-stop-saved");

  // P7: a total typed as on the receipt is accepted.
  await page.getByText("Record fuel", { exact: true }).click();
  const fuel = page.getByRole("form", { name: "Record fuel" });
  await fuel.getByLabel("Gallons").fill("82.4");
  await fuel.getByLabel("Total ($)").fill("$231.50");
  await fuel.getByRole("button", { name: "Save fuel" }).click();
  await expectToast(page, "Fuel recorded.");
  await shot(page, "p7-fuel-saved");
  // Fuel amounts are money (SEC5): read here with the test database's own login, not as a company member.
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try {
    const cents = (await db.query("select total_cents from public.fuel_purchases where truck_id = $1 order by created_at desc limit 1", [f.truckId])).rows[0]?.total_cents;
    expect(Number(cents)).toBe(23150);
  } finally {
    await db.end();
  }
});

test("mechanic: home is My jobs, no Settings, parts on order are reused and received, and finishing warns", async ({ page }) => {
  test.setTimeout(240_000);
  await ensureUser(ME.mechanic);
  const title = `Phone fixes job ${unique()}`;
  const ids = await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`B3M-${unique()}`.slice(0, 20)])).rows[0].id as string;
    const wo = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title, category: "brakes", urgency: "high", safety_critical: true })])).rows[0].r.id as string;
    await q("select public.maintenance_set_status($1, 'triaged')", [wo]);
    await q("select public.maintenance_add_task($1, 'Replace and torque to spec')", [wo]);
    await q("select public.part_wait_add($1, $2::jsonb)", [wo, JSON.stringify({ description: "Brake chamber 30/30" })]);
    // A second, non-safety job to complete on the work order page (P9).
    const wo2 = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title: `Wiper blades ${unique()}`, category: "repair", urgency: "normal", safety_critical: false })])).rows[0].r.id as string;
    await q("select public.maintenance_set_status($1, 'triaged')", [wo2]);
    return { wo, wo2 };
  });

  // P13: the installed app's start page and the logo lead a mechanic-only login to My jobs; P14: no Settings.
  await signInAs(page, ME.mechanic.email);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/maintenance\/my-jobs$/);
  await expect(page.getByRole("link", { name: /Top Line Trucking, home/ }).first()).toHaveAttribute("href", "/maintenance/my-jobs");
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/maintenance\/my-jobs$/);
  await openMenu(page);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Maintenance" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Take and start the job, then "Waiting for parts": the part already on order is offered (P11), no second line.
  await page.goto("/maintenance/my-jobs");
  await page.getByRole("listitem").filter({ hasText: title }).filter({ hasText: "Take this job" }).first().getByRole("button", { name: "Take this job" }).click();
  await expectToast(page, "Lead mechanic set.");
  const mine = page.getByRole("listitem").filter({ hasText: title }).filter({ hasText: "You lead this job" }).first();
  await mine.getByRole("button", { name: "Start this job" }).click();
  await expectToast(page, /Job started/);
  await mine.getByRole("button", { name: "Waiting for parts" }).click();
  await expect(mine.getByTestId("already-on-order")).toContainText("Brake chamber 30/30");
  await shot(page, "p11-waiting-offers-part-on-order");
  await mine.getByRole("button", { name: "Wait for this part" }).click();
  await expectToast(page, /^Waiting for parts/);
  const lines = async () => asUser(USERS.owner.email, async (q) => (await q("select status from public.work_order_part_waits where work_order_id = $1 order by created_at", [ids.wo])).rows.map((r) => r.status));
  expect(await lines()).toEqual(["waiting"]);

  // "Part is in: start again" receives it (P11).
  await mine.getByRole("button", { name: "Part is in: start again" }).click();
  const which = mine.getByRole("form", { name: "Which parts are in?" });
  await expect(which.getByLabel("Brake chamber 30/30")).toBeChecked();
  await shot(page, "p11-part-is-in");
  await which.getByRole("button", { name: "Received, start again" }).click();
  await expectToast(page, /Part received: Brake chamber 30\/30\. Job started/);
  expect(await lines()).toEqual(["received"]);

  // Finishing with a checklist step open warns first (P12), then sends for inspection when asked again.
  await expect(mine.getByTestId("next-step")).toBeVisible();
  await mine.getByRole("button", { name: "Finish the job" }).click();
  await mine.getByLabel("What did you fix?").fill("Replaced the rear brake chamber");
  await mine.getByRole("button", { name: "Send for inspection" }).click();
  const warning = mine.getByTestId("finish-warning");
  await expect(warning).toContainText("1 checklist step is not ticked: Replace and torque to spec.");
  await shot(page, "p12-finish-warning");
  await mine.getByRole("button", { name: "Send for inspection anyway" }).click();
  await expectToast(page, /^Sent for inspection/);
  // The screen follows without a reload (P9): the job leaves My jobs.
  await expect(page.getByRole("listitem").filter({ hasText: title }).filter({ hasText: "You lead this job" })).toHaveCount(0);

  // On the work order page, Mark completed shows the new state without a reload (P9).
  await page.goto(`/maintenance/work-orders/${ids.wo2}`);
  await page.getByRole("button", { name: "Start this job" }).click();
  await expectToast(page, /Job started/);
  await page.getByRole("button", { name: "Finish the job" }).first().click();
  await page.getByLabel("What did you fix?").fill("New wiper blades");
  await page.getByRole("form", { name: "Finish the job" }).getByRole("button", { name: "Mark completed" }).click();
  await expectToast(page, /completed/i);
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Finish the job" })).toHaveCount(0);
  await shot(page, "p9-completed-without-reload");
});
