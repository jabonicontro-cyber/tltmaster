import { expect, test } from "@playwright/test";
import pg from "pg";
import { unique, signInPlatform } from "./helpers";


// Platform admin: classify, archive, restore and permanently delete a practice company (20261120000500). The test
// creates its own company; no existing company is touched.

async function settings(value: "true" | "false") {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    await c.query("insert into private.platform_settings (key, value) values ('company_delete_enabled', $1) on conflict (key) do update set value = excluded.value", [value]);
  } finally {
    await c.end();
  }
}

test.afterEach(async () => settings("false"));

test("a practice company is archived (hidden by default), restored, archived again and deleted with its name typed", async ({ page }) => {
  test.slow();
  await signInPlatform(page);
  await expect(page).toHaveURL(/\/admin$|\/command-center/);

  const name = `Practice Hauling ${unique()}`;
  await page.goto("/admin/onboarding");
  await page.getByLabel("Company name").fill(name);
  await page.getByRole("button", { name: "Create company" }).click();
  await page.waitForURL(/\/admin\/onboarding\/[0-9a-f-]{36}\?created=1/);
  const id = page.url().match(/onboarding\/([0-9a-f-]{36})/)![1];

  await page.goto(`/admin/companies/${id}`);
  const box = page.getByRole("region", { name: "Classification and archive" });
  // A new company is a production customer until someone says otherwise; deletion is not offered.
  await expect(box.getByLabel("Classification")).toHaveValue("production");
  await expect(box.getByText(/Permanent delete is turned off/)).toBeVisible();
  await settings("true");
  await page.reload();
  await expect(box.getByText(/Only an archived company classified as Practice/)).toBeVisible();
  await settings("false");
  await page.reload();
  await box.getByLabel("Classification").selectOption("practice");
  await box.getByRole("button", { name: "Save Classification" }).click();
  await expect(page.getByText("Classification saved.")).toBeVisible();

  await box.getByLabel("Reason").fill("Training company");
  await box.getByLabel(/I understand its people lose access/).check();
  await box.getByRole("button", { name: "Archive Company" }).click();
  await expect(page.getByText(/Company archived/)).toBeVisible();

  // Hidden from the default directory, listed under Only archived.
  await page.goto(`/admin/companies?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("link", { name })).toHaveCount(0);
  await page.goto(`/admin/companies?q=${encodeURIComponent(name)}&archived=only`);
  await expect(page.getByRole("row").filter({ hasText: name })).toContainText("Archived");

  // Restore, then archive again.
  await page.goto(`/admin/companies/${id}`);
  await box.getByRole("button", { name: "Restore Company" }).click();
  await expect(page.getByText("Company restored.")).toBeVisible();
  await box.getByLabel("Reason").fill("Training company");
  await box.getByLabel(/I understand its people lose access/).check();
  await box.getByRole("button", { name: "Archive Company" }).click();
  await expect(page.getByText(/Company archived/)).toBeVisible();

  // Permanent delete is off until the platform owner enables it with SQL: no delete form.
  await expect(box.getByText(/Permanent delete is turned off/)).toBeVisible();
  await expect(box.getByRole("button", { name: "Delete Permanently" })).toHaveCount(0);
  await settings("true");
  await page.reload();

  // Delete: shows what is removed; the wrong name is refused; the right one deletes.
  await expect(box.getByText("This cannot be undone")).toBeVisible();
  await box.getByLabel(/Type the company name/).fill("not the name");
  await box.getByRole("button", { name: "Delete Permanently" }).click();
  await expect(page.getByText("Type the company name exactly to confirm.")).toBeVisible();
  await box.getByLabel(/Type the company name/).fill(name);
  await box.getByRole("button", { name: "Delete Permanently" }).click();
  await expect(page).toHaveURL(/\/admin\/companies\?deleted=\d+/);
  await expect(page.getByText("Company permanently deleted")).toBeVisible();
  await page.goto(`/admin/companies?q=${encodeURIComponent(name)}&archived=include`);
  await expect(page.getByRole("link", { name })).toHaveCount(0);
});
