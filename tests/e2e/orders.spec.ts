import { expect, test } from "@playwright/test";
import { expectToast, signIn } from "./helpers";

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

  // The phoned-in order: saved, confirmed by the dispatcher who entered it, ready to schedule. No cancel button.
  await page.getByRole("combobox", { name: "Customer" }).click();
  await page.keyboard.type("Lakeshore");
  await page.keyboard.press("Enter");
  await page.getByLabel("Job site / delivery address").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Add material" }).click();
  await page.getByRole("listitem", { name: "Line 1" }).getByLabel("Material").selectOption({ label: "Gravel #53 limestone" });
  await page.getByRole("listitem", { name: "Line 1" }).getByLabel("Quantity").fill("8");
  await page.getByRole("button", { name: "Save & review" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("link", { name: "Edit draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Cancel/ })).toHaveCount(0);
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
