import { expect, test, type Page } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

function plusDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("create a direct order, confirm it, schedule it and take it through delivery", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/orders");
  await page.getByRole("link", { name: "New order" }).first().click();
  await expect(page).toHaveURL(/\/orders\/new$/);

  await page.getByRole("combobox", { name: "Customer" }).click();
  await page.keyboard.type("Lakeshore");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Contact name")).toHaveValue("Pat Morgan");
  await page.getByLabel("Job site / delivery address").selectOption({ index: 1 });
  await page.getByLabel("Customer PO").fill("PO-E2E-DIRECT");
  const orderDate = await page.getByLabel("Order date").inputValue();
  await page.getByLabel("Requested delivery").fill(plusDays(orderDate, 3));

  await page.getByRole("button", { name: "Add material" }).click();
  await page.getByRole("listitem", { name: "Line 1" }).getByLabel("Material").selectOption({ label: "Gravel #53 limestone" });
  await page.getByRole("listitem", { name: "Line 1" }).getByLabel("Quantity").fill("12");
  await expect(page.getByRole("listitem", { name: "Line 1" }).getByLabel(/Rate/)).toHaveValue("9.00");
  await page.getByRole("button", { name: "Add hauling / charge" }).click();
  await page.getByRole("listitem", { name: "Line 2" }).getByLabel("Charge").selectOption({ label: "Hauling per ton" });
  await page.getByLabel("Sales tax %").fill("7");
  // 12 × 9.00 = 108.00 (taxable, 7% = 7.56) + 12 × 5.00 = 60.00 → 175.56
  await expect(page.getByText("Total $175.56")).toBeVisible();
  await page.getByRole("button", { name: "Save & review" }).click();

  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  const orderUrl = page.url();
  const orderNumber = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();
  expect(orderNumber).toMatch(/^ORD-\d{4,}$/);
  await expect(page.getByText("Direct order", { exact: true })).toBeVisible();
  await expect(page.getByText("Draft: not confirmed yet")).toBeVisible();
  await expect(page.getByText("$175.56").first()).toBeVisible();
  await expect(page.getByText("PO-E2E-DIRECT", { exact: true })).toBeVisible();

  // Confirm → lines locked, details still editable.
  await page.getByRole("button", { name: "Confirm order" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm order" }).click();
  await expectToast(page, "Order marked confirmed.");
  await expect(page.getByRole("link", { name: "Edit draft" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Edit details" })).toBeVisible();

  // Scheduling without a date opens the schedule form first.
  await page.getByRole("button", { name: "Mark scheduled" }).click();
  await page.getByLabel("Delivery date").fill(plusDays(orderDate, 2));
  await page.getByLabel("Window from").fill("07:00");
  await page.getByLabel("Window to").fill("11:30");
  await page.getByLabel("Scheduling notes").fill("Call foreman on arrival");
  await page.getByRole("dialog").getByRole("button", { name: /^Save and mark scheduled$/ }).click();
  await expectToast(page, "Order marked scheduled.");
  await expect(page.getByText("7:00 AM – 11:30 AM")).toBeVisible();

  // Clicked in quick succession on purpose: each step must use the latest edit counter.
  for (const [button, toast] of [
    ["Mark dispatched", "Order marked dispatched."],
    ["Start work", "Order marked in progress."],
    ["Mark completed", "Order marked completed."],
  ] as const) {
    await page.getByRole("button", { name: button }).click();
    await page.getByRole("dialog").getByRole("button", { name: button }).click();
    await expectToast(page, toast);
  }
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
  // Final: no more actions or edits.
  await expect(page.getByRole("link", { name: "Edit details" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change schedule" })).toHaveCount(0);

  const history = page.getByRole("list", { name: "Order history" });
  await expect(history.getByText("Draft → Confirmed")).toBeVisible();
  await expect(history.getByText("In progress → Completed")).toBeVisible();
  await expect(history.getByText(/schedule changed/)).toBeVisible();

  // Listed with its status and source; quick filters work.
  await page.goto(`/orders?q=${orderNumber}`);
  const row = page.getByRole("row").filter({ hasText: orderNumber });
  await expect(row.getByText("Direct", { exact: true })).toBeVisible();
  await expect(row.getByText("Completed", { exact: true })).toBeVisible();
  await page.goto("/orders?source=direct&status=completed");
  await expect(page.getByRole("link", { name: orderNumber })).toBeVisible();
  await page.goto("/orders?status=open");
  await expect(page.getByRole("link", { name: orderNumber })).toHaveCount(0);
  await page.goto(orderUrl);
});

/** A small direct order for Lakeshore on the new-order page (customer, saved site, one material line). */
async function fillPhonedInOrder(page: Page, quantity = "8") {
  await page.getByRole("combobox", { name: "Customer" }).click();
  await page.keyboard.type("Lakeshore");
  await page.keyboard.press("Enter");
  await page.getByLabel("Job site / delivery address").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Add material" }).click();
  await page.getByRole("listitem", { name: "Line 1" }).getByLabel("Material").selectOption({ label: "Gravel #53 limestone" });
  await page.getByRole("listitem", { name: "Line 1" }).getByLabel("Quantity").fill(quantity);
}

// Owner decision 2026-11-09 (migration 20261120009900): dispatchers take phoned-in orders, from Orders and from the
// dispatch board for the day shown there, with the narrow orders.create permission: they finish and confirm their own
// new order, then schedule it; canceling and changing other orders stay with orders.edit.
test("dispatchers create orders from Orders and from the board; others are told who can, in plain words", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/orders");
  await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "New order" }).first()).toBeVisible();

  const day = plusDays(new Date().toISOString().slice(0, 10), 2);
  await page.goto(`/dispatch?date=${day}`);
  const fromBoard = page.getByRole("link", { name: "New order" });
  await expect(fromBoard).toHaveAttribute("href", `/orders/new?date=${day}`);
  await fromBoard.click();
  await expect(page.getByRole("heading", { name: "New order", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Requested delivery")).toHaveValue(day);
  await expect(page.getByRole("button", { name: "Save draft" })).toBeVisible();

  // The phoned-in order: saved, confirmed by the dispatcher who entered it, ready to schedule. While it is their draft
  // they may also cancel it (MD1, 20261120016000); once confirmed, canceling is the office's.
  await fillPhonedInOrder(page);
  await page.getByRole("button", { name: "Save & review" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("link", { name: "Edit draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel order" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm order" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm order" }).click();
  await expectToast(page, "Order marked confirmed.");
  await expect(page.getByRole("button", { name: "Mark scheduled" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit details" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Cancel/ })).toHaveCount(0);

  // A role without it: the page names the activity and the roles that have it, never the permission code.
  await signIn(page, "mechanic");
  await page.goto("/orders/new");
  await expect(page.getByRole("heading", { name: "You do not have access to that page" })).toBeVisible();
  await expect(page.getByText(/Creating new orders is not part of your role\. Here it is part of the .*Dispatcher.* roles?: ask one of them/)).toBeVisible();
  await expect(page.getByText("orders.create")).toHaveCount(0);
});

// Owner decision 2026-11-09 (MD1, migration 20261120016000): with orders.create a dispatcher cancels a draft they
// entered themselves, and flags their own direct order urgent (draft or confirmed). Someone else's order keeps those
// for people who can change orders: the buttons are not shown.
test("dispatchers cancel their own draft and flag their own order urgent; other people's orders do not offer either", async ({ page }) => {
  const id = unique();
  // Someone else's draft: the office's, through the app's own database function.
  const theirs = await asUser(USERS.office.email, async (q) => {
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, project_name: `Office draft e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "10", unit_rate_cents: 1000 }],
    })]);
    return r.rows[0].r as { order_id: string; order_number: string };
  });
  let flagged: string | null = null;
  try {
    await signIn(page, "dispatcher");

    // Their own draft, entered by mistake: canceled with a reason, kept in the history.
    await page.goto("/orders/new");
    await fillPhonedInOrder(page, "5");
    await page.getByRole("button", { name: "Save & review" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
    await page.getByRole("button", { name: "Cancel order" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Reason").fill(`Customer called back: entered twice (e2e ${id})`);
    await d.getByRole("button", { name: "Cancel order" }).click();
    await expectToast(page, "Order marked canceled.");
    const history = page.getByRole("list", { name: "Order history" });
    await expect(history.getByText("Draft → Canceled")).toBeVisible();
    await expect(history.getByText(`Customer called back: entered twice (e2e ${id})`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Flag as urgent" })).toHaveCount(0);

    // Their own phoned-in order: flagged urgent while a draft, still theirs to update once confirmed.
    await page.goto("/orders/new");
    await fillPhonedInOrder(page, "6");
    await page.getByRole("button", { name: "Save & review" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
    flagged = page.url().split("/orders/")[1];
    await page.getByRole("button", { name: "Flag as urgent" }).click();
    const f = page.getByRole("dialog");
    await f.getByLabel("Why is it urgent?").fill(`Customer needs it before noon (e2e ${id})`);
    await f.getByRole("button", { name: "Flag as urgent" }).click();
    await expectToast(page, "Flagged urgent.");
    await expect(page.getByText("Awaiting acknowledgement").first()).toBeVisible();
    await page.getByRole("button", { name: "Confirm order" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm order" }).click();
    await expectToast(page, "Order marked confirmed.");
    await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
    await page.getByRole("button", { name: "Edit reason or deadline" }).click();
    const e = page.getByRole("dialog");
    await e.getByLabel("Why is it urgent?").fill(`Customer needs it before 11 (e2e ${id})`);
    await e.getByRole("button", { name: "Save" }).click();
    await expectToast(page, "Urgent flag updated.");

    // The office's draft: no cancel, no confirm, no urgent flag for the dispatcher.
    await page.goto(`/orders/${theirs.order_id}`);
    await expect(page.getByRole("heading", { name: theirs.order_number, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Confirm order" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Flag as urgent" })).toHaveCount(0);
  } finally {
    // Cleanup the way the office would: cancel both (canceling also closes the urgent flag).
    await asUser(USERS.office.email, async (q) => {
      for (const orderId of [theirs.order_id, flagged]) {
        if (orderId) await q("select public.set_order_status($1, 'canceled', 'e2e cleanup')", [orderId]);
      }
    });
  }
});

// Financial review M1 (owner decision 2026-11-10, migration 20261120016100): a dispatcher may type a price on a line
// that has no price-list rate so an urgent job is not held up, but cannot change the tax; the order says "Price to be
// checked" and is not billed until someone with pricing or billing rights (the office) confirms the price, recorded in
// the order's history.
test("a price a dispatcher types is shown as to be checked, and the office confirms it", async ({ page, browser }) => {
  const id = unique();
  let orderId: string | null = null;
  try {
    await signIn(page, "dispatcher");
    await page.goto("/orders/new");
    await fillPhonedInOrder(page, "6");
    // Tax follows the customer and the company setting.
    await expect(page.getByLabel("Sales tax %")).toBeDisabled();
    await expect(page.getByText("Sales tax follows the customer and the company setting.")).toBeVisible();
    await expect(page.getByRole("listitem", { name: "Line 1" }).getByRole("checkbox", { name: "Taxable" })).toBeDisabled();
    // A rush haul without any price-list rate: the dispatcher types the price.
    await page.getByRole("button", { name: "Add hauling / charge" }).click();
    const line = page.getByRole("listitem", { name: "Line 2" });
    await line.getByLabel("Charge").selectOption({ label: "Custom: Hauling / delivery" });
    await line.getByLabel("Description").fill(`Rush haul, same day (e2e ${id})`);
    await line.getByLabel("Unit").selectOption({ index: 1 });
    await line.getByRole("textbox", { name: "Quantity" }).fill("6");
    await line.getByLabel(/^Rate/).fill("95");
    await expect(line.getByText("No price-list rate: type the price. The office checks it before billing.")).toBeVisible();
    await page.getByRole("button", { name: "Save & review" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
    orderId = page.url().split("/orders/")[1];
    const notice = page.getByText("Price to be checked", { exact: true });
    await expect(notice).toBeVisible();
    await expect(page.getByRole("list", { name: "Typed prices" }).getByText(`Line 2, Rush haul, same day (e2e ${id}): $95.00 per`)).toBeVisible();
    // The dispatcher cannot confirm it; the job is not held up (they confirm the order itself).
    await expect(page.getByRole("button", { name: "Confirm price" })).toHaveCount(0);
    await page.getByRole("button", { name: "Confirm order" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm order" }).click();
    await expectToast(page, "Order marked confirmed.");
    await expect(notice).toBeVisible();

    // The office (billing) corrects the typed price while confirming it (owner 2026-11-10, 20261120016400): a reason is
    // required; the old and new prices are recorded in the order's history; the notice says who checked it.
    const officeContext = await browser.newContext();
    const office = await officeContext.newPage();
    await signIn(office, "office");
    await office.goto(`/orders/${orderId}`);
    await expect(office.getByText("Price to be checked", { exact: true })).toBeVisible();
    await office.getByRole("button", { name: "Confirm price" }).click();
    const d = office.getByRole("dialog");
    const price = d.getByLabel(`Line 2, Rush haul, same day (e2e ${id}): price per`, { exact: false });
    await expect(price).toHaveValue("95.00");
    await price.fill("88");
    await d.getByRole("button", { name: "Correct and confirm" }).click();
    await expect(d.getByText("Say why the price is corrected.")).toBeVisible();
    await d.getByLabel("Why is the price corrected?").fill(`Customer agreed $88 for the rush haul (e2e ${id})`);
    await d.getByRole("button", { name: "Correct and confirm" }).click();
    await expectToast(office, "Price corrected and confirmed. Billing can go ahead once the loads are delivered.");
    await expect(office.getByText(/corrected and confirmed the typed price on/)).toBeVisible();
    await expect(office.getByText("Price checked", { exact: true })).toBeVisible();
    await expect(office.getByText("Price to be checked", { exact: true })).toHaveCount(0);
    const history = office.getByRole("list", { name: "Order history" });
    await expect(history.getByText(/typed price corrected \(line 2 from \$95\.00 to \$88\.00\): Customer agreed \$88 for the rush haul/)).toBeVisible();
    await expect(history.getByText(/typed price checked and confirmed: Customer agreed \$88 for the rush haul/)).toBeVisible();
    await officeContext.close();
  } finally {
    if (orderId) await asUser(USERS.office.email, (q) => q("select public.set_order_status($1, 'canceled', 'e2e cleanup')", [orderId]));
  }
});
