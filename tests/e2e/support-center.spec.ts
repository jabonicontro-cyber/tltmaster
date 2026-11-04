import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers";

// Support center (B138): the office opens a case for a customer from a phone call, writes an internal note, replies
// and closes it; the reply target can be set; the list filters by status.
test("the office opens, notes, answers and closes a support case", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/support");
  await expect(page.getByRole("heading", { name: "Support" })).toBeVisible();

  await page.getByRole("link", { name: "New case" }).click();
  await page.getByRole("combobox", { name: /^Customer/ }).selectOption({ label: "Prairie View Landscaping" });
  await page.waitForURL(/customer=/);
  const subject = `Wrong stone delivered ${unique()}`;
  await page.getByLabel("What it is about").selectOption({ label: "Wrong material or quantity" });
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Message to the customer").fill("We are sending the right stone this afternoon at no charge.");
  await page.getByRole("button", { name: "Open case" }).click();
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
  await expect(page.getByText(/opened .* by the office/)).toBeVisible();

  await page.getByRole("radio", { name: "Internal note" }).click();
  await page.getByLabel(/^Note/).fill("Plant loaded bin 4 instead of bin 3 (test)");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText("Internal note ·").first()).toBeVisible();

  await page.getByRole("radio", { name: "Reply to customer" }).click();
  await page.getByLabel("Reply", { exact: true }).fill("The replacement load is on its way.");
  await page.getByRole("button", { name: "Send and close" }).click();
  await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();

  await page.goto("/support?filter=closed");
  await expect(page.getByRole("link", { name: subject })).toBeVisible();
  await page.goto("/support?filter=open");
  await expect(page.getByRole("link", { name: subject })).toHaveCount(0);

  // The first-reply target (settings.manage): set, then turned off again.
  await page.getByLabel("Hours").fill("4");
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(page.getByText("Reply target saved.")).toBeVisible();
  await expect(page.getByText(/without a first reply after 4 hours/)).toBeVisible();
  await page.getByLabel("Hours").fill("");
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(page.getByText(/^Off\./)).toBeVisible();
});

test("people without customer access cannot open the support center", async ({ page }) => {
  await signIn(page, "driver");
  await page.goto("/support");
  await expect(page.getByRole("heading", { name: "Support" })).toHaveCount(0);
});
