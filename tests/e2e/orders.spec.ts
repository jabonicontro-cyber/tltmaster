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
  expect(orderNumber).toMatch(/^O-\d{4}-\d{4}$/);
  await expect(page.getByText("Direct order", { exact: true })).toBeVisible();
  await expect(page.getByText("Draft — not confirmed yet")).toBeVisible();
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

test("dispatchers cannot create orders", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/orders");
  await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "New order" })).toHaveCount(0);
  await page.goto("/orders/new");
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
});
