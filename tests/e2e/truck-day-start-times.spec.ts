import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Truck-day jobs, different start times in one step (UX11 open item, 20261120022100): "Add trucks" on the board can give
// each truck its own start time; all trucks are added at once.

test("dispatch adds trucks for the day with a start time for each truck in one step", async ({ browser }) => {
  const id = unique();
  const setup = await asUser(USERS.owner.email, async (q) => {
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping'");
    const mat = await q("select id from public.materials where code = 'GRV-53'");
    const o = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, order_date: today, project_name: `Staggered day ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mat.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "200", unit_rate_cents: 1000 }],
    })])).rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: today, scheduled_end: null })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    await q("select public.set_order_job_type($1, 'truck_day', 'tickets')", [o.order_id]);
    return { orderId: o.order_id, orderNumber: o.order_number, today };
  });

  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await context.newPage();
  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${setup.today}`);
  const card = page.getByRole("link", { name: setup.orderNumber, exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add trucks']][1]");
  await card.getByRole("button", { name: "Add trucks" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Trucks").fill("3");
  await dialog.getByLabel("Until (planned)").fill("17:00");
  // Folded away until wanted; each truck starts at the shared time until changed.
  await expect(dialog.getByLabel("Truck 1 starts")).toHaveCount(0);
  await dialog.getByLabel("From").fill("06:00");
  await dialog.getByLabel("Different start times").check();
  await expect(dialog.getByLabel("Truck 1 starts")).toHaveValue("06:00");
  await expect(dialog.getByLabel("Truck 3 starts")).toHaveValue("06:00");
  await dialog.getByLabel("Truck 3 starts").fill("07:30");
  const shots = process.env.AI_OPTIN_SHOTS;
  if (shots) await dialog.screenshot({ path: `${shots}/truck-day-start-times-dialog.png` });

  // A truck starting after the planned end is refused next to the times, and nothing is added.
  await dialog.getByLabel("Truck 2 starts").fill("18:00");
  await dialog.getByRole("button", { name: "Add trucks" }).click();
  await expect(dialog.getByText("Every truck must start before the planned end.")).toBeVisible();
  await dialog.getByLabel("Truck 2 starts").fill("06:00");
  await dialog.getByRole("button", { name: "Add trucks" }).click();
  await expectToast(page, "3 trucks added for the day. Assign a truck and driver to each.");

  const starts = await asUser(USERS.dispatcher.email, async (q) =>
    (await q("select start_time::text s from public.order_loads where order_id = $1 order by load_number", [setup.orderId])).rows.map((r) => r.s as string));
  expect(starts).toEqual(["06:00:00", "06:00:00", "07:30:00"]);
  if (shots) {
    await page.reload();
    const full = page.getByRole("link", { name: setup.orderNumber, exact: true }).first().locator("xpath=ancestor::*[.//li[@aria-label='Load 3']][1]");
    await full.scrollIntoViewIfNeeded();
    await full.screenshot({ path: `${shots}/truck-day-start-times-board.png` });
  }
  await context.close();
});
