import { expect, test, type Locator } from "@playwright/test";
import pg from "pg";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// The first-day walkthrough of release 4912577 (2026-11-11), end to end: what a new person in each role saw and the
// fixes. Fictional records only; each test makes its own.

const TOP_LINE = "00000000-0000-4000-8000-000000000001";

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

const plusDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** The shared mechanic leads the job (as "Take this job" does), so it is on their My jobs however many jobs wait. */
async function mechanicLeads(q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>, wo: string) {
  const me = (await q("select id from public.profiles where email = $1", [USERS.mechanic.email])).rows[0].id as string;
  await q("select public.maintenance_add_mechanic($1, $2, true)", [wo, me]);
}

async function newTruck(unit: string) {
  return asUser(USERS.owner.email, async (q) => (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string);
}

test("truck readings: an old wrong high reading sets Current, is listed first and can be marked wrong; the toast and page agree", async ({ page }) => {
  const unit = `RD-${unique()}`.slice(0, 20);
  const truck = await newTruck(unit);
  // Readings entered before they were checked (as in the demo): one wrong high reading, then 21 lower ones, newer.
  await sql("insert into public.truck_readings (company_id, truck_id, odometer_miles, read_at, note) values ($1, $2, 236466, now() - interval '30 days', 'typo (e2e)')", [TOP_LINE, truck]);
  for (let i = 0; i < 21; i++) {
    await sql("insert into public.truck_readings (company_id, truck_id, odometer_miles, read_at) values ($1, $2, $3, now() - make_interval(days => $4))", [TOP_LINE, truck, 235_000 + i * 20, 21 - i]);
  }
  const wo = await asUser(USERS.owner.email, async (q) => (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title: `Reading check (e2e ${unit})` })])).rows[0].r.id as string);

  await signIn(page, "mechanic");
  // The work order links to its truck by name, not "Record".
  await page.goto(`/maintenance/work-orders/${wo}`);
  await page.getByRole("link", { name: `Truck ${unit}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/fleet/trucks/${truck}`));

  const readings = page.getByTestId("truck-readings");
  await expect(readings.getByTestId("current-reading")).toContainText("Current: 236,466 mi");
  const first = readings.getByRole("listitem").first();
  await expect(first).toContainText("236,466 mi");
  await expect(first).toContainText("Sets the current reading");
  await first.getByRole("button", { name: "Mark the reading 236,466 mi as wrong" }).click();
  await readings.getByLabel("Why is it wrong?").fill("Typo on the trip sheet (e2e)");
  await readings.getByRole("button", { name: "Set it aside" }).click();
  await expectToast(page, "Reading set aside. The current reading is now 235,400 mi.");
  await expect(readings.getByTestId("current-reading")).toContainText("Current: 235,400 mi");
});

test("the office finds orders with a price to check, corrects one, and the words say what happened", async ({ page }) => {
  const id = unique();
  // A dispatcher's phoned-in order with a typed price (no price-list rate for this charge): flagged for the office.
  const order = await asUser(USERS.dispatcher.email, async (q) => {
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE]);
    const r = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: cust.rows[0].id, project_name: `Price check e2e ${id}`, site_line1: "9 Ledger Road (test)", site_city: "Crown Point",
      lines: [{ kind: "other", calc_method: "per_unit", description: `Rush haul (e2e ${id})`, unit_code: "load", quantity: "2", unit_rate_cents: 9500 }],
    })])).rows[0].r as { order_id: string; order_number: string };
    return r;
  });
  const flagged = await sql<{ requested: boolean }>("select price_check_requested_at is not null as requested from public.orders where id = $1", [order.order_id]);
  expect(flagged[0].requested).toBe(true);
  try {
    await signIn(page, "office");
    // Where the office works: the Command Center's attention list...
    await page.goto("/command-center");
    const row = page.getByRole("list", { name: "Attention by kind" }).getByRole("listitem", { name: "Price to check" });
    await expect(row).toBeVisible();
    await row.getByRole("link").click();
    // ...opens the Orders list filtered to them, each marked.
    await expect(page).toHaveURL(/\/orders\?price=check$/);
    await expect(page.getByTestId("orders-price-check")).toContainText(/Price to check: \d+ orders?/);
    const listed = page.getByRole("row").filter({ hasText: order.order_number });
    await expect(listed.getByText("Price to check")).toBeVisible();
    await listed.getByRole("link", { name: order.order_number }).click();

    await page.getByRole("button", { name: "Confirm price" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel(/price per load/).fill("88");
    await d.getByLabel("Why is the price corrected?").fill(`Customer agreed $88 (e2e ${id})`);
    await d.getByRole("button", { name: "Correct and confirm" }).click();
    // Nothing delivered yet: billing waits for the loads, and the toast says so.
    await expectToast(page, "Price corrected and confirmed. Billing can go ahead once the loads are delivered.");
    await expect(page.getByText(/corrected and confirmed the typed price on/)).toBeVisible();
  } finally {
    await asUser(USERS.office.email, (q) => q("select public.set_order_status($1, 'canceled', 'e2e cleanup')", [order.order_id]));
  }
});

test("a confirmed order's corrected price says when and by whom next to the locked prices", async ({ page }) => {
  const id = unique();
  const order = await asUser(USERS.dispatcher.email, async (q) => {
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE]);
    const r = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: cust.rows[0].id, project_name: `Price lock e2e ${id}`, site_line1: "9 Ledger Road (test)", site_city: "Crown Point",
      lines: [{ kind: "other", calc_method: "per_unit", description: `Rush haul (e2e ${id})`, unit_code: "load", quantity: "1", unit_rate_cents: 9500 }],
    })])).rows[0].r as { order_id: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [r.order_id]);
    return r;
  });
  try {
    const line = (await sql<{ id: string }>("select id from public.order_lines where order_id = $1", [order.order_id]))[0].id;
    await asUser(USERS.office.email, (q) => q("select public.order_confirm_price($1, $2, $3::jsonb)", [order.order_id, `Agreed by phone (e2e ${id})`, JSON.stringify([{ line_id: line, unit_rate_cents: 9000 }])]));
    await signIn(page, "office");
    await page.goto(`/orders/${order.order_id}`);
    await expect(page.getByText(/^Prices locked when the order was confirmed \(corrected on .+ by Omar Office\)\.$/)).toBeVisible();
  } finally {
    await asUser(USERS.office.email, (q) => q("select public.set_order_status($1, 'canceled', 'e2e cleanup')", [order.order_id]));
  }
});

test("a dispatcher's order: tax lock says why, rates per load, cancel from the draft's edit page, own urgent flag, one schedule action", async ({ page }) => {
  const id = unique();
  let orderId: string | null = null;
  try {
    await signIn(page, "dispatcher");
    await page.goto("/orders/new");
    await page.getByRole("combobox", { name: "Customer" }).click();
    await page.keyboard.type("Lakeshore");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Add hauling / charge" }).click();
    const line = page.getByRole("listitem", { name: "Line 1" });
    await line.getByLabel("Charge").selectOption({ label: "Custom: Hauling / delivery" });
    await line.getByLabel("Description").fill(`Rush haul (e2e ${id})`);
    await line.getByLabel("Unit").selectOption({ label: "Loads" });
    await line.getByRole("textbox", { name: "Quantity" }).fill("2");
    // The unit in the singular; the greyed Taxable says why.
    await expect(line.getByLabel("Rate ($/load)")).toBeVisible();
    await line.getByLabel("Rate ($/load)").fill("95");
    await expect(line.getByRole("checkbox", { name: "Taxable" })).toBeDisabled();
    await expect(line.getByText("Tax comes from the customer's setting; the office changes it.")).toBeVisible();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}\/edit$/);
    orderId = page.url().split("/orders/")[1].split("/")[0];

    // A draft entered by mistake is canceled from its edit page; a reason is asked for in plain words.
    await page.getByRole("button", { name: "Cancel order" }).click();
    const d = page.getByRole("dialog");
    await expect(d.getByRole("button", { name: "Keep order" })).toBeVisible();
    await d.getByRole("button", { name: "Cancel order" }).click();
    await expect(d.getByText("Say why the order is canceled.")).toBeVisible();
    await d.getByRole("button", { name: "Keep order" }).click();
    await expect(d).toHaveCount(0);

    // Their own urgent flag: the next step is worded for them.
    await page.goto(`/orders/${orderId}`);
    await page.getByRole("button", { name: "Flag as urgent" }).click();
    const f = page.getByRole("dialog");
    await f.getByLabel("Why is it urgent?").fill(`Crew on site at 1 PM (e2e ${id})`);
    await f.getByRole("button", { name: "Flag as urgent" }).click();
    await expectToast(page, "Flagged urgent.");
    await expect(page.getByText(/^You flagged this; it is on the board for dispatch\./)).toBeVisible();

    // Confirmed without a date: one main action opens the schedule form; no "Set schedule" beside it.
    await page.getByRole("button", { name: "Confirm order" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm order" }).click();
    await expectToast(page, "Order marked confirmed.");
    await expect(page.getByRole("button", { name: "Mark scheduled" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set schedule" })).toHaveCount(0);
  } finally {
    if (orderId) await asUser(USERS.office.email, (q) => q("select public.set_order_status($1, 'canceled', 'e2e cleanup')", [orderId]));
  }
});

test("a draft is canceled from its edit page with a reason, and the person lands on the order", async ({ page }) => {
  const id = unique();
  const order = await asUser(USERS.dispatcher.email, async (q) => {
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE]);
    return (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: cust.rows[0].id, project_name: `Draft by mistake e2e ${id}`, site_line1: "1 Mistake Lane (test)", site_city: "Crown Point",
      lines: [{ kind: "other", calc_method: "per_unit", description: "Hauling (e2e)", unit_code: "load", quantity: "1", unit_rate_cents: 10000 }],
    })])).rows[0].r as { order_id: string };
  });
  await signIn(page, "dispatcher");
  await page.goto(`/orders/${order.order_id}/edit`);
  await page.getByRole("button", { name: "Cancel order" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Reason").fill(`Entered by mistake (e2e ${id})`);
  await d.getByRole("button", { name: "Cancel order" }).click();
  await expectToast(page, "Order marked canceled.");
  await expect(page).toHaveURL(new RegExp(`/orders/${order.order_id}$`));
  await expect(page.getByRole("list", { name: "Order history" }).getByText(`Entered by mistake (e2e ${id})`)).toBeVisible();
});

test("a certificate alert leads to the truck; Mark checked uses the app's dialog with certificate words", async ({ page }) => {
  const unit = `CA-${unique()}`.slice(0, 20);
  const truck = await asUser(USERS.owner.email, async (q) => {
    const t = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string;
    const wo = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: t, title: `Annual DOT inspection (e2e ${unit})`, category: "inspection" })])).rows[0].r.id as string;
    await q("select public.maintenance_set_status($1, 'in_progress', '')", [wo]);
    await q("select public.maintenance_set_status($1, 'completed', '')", [wo]);
    await q("select public.maintenance_record_inspection($1, $2::jsonb)", [wo, JSON.stringify({ inspected_on: plusDays(-1), expires_on: plusDays(360), inspector: "Pat Inspector (e2e)" })]);
    return t;
  });

  await signIn(page, "office");
  await page.goto("/communications/alerts");
  await page.getByRole("link", { name: `Check the inspection certificate of truck ${unit}`, exact: true }).click();
  const open = page.getByRole("link", { name: `Open truck ${unit} to check it` });
  await expect(open).toBeVisible();
  // Acknowledging stays possible, as the quieter action: it does not resolve the alert.
  await expect(page.getByRole("button", { name: "Acknowledge" })).toBeVisible();
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/fleet/trucks/${truck}`));

  let nativeDialog = false;
  page.on("dialog", (dl) => { nativeDialog = true; void dl.dismiss(); });
  await page.getByRole("button", { name: "Mark checked" }).click();
  const d = page.getByRole("dialog");
  await expect(d.getByText("Mark the inspection certificate checked?")).toBeVisible();
  await expect(d).toContainText("Compare it with the paper certificate first");
  await expect(d).not.toContainText("insurance or registration");
  await d.getByRole("button", { name: "Mark checked" }).click();
  await expectToast(page, "Certificate checked.");
  expect(nativeDialog).toBe(false);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // A timer left running by another test on the shared mechanic would stop "Start this job" from starting one here.
  const stopMechanicTimers = () => sql("update public.work_order_time_entries set ended_at = now() where ended_at is null and user_id = (select id from public.profiles where email = $1)", [USERS.mechanic.email]);
  test.beforeEach(stopMechanicTimers);
  test.afterEach(stopMechanicTimers);

  test("the mechanic finishes the last job on a parked truck: asked to put it back, from the toast and from My jobs", async ({ page }) => {
    const unit = `PK2-${unique()}`.slice(0, 20);
    const title = `Mirror bracket (e2e ${unit})`;
    await asUser(USERS.owner.email, async (q) => {
      const t = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string;
      await q("select public.set_equipment_service_status('truck', $1, 'out_of_service', 'Mirror broken (e2e)', null)", [t]);
      const wo = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: t, title, category: "body" })])).rows[0].r.id as string;
      await q("select public.maintenance_set_status($1, 'triaged')", [wo]);
      await mechanicLeads(q, wo);
    });
    await signIn(page, "mechanic");
    await page.goto("/maintenance/my-jobs");
    const mine = page.getByRole("listitem").filter({ hasText: title }).filter({ hasText: "You lead this job" });
    await mine.getByRole("button", { name: "Start this job" }).click();
    await expectToast(page, "Job started. Your timer is running.");
    await mine.getByRole("button", { name: "Finish the job" }).click();
    await mine.getByLabel("What did you fix?").fill("Replaced the mirror bracket");
    await mine.getByRole("button", { name: "Mark completed" }).click();
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: `Job completed. Truck ${unit} is still parked. Put it back in service?` });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole("button", { name: "Put back in service" })).toBeVisible();
    // The same question on My jobs, with the button there.
    const prompt = page.getByTestId("back-from-shop").locator("div").filter({ hasText: `Truck ${unit} is still parked. Put it back in service?` }).first();
    await expect(prompt).toBeVisible();
    await page.getByRole("button", { name: `Put truck ${unit} back in service` }).click();
    await expectToast(page, `Truck ${unit} is back in service and can be assigned.`);
    const status = await sql<{ service_status: string }>("select service_status from public.trucks where unit_number = $1", [unit]);
    expect(status[0].service_status).toBe("in_service");
  });

  test("a part on order for a job not started says the truck keeps running; totals say Parts used", async ({ page }) => {
    const unit = `PO2-${unique()}`.slice(0, 20);
    const wo = await asUser(USERS.owner.email, async (q) => {
      const t = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string;
      return (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: t, title: `Seat torn (e2e ${unit})` })])).rows[0].r.id as string;
    });
    await signIn(page, "mechanic");
    await page.goto(`/maintenance/work-orders/${wo}?tab=order`);
    await expect(page.getByLabel("Work order totals").getByText("Parts used", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add a part on order" }).click();
    await page.getByLabel("Which part?").fill("Seat cushion (e2e)");
    await page.getByRole("button", { name: "Save part on order" }).click();
    await expectToast(page, `Part on order saved. Truck ${unit} keeps running until you start the job.`);
  });

  test("an inspection job: a hint while it runs, and the finish form asks what was inspected or fixed", async ({ page }) => {
    const unit = `IN-${unique()}`.slice(0, 20);
    const wo = await asUser(USERS.owner.email, async (q) => {
      const t = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string;
      const w = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: t, title: `Annual inspection (e2e ${unit})`, category: "inspection" })])).rows[0].r.id as string;
      await q("select public.maintenance_set_status($1, 'triaged')", [w]);
      await mechanicLeads(q, w);
      return w;
    });
    await signIn(page, "mechanic");
    await page.goto("/maintenance/my-jobs");
    const mine = page.getByRole("listitem").filter({ hasText: `Annual inspection (e2e ${unit})` }).filter({ hasText: "You lead this job" });
    await mine.getByRole("button", { name: "Start this job" }).click();
    await expectToast(page, "Job started. Your timer is running.");
    await mine.getByRole("button", { name: "Finish the job" }).click();
    await expect(mine.getByLabel("What did you inspect or fix?")).toBeVisible();
    await page.goto(`/maintenance/work-orders/${wo}`);
    await expect(page.getByTestId("inspection-hint")).toHaveText("When it passes, finish the job to record the certificate.");
  });
});

test("People → a driver's sign-in card offers the sign-in QR code, with the same rules as the driver's Fleet page", async ({ page }) => {
  const name = `E2E QR Person ${unique()}`;
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const username = `e2e-qr-${unique()}${Math.floor(Math.random() * 1000)}`;
  const { data, error } = await admin.auth.admin.createUser({ email: `${username}@users.mytaviron.com`, password: `Pw-${unique()}-${unique()}!`, email_confirm: true, user_metadata: { full_name: name } });
  if (error || !data.user) throw new Error(`could not create the test sign-in: ${error?.message}`);
  const user = data.user.id;
  try {
    await sql("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'driver', true)", [TOP_LINE, user]);
    const [driver] = await sql<{ id: string }>("insert into public.drivers (company_id, name, user_id) values ($1, $2, $3) returning id", [TOP_LINE, name, user]);
    // The membership already made their People record; link it to the driver record.
    const [person] = await sql<{ id: string }>("update public.employees set driver_id = $2 where user_id = $1 and company_id = $3 returning id", [user, driver.id, TOP_LINE]);
    await signIn(page, "owner");
    await page.goto(`/employees/${person.id}`);
    const card = page.getByTestId("person-signin-qr");
    await card.getByTestId("show-sign-in-qr").click();
    await expect(page.getByTestId("sign-in-qr")).toBeVisible();
  } finally {
    await sql("update public.drivers set active = false where user_id = $1", [user]);
    await sql("update public.company_memberships set active = false where user_id = $1", [user]);
  }
});

test("Settings → Security names who must use two-step verification: the roles with money access and their people", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/settings?tab=security");
  const who = page.getByTestId("mfa-who");
  // The roles with their head count; the people themselves are listed below with their state (SEC4b, mfa-status.spec.ts).
  await expect(who.getByRole("listitem", { name: "Office staff" })).toContainText(/\d+ (person|people)/);
  await expect(who.getByRole("listitem", { name: "Owner / Administrator" })).toBeVisible();
  await expect(page.getByTestId("mfa-set-up").getByRole("listitem", { name: USERS.office.name })).toContainText("Must use it: money access");
  await expect(page.getByText("for everyone in this company", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Also require two-step verification for everyone else in this company" })).toBeVisible();
});

/** The first option of a combobox list whose text matches. */
async function optionText(list: Locator, text: string) {
  return list.getByRole("option").filter({ hasText: text }).first();
}

test("the order form marks a customer on credit hold in the customer list", async ({ page }) => {
  const id = unique();
  const name = `Held Picker Co ${id} (test)`;
  await asUser(USERS.owner.email, async (q) => {
    const c = (await q("insert into public.customers (name, customer_number) values ($1, $2) returning id", [name, `HPC${id}`.slice(0, 20)])).rows[0].id as string;
    await q("select public.set_customer_credit_hold($1, true, $2)", [c, "Late invoices (test)"]);
  });
  await signIn(page, "dispatcher");
  await page.goto("/orders/new");
  await page.getByRole("combobox", { name: "Customer" }).click();
  await page.keyboard.type(`Held Picker Co ${id}`);
  const opt = await optionText(page.getByRole("listbox"), name);
  await expect(opt).toContainText("on credit hold");
});
