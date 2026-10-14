import { expect, test, type Page } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;

/** A scheduled order with yesterday's load assigned (no ticket) and a load late today without a truck. */
async function fixture() {
  const id = unique();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      const r = await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
      return r.rows[0].id as string;
    };
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    const truckId = await ins("trucks", { unit_number: `CC-${id}`, truck_type: "tri_axle_dump" });
    const driverId = await ins("drivers", { name: `Casey Command ${id}` });
    const verified = new Date().toISOString();
    await ins("driver_qualifications", { driver_id: driverId, kind: "cdl", cdl_class: "A", expires_on: plusDays(600), verified_at: verified });
    await ins("driver_qualifications", { driver_id: driverId, kind: "medical_card", expires_on: plusDays(600), verified_at: verified });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [
      JSON.stringify({
        site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id,
        order_date: yesterday,
        project_name: `Command e2e ${id}`,
        lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 }],
      }),
    ]);
    const res = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [res.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [res.order_id, JSON.stringify({ scheduled_start: yesterday, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [res.order_id]);
    const plan = async (date: string, start: string, end: string) =>
      ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: res.order_id, load_date: date, start_time: start, end_time: end })])).rows[0].r as { load_id: string }).load_id;
    const pastLoad = await plan(yesterday, "07:00", "09:00");
    await q("select public.assign_load($1, $2, null, $3, '', null)", [pastLoad, truckId, driverId]);
    const lateLoad = await plan(today, "23:00", "23:59");
    const line = (await q("select id from public.order_lines where order_id = $1", [res.order_id])).rows[0].id as string;
    return { orderNumber: res.order_number, pastLoad, lateLoad, line, today, yesterday };
  });
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test("office sees prioritized items, opens the right workflow, assigns a person, and the item clears when fixed", async ({ page }) => {
  test.setTimeout(150_000); // several queues, each paged through on the shared test database
  const f = await fixture();
  await signIn(page, "office");
  await page.goto("/command-center");
  await expect(page.getByRole("heading", { name: "Command Center", level: 1 })).toBeVisible();
  const overview = page.getByRole("list", { name: "Overview" });
  for (const label of ["Loads today", "Missing delivery tickets", "Tickets to review", "Orders blocked from billing", "Orders ready to bill", "Trucks out of service"]) {
    await expect(overview.getByRole("listitem", { name: label, exact: true })).toBeVisible();
  }
  await expect(overview.getByRole("listitem", { name: "Maintenance due" })).toContainText("Not available");

  // The metric opens the filtered queue.
  await overview.getByRole("listitem", { name: "Missing delivery tickets" }).getByRole("link").click();
  await expect(page).toHaveURL(/kind=missing_ticket/);
  const missingTitle = `${f.orderNumber} · load 1 has no delivery ticket`;
  const missing = page.getByRole("listitem", { name: missingTitle });
  // Oldest first: on a database with earlier runs the new item may be on a later page.
  let queue = "/command-center?kind=missing_ticket";
  for (let p = 1; p <= 20 && !(await missing.count()); p++) {
    queue = `/command-center?kind=missing_ticket${p > 1 ? `&page=${p}` : ""}`;
    await page.goto(queue);
    await page.getByRole("list", { name: "Attention items" }).waitFor();
  }
  await expect(missing).toContainText("The load has ended and no delivery ticket was entered.");
  // The link opens the exact workflow step and remembers this queue view.
  await expect(missing.getByRole("link", { name: "Enter the ticket" })).toHaveAttribute("href", `/tickets/new?load=${f.pastLoad}&back=${encodeURIComponent(`${queue}#attention`)}`);
  await missing.getByRole("link", { name: "Enter the ticket" }).click();
  await expect(page).toHaveURL(new RegExp(`/tickets/new\\?load=${f.pastLoad}`));
  await page.getByRole("link", { name: "Back to the Command Center" }).click();
  await expect(page).toHaveURL((u) => u.pathname + u.search + u.hash === `${queue}#attention`);
  await expect(missing).toBeVisible();

  // Today's load without a truck is urgent and opens dispatch on that load.
  // The shared test database collects many of today's unassigned loads; the queue shows 20 per page.
  const late = page.getByRole("listitem", { name: `${f.orderNumber} · load 2 today has no truck` });
  for (let p = 1; p <= 10; p++) {
    await page.goto(`/command-center?kind=unassigned_load&page=${p}`);
    if (await late.count()) break;
  }
  await expect(late.getByText("Urgent", { exact: true })).toBeVisible();
  await late.getByRole("link", { name: "Assign a truck" }).click();
  await expect(page).toHaveURL(new RegExp(`/dispatch\\?date=${f.today}&load=${f.lateLoad}`));
  await expect(page.locator(`#load-${f.lateLoad}`)).toHaveAttribute("aria-current", "true");

  // Assign the missing ticket to the dispatcher; the item stays open.
  await page.goto(queue);
  await missing.getByRole("button", { name: "Assign" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Person").locator("option", { hasText: USERS.mechanic.name })).toHaveCount(0);
  await dialog.getByLabel("Person").selectOption({ label: USERS.dispatcher.name });
  await dialog.getByLabel("Note (optional)").fill("Paper copy is in the truck (e2e)");
  await dialog.getByRole("button", { name: "Assign" }).click();
  await expectToast(page, `Assigned to ${USERS.dispatcher.name}.`);
  await expect(missing).toContainText(USERS.dispatcher.name);
  await expect(missing).toContainText("Paper copy is in the truck (e2e)");

  // Fixing the record in its own module clears the item on the next load.
  await office(async (q) => {
    await q("select public.submit_delivery_ticket($1::jsonb)", [
      JSON.stringify({ load_id: f.pastLoad, order_line_id: f.line, delivered_date: f.yesterday, delivered_time: "08:30", quantity: "22", unit_code: "ton", external_reference: `SC-${unique()}` }),
    ]);
  });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(missing).toHaveCount(0);
  // Oldest first: on a database with earlier runs the new ticket may be on a later page.
  const review = page.getByRole("listitem", { name: new RegExp(`\\(${f.orderNumber} · load 1\\) awaits acceptance`) });
  for (let p = 1; p <= 10; p++) {
    await page.goto(`/command-center?kind=ticket_review&page=${p}`);
    await page.getByRole("list", { name: "Attention items" }).waitFor();
    if (await review.count()) break;
  }
  await expect(review).toBeVisible();

  // Phone width: no horizontal scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/command-center");
  await expect(page.getByRole("list", { name: "Overview" })).toBeVisible();
  await noHorizontalScroll(page);
});

test("dispatchers and mechanics see only what their role covers", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/command-center");
  const overview = page.getByRole("list", { name: "Overview" });
  await expect(overview.getByRole("listitem", { name: "Missing delivery tickets" })).toBeVisible();
  await expect(overview.getByRole("listitem", { name: "Orders blocked from billing" })).toHaveCount(0);
  await expect(overview.getByRole("listitem", { name: "Orders ready to bill" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Filter the queue" }).getByRole("link", { name: /Billing blocked/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Assign" })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, "mechanic");
  await page.goto("/command-center");
  await expect(page.getByRole("link", { name: "Command Center" })).toBeVisible();
  await expect(overview.getByRole("listitem", { name: "Trucks out of service" })).toBeVisible();
  await expect(overview.getByRole("listitem", { name: "Maintenance due" })).toContainText("Not available");
  await expect(overview.getByRole("listitem", { name: "Loads today", exact: true })).toHaveCount(0);
  await expect(overview.getByRole("listitem", { name: "Missing delivery tickets" })).toHaveCount(0);
  const kinds = await page.getByRole("list", { name: "Attention items" }).getByRole("listitem").filter({ hasText: /Missing delivery ticket|Ticket to review|Billing blocked|Load without a truck/ }).count();
  expect(kinds).toBe(0);
});

test("users without an operational role and signed-out visitors are refused", async ({ page }) => {
  await page.goto("/command-center");
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, "pending");
  await page.goto("/command-center");
  await expect(page).toHaveURL(/no-access/);
});

test("another company sees only its own (empty) command center", async ({ page }) => {
  await signIn(page, "otherOwner");
  await page.goto("/command-center");
  await expect(page.getByRole("region", { name: "Attention summary" })).toContainText("Nothing needs attention");
  await expect(page.getByText("Nothing needs attention", { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/Command e2e/)).toHaveCount(0);
});
