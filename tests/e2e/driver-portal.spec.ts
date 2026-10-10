import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** The driver account's user id (fixture lookup on the local test database). */
async function driverUserId() {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<{ id: string }>("select id from public.profiles where email = $1", [USERS.driver.email])).rows[0].id;
  } finally {
    await c.end();
  }
}
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;

/**
 * Links the e2e driver account to a fresh driver record (earlier runs' records
 * are unlinked and kept), and gives it yesterday's load and a load late today.
 * Another driver gets a load on the same order.
 */
async function fixture() {
  const id = unique();
  const userId = await driverUserId();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      const r = await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
      return r.rows[0].id as string;
    };
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    await q("update public.drivers set user_id = null, name = 'Drew Driver (earlier e2e run)', active = false where user_id = $1", [userId]);
    const verified = new Date().toISOString();
    const qualified = async (row: Record<string, unknown>) => {
      const d = await ins("drivers", row);
      await ins("driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: plusDays(600), verified_at: verified });
      await ins("driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: plusDays(20), verified_at: verified });
      return d;
    };
    const me = await qualified({ user_id: userId });
    const other = await qualified({ name: `Other Driver ${id}` });
    const myTruck = await ins("trucks", { unit_number: `DRV-${id}`, truck_type: "tri_axle_dump" });
    const otherTruck = await ins("trucks", { unit_number: `OTH-${id}`, truck_type: "tri_axle_dump" });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [
      JSON.stringify({
        customer_id: cust.rows[0].id, order_date: yesterday, project_name: `Driver e2e ${id}`, job_instructions: "Dump at the north pad, back in from Elm St.",
        internal_notes: "OFFICE-ONLY-NOTE e2e",
        lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 }],
      }),
    ]);
    const o = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: yesterday, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    const plan = async (date: string, start: string, end: string) =>
      ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: o.order_id, load_date: date, start_time: start, end_time: end, planned_quantity: "22", unit_code: "ton" })])).rows[0].r as { load_id: string }).load_id;
    const assignTo = async (load: string, truck: string, driver: string) =>
      ((await q("select public.assign_load($1, $2, null, $3, '', null) as r", [load, truck, driver])).rows[0].r as { assignment_id: string }).assignment_id;
    const pastLoad = await plan(yesterday, "07:00", "09:00");
    const past = await assignTo(pastLoad, myTruck, me);
    const lateLoad = await plan(today, "23:00", "23:59");
    const late = await assignTo(lateLoad, myTruck, me);
    const otherLoad = await plan(yesterday, "10:00", "12:00");
    const otherAssignment = await assignTo(otherLoad, otherTruck, other);
    return { orderId: o.order_id, orderNumber: o.order_number, past, late, otherAssignment, myTruck: `DRV-${id}`, otherTruck: `OTH-${id}`, ref: `SC-${id}` };
  });
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test("a driver sees only their own day, sends a ticket (with a failed send and a retry) and reports a breakdown", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "driver");
  await expect(page).toHaveURL(/\/driver$/);
  await expect(page.getByRole("heading", { name: "My Day" })).toBeVisible();
  await expect(page.getByText(/medical card expires on/)).toBeVisible();
  const still = page.getByRole("region", { name: "Tickets still needed" });
  const pastCard = still.getByRole("listitem", { name: `Load 1, ${f.orderNumber}` });
  await expect(pastCard).toContainText(f.myTruck);
  await pastCard.getByText("Instructions and directions").click();
  await expect(pastCard).toContainText("Dump at the north pad, back in from Elm St.");
  await expect(page.getByText(f.otherTruck)).toHaveCount(0);
  await expect(page.getByText("OFFICE-ONLY-NOTE e2e")).toHaveCount(0);
  await expect(page.getByText("$10.00")).toHaveCount(0);
  await noHorizontalScroll(page);

  // Ticket for yesterday's load.
  await pastCard.getByRole("link", { name: "Enter delivery ticket" }).click();
  await expect(page).toHaveURL(new RegExp(`/driver/assignments/${f.past}/ticket`));
  await expect(page.getByLabel("Gravel #53 limestone")).toBeChecked(); // the only line
  await page.getByLabel("Quantity on the ticket").fill("21.47");
  await page.getByRole("button", { name: "Send ticket" }).click();
  await expect(page.getByText("Tap the unit on the paper ticket.")).toBeVisible();
  await page.getByLabel(/^Tons/).check();
  await page.getByLabel("Delivery time").fill("08:30");
  await page.getByLabel("Paper / scale ticket number").fill(f.ref);
  await noHorizontalScroll(page);

  // No signal: nothing is reported as sent.
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Send ticket" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not sent — no connection to the office" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/ticket$`));
  await page.context().setOffline(false);
  await page.getByRole("button", { name: "Send again" }).dblclick();
  await expect(page).toHaveURL(/\/driver\?sent=/);
  await expect(page.getByRole("status")).toContainText(/Ticket T-\d{4}-\d{5} sent to the office\./);
  const recent = page.getByRole("list", { name: "My recent tickets" });
  await expect(recent.getByText("Sent — waiting for office review").first()).toBeVisible();
  const count = await office(async (q) => (await q("select count(*)::int as n from public.delivery_tickets where external_reference = $1", [f.ref])).rows[0].n as number);
  expect(count).toBe(1); // one ticket despite the failed attempt and the double tap
  await expect(page.getByRole("region", { name: "Tickets still needed" })).toHaveCount(0);

  // Breakdown report on today's load.
  const todayCard = page.getByRole("region", { name: "Today" }).getByRole("listitem", { name: `Load 2, ${f.orderNumber}` });
  await todayCard.getByRole("link", { name: "Report a problem" }).click();
  await page.getByLabel(/^Breakdown/).check();
  await page.getByLabel(`Truck ${f.myTruck}`).check();
  await page.getByLabel("What happened?").fill("Air leak on the tag axle (e2e)");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByRole("status")).toContainText("Report sent to the office.");
  await expect(page.getByRole("list", { name: "My reports" })).toContainText("Sent — not seen yet");

  // Direct access to someone else's load or to office pages is refused.
  await page.goto(`/driver/assignments/${f.otherAssignment}/ticket`);
  await expect(page.getByText("This load is not available")).toBeVisible();
  for (const path of ["/tickets", "/billing", "/command-center", "/orders", "/field-reports"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/no-access/);
  }

  // The office sees the report, resolves it, and the driver sees the result.
  await page.context().clearCookies();
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page, "office");
  await page.goto("/command-center?kind=equipment_report");
  const item = page.getByRole("listitem", { name: new RegExp(`Drew Driver reported a problem with truck ${f.myTruck}`) });
  await expect(item.getByText("Urgent", { exact: true })).toBeVisible();
  await item.getByRole("link", { name: "Open the report" }).click();
  await expect(page).toHaveURL(/\/field-reports\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Breakdown — Drew Driver" })).toBeVisible();
  await expect(page.getByText("Air leak on the tag axle (e2e)")).toBeVisible();
  await page.getByRole("button", { name: "Resolve" }).click();
  await page.getByRole("dialog").getByLabel("How was it resolved?").fill("Shop replaced the fitting (e2e)");
  await page.getByRole("dialog").getByRole("button", { name: "Resolve" }).click();
  await expectToast(page, "Report resolved.");
  const truckStatus = await office(async (q) => (await q("select service_status from public.trucks where unit_number = $1", [f.myTruck])).rows[0].service_status);
  expect(truckStatus).toBe("in_service"); // the report changed nothing by itself

  await page.context().clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "driver");
  await expect(page.getByRole("list", { name: "My reports" })).toContainText("Resolved");
});

test("an account not linked to a driver record gets a clear message", async ({ page }) => {
  const userId = await driverUserId();
  await office(async (q) => {
    await q("update public.drivers set user_id = null, name = 'Drew Driver (unlinked by e2e)', active = false where user_id = $1", [userId]);
  });
  await signIn(page, "driver");
  await expect(page.getByText("Your account is not linked to a driver yet")).toBeVisible();
  await noHorizontalScroll(page);
});
