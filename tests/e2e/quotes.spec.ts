import { expect, test } from "@playwright/test";
import { expectToast, signIn } from "./helpers";

test("create, price, save, preview, PDF, mark sent, revise and accept a quote", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/quotes/new");

  await page.getByRole("combobox", { name: "Customer" }).click();
  await page.keyboard.type("Lakeshore");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Contact name")).toHaveValue("Pat Morgan");
  await page.getByLabel("Job site / delivery address").selectOption({ index: 1 });
  await page.getByLabel("Customer PO").fill("PO-E2E-1");

  // Customer-specific rate ($9.00) is used before the standard rate ($10.00).
  await page.getByRole("button", { name: "Add material" }).click();
  await page.getByRole("listitem", { name: "Line 1" }).getByLabel("Material").selectOption({ label: "Gravel #53 limestone" });
  await page.getByRole("listitem", { name: "Line 1" }).getByLabel("Quantity").fill("20");
  await expect(page.getByRole("listitem", { name: "Line 1" }).getByLabel(/Rate/)).toHaveValue("9.00");
  await expect(page.getByRole("listitem", { name: "Line 1" }).getByText("Customer rate")).toBeVisible();

  await page.getByRole("button", { name: "Add hauling / charge" }).click();
  await page.getByRole("listitem", { name: "Line 2" }).getByLabel("Charge").selectOption({ label: "Hauling per ton" });
  await expect(page.getByRole("listitem", { name: "Line 2" }).getByLabel("Quantity")).toHaveValue("20");

  // Office staff cannot override a configured rate.
  await page.getByRole("listitem", { name: "Line 2" }).getByLabel(/Rate/).fill("4.50");
  await expect(page.getByText("Owner approval needed")).toBeVisible();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "override pricing" })).toBeVisible();
  await page.getByRole("listitem", { name: "Line 2" }).getByLabel(/Rate/).fill("5.00");

  // 20 × 9.00 = 180.00 (taxable) + 20 × 5.00 = 100.00; 7% tax on 180 = 12.60 → 292.60
  await page.getByLabel("Sales tax %").fill("7");
  await expect(page.getByText("Total $292.60")).toBeVisible();
  await page.getByRole("button", { name: "Save & review" }).click();
  await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}$/);
  const quoteUrl = page.url();
  await expect(page.getByRole("heading", { name: /^Q-\d{4}-\d{4}$/ })).toBeVisible();
  await expect(page.getByText("$292.60").first()).toBeVisible();

  // PDF
  const pdfHref = await page.getByRole("link", { name: "PDF", exact: true }).first().getAttribute("href");
  const pdf = await page.request.get(pdfHref!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // Print preview
  await page.getByRole("link", { name: "Preview / print" }).click();
  await expect(page.getByText("Draft — not yet sent to the customer")).toBeVisible();
  await expect(page.getByText("PO-E2E-1")).toBeVisible();
  await page.goto(quoteUrl);

  // Email in preview mode does not mark the quote sent.
  await page.getByRole("button", { name: "Email quote" }).click();
  await expect(page.getByLabel("Subject")).not.toHaveValue("");
  await page.getByRole("button", { name: "Preview email" }).click();
  await expect(page.getByText("Preview only — nothing was sent")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

  // Mark sent manually → locked
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await page.getByLabel("How was it delivered?").fill("Emailed from Outlook");
  await page.getByRole("dialog").getByRole("button", { name: "Mark as sent" }).click();
  await expectToast(page, "Quote marked as sent.");
  await expect(page.getByRole("link", { name: "Edit draft" })).toHaveCount(0);

  // Revise → revision 2 editable; revision 1 kept
  await page.getByRole("button", { name: "Revise" }).click();
  await page.getByLabel("Reason for the revision").fill("More stone");
  await page.getByRole("button", { name: "Create revision" }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole("listitem", { name: "Line 1" }).getByLabel("Quantity").fill("30");
  await page.getByRole("button", { name: "Save & review" }).click();
  await expect(page).toHaveURL(quoteUrl);
  await expect(page.getByText("Revision 2 in progress")).toBeVisible();
  await expect(page.getByRole("link", { name: "Revision 1" }).first()).toBeVisible();

  // Send revision 2, then accept
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await page.getByLabel("How was it delivered?").fill("Handed over");
  await page.getByRole("dialog").getByRole("button", { name: "Mark as sent" }).click();
  await expectToast(page, "Quote marked as sent.");
  await page.getByRole("button", { name: "Mark accepted" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark accepted" }).click();
  await expectToast(page, "Quote marked accepted.");
  await expect(page.getByText("Accepted", { exact: true }).first()).toBeVisible();

  // Convert to order
  await page.getByRole("button", { name: "Convert to order" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create order" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  const orderUrl = page.url();
  const orderNumber = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();
  expect(orderNumber).toMatch(/^O-\d{4}-\d{4}$/);
  await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("PO-E2E-1")).toBeVisible();
  // Revision 2: 30 t × $9.00 = $270.00 (+7% tax $18.90) + 20 t hauling × $5.00 = $100.00 → $388.90
  await expect(page.getByText("$388.90").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "2", exact: true })).toBeVisible(); // source revision link

  // The quote now links to its order instead of offering conversion again.
  await page.goto(quoteUrl);
  await expect(page.getByRole("button", { name: "Convert to order" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel quote" })).toHaveCount(0);
  await page.getByRole("link", { name: `Order ${orderNumber}` }).first().click();
  await expect(page).toHaveURL(orderUrl);

  await page.goto(`/orders?q=${orderNumber}`);
  await expect(page.getByRole("link", { name: orderNumber })).toBeVisible();
});

test("dispatchers can view orders but cannot convert quotes", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/orders");
  const first = page.locator("tbody a[href^='/orders/']").first();
  await expect(first).toBeVisible();
  await page.goto("/quotes?status=accepted");
  await page.locator("tbody a[href^='/quotes/']").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Convert to order" })).toHaveCount(0);
});
