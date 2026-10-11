import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// A second company must not see or reach any Top Line record through pages,
// server actions or the PDF route.
test("another company sees none of Top Line's records and cannot open them by URL", async ({ page, browser }) => {
  // Find a Top Line quote and customer as a Top Line user.
  const tl = await browser.newPage();
  await signIn(tl, "office");
  await tl.goto("/customers");
  const customerHref = await tl.locator("tbody a[href^='/customers/']").first().getAttribute("href");
  await tl.goto("/quotes");
  const quoteHref = await tl.locator("tbody a[href^='/quotes/']").first().getAttribute("href");
  expect(customerHref).toBeTruthy();
  expect(quoteHref).toBeTruthy();
  await tl.goto(quoteHref!);
  const pdfHref = await tl.getByRole("link", { name: "PDF", exact: true }).first().getAttribute("href");
  expect((await tl.request.get(pdfHref!)).status()).toBe(200);
  await tl.close();

  await signIn(page, "otherOwner");
  await expect(page.getByRole("link", { name: "Brookside Aggregates (e2e test) — home" }).first()).toBeVisible(); // the workspace shows its own company

  await page.goto("/customers");
  await expect(page.locator("tbody a[href^='/customers/']")).toHaveCount(0);
  await page.goto("/quotes");
  await expect(page.locator("tbody a[href^='/quotes/']")).toHaveCount(0);
  await page.goto("/materials");
  await expect(page.getByText("Gravel #53 limestone")).toHaveCount(0);

  await page.goto(customerHref!);
  await expect(page.getByText("Not found", { exact: true })).toBeVisible();
  await page.goto(quoteHref!);
  await expect(page.getByText("Not found", { exact: true })).toBeVisible();
  expect((await page.request.get(pdfHref!)).status()).toBe(404);

  // Settings show this company's own details only.
  await page.goto("/settings?tab=company");
  await expect(page.getByLabel("Company name")).toHaveValue("Brookside Aggregates (e2e test)");
  await page.goto("/settings?tab=users");
  await expect(page.getByText("e2e-office@toplinetest.example")).toHaveCount(0);
  await expect(page.getByText("e2e-brookside-owner@brooksidetest.example")).toBeVisible();
});
