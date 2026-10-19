import { expect, test } from "@playwright/test";
import { signIn, unique, signInPlatform } from "./helpers";


// Help Center (B65): contextual help in the header, search, article feedback, a guided how-to that only highlights,
// role-based visibility, and a support request the person reviews before sending.

test("the Help button shows this page's articles, searches, and opens the Help Center", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/customers");
  await page.getByRole("button", { name: "Help for this page" }).click();
  const panel = page.getByRole("dialog", { name: "Help" });
  await expect(panel.getByRole("heading", { name: "On this page" })).toBeVisible();
  await expect(panel.getByRole("link", { name: /^Customers/ }).first()).toBeVisible();
  await panel.getByLabel("Search help").fill("delivery ticket");
  await expect(panel.getByRole("heading", { name: "Results" })).toBeVisible();
  await panel.getByLabel("Search help").press("Enter");
  await expect(page).toHaveURL(/\/help\?q=delivery/);
  await expect(page.getByRole("region", { name: "Search results" })).toContainText(/article/);
  await page.goto(`/help?q=${encodeURIComponent(`zzzz ${unique()}`)}`);
  await expect(page.getByText("No article matches")).toBeVisible();
});

test("an article records feedback, and a guide highlights controls without creating anything", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/help/customers");
  await expect(page.getByRole("heading", { name: "Customers", level: 1 })).toBeVisible();
  await page.getByLabel(/What was missing or wrong/).fill("More about exports, please");
  await page.getByRole("button", { name: "No" }).click();
  await expect(page.getByText(/your answer is saved/)).toBeVisible();
  await expect(page.getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Show Me How" }).click();
  await expect(page).toHaveURL(/\/customers$/);
  const guide = page.getByRole("complementary", { name: "Guide" });
  await expect(guide).toContainText("Step 1 of 3");
  await expect(page.locator('[data-guide="customers-new"]')).toHaveAttribute("data-guide-active", "true");
  await guide.getByRole("button", { name: "Next" }).click();
  await expect(guide).toContainText("This step is on another page");
  await guide.getByRole("link", { name: "Go there" }).click();
  await expect(page).toHaveURL(/\/customers\/new$/);
  await expect(page.locator('[data-guide="customer-name"]')).toHaveAttribute("data-guide-active", "true");
  await guide.getByRole("button", { name: /Exit the guide/ }).click();
  await expect(guide).toHaveCount(0);
});

test("articles follow the role: a driver does not see payroll or settings help", async ({ page }) => {
  await signIn(page, "driver");
  await page.goto("/help");
  await expect(page.getByRole("heading", { name: "Help Center" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Payroll/ })).toHaveCount(0);
  await page.goto("/help/settings-roles-permissions");
  await expect(page.getByText("Not found", { exact: true })).toBeVisible();
});

test("a support request is reviewed before it is sent, and only the sender sees it", async ({ page, browser }) => {
  await signIn(page, "dispatcher");
  const text = `Where do I see tomorrow's loads? ${unique()}`;
  await page.goto("/help/contact?from=/dispatch");
  await page.getByLabel("What do you need help with?").fill(text);
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Review Before Sending" })).toBeVisible();
  await expect(page.getByText("and the page you were on: /dispatch")).toBeVisible();
  expect(page.url()).not.toContain("tomorrow");
  await page.getByRole("button", { name: "Send to Support" }).click();
  await expect(page.getByText("Sent to Taviron support")).toBeVisible();
  await expect(page.getByRole("region", { name: "Your Recent Requests" })).toContainText(text);

  const other = await browser.newPage();
  await signIn(other, "office");
  await other.goto("/help/contact");
  await expect(other.getByText(text)).toHaveCount(0);

  // The platform team sees it in the console, with the company and page.
  const admin = await browser.newPage();
  await signInPlatform(admin);
  await expect(admin).toHaveURL(/\/admin$|\/command-center/);
  await admin.goto("/admin/support");
  await expect(admin.getByRole("table", { name: "Support requests" }).getByRole("row").filter({ hasText: text })).toContainText("/dispatch");
});
