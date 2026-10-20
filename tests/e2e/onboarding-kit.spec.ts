import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";

// Onboarding kit (20261120001500; docs/ONBOARDING.md §5), company side on the local stack: answers are saved and
// reloaded, templates download only for people who manage settings, go-live cannot be signed while items are open,
// and the pages work on a phone.

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

test("an owner saves questionnaire answers, they persist, and go-live cannot be signed yet", async ({ page }) => {
  const name = `Kit Hauling ${unique()}`;
  await signIn(page, "owner");
  await page.goto("/setup");
  await page.getByRole("link", { name: "Open Onboarding" }).click();
  await expect(page.getByRole("heading", { name: "Onboarding", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Setup questionnaire" }).click();
  await page.getByLabel(/Legal company name/).fill(name);
  await page.getByLabel(/Number of trucks/).fill("14");
  await page.getByLabel(/Driver list ready to import/).selectOption("Needs cleanup");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save Answers" }).click();
  await expect(page.getByText(/Saved \(version \d+\)/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Legal company name/)).toHaveValue(name);
  await expect(page.getByLabel(/Number of trucks/)).toHaveValue("14");
  const [row] = await sql<{ n: number }>("select count(*)::int n from public.onboarding_form_versions where company_id = $1 and form = 'questionnaire' and data ->> 'legal_name' = $2", [TOP_LINE, name]);
  expect(row.n).toBe(1);

  await page.getByRole("link", { name: "Go-live acceptance" }).click();
  await expect(page.getByText("Not ready to sign:")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign Go-Live Acceptance" })).toBeDisabled();
  // The company cannot record Taviron's results: no result selectors on its side.
  await expect(page.getByRole("combobox", { name: /Result:/ })).toHaveCount(0);

  // The worksheet labels rules honestly.
  await page.getByRole("link", { name: "Dispatch worksheet" }).click();
  // The innermost block holding both the rule heading and its enforcement label.
  const hos = page.locator("div", { has: page.getByRole("heading", { name: "Hours of service" }), hasText: "Manually checked" }).last();
  await expect(hos).toBeVisible();
  await expect(hos).not.toContainText("Product-enforced");
});

test("templates download for settings managers only and match the importer", async ({ page, browser }) => {
  await signIn(page, "owner");
  const res = await page.request.get("/onboarding/templates/trucks");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain("taviron-trucks-template.csv");
  expect((await res.text()).split("\r\n")[0]).toMatch(/Unit/i);
  const driver = await browser.newPage();
  await signIn(driver, "driver");
  expect((await driver.request.get("/onboarding/templates/trucks")).status()).toBe(403);
  await driver.close();
});

test("the kit works on a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "owner");
  for (const s of ["overview", "questionnaire", "dispatch", "integrations", "golive"]) {
    await page.goto(`/setup/kit?section=${s}`);
    await expect(page.getByRole("main")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), s).toBeLessThanOrEqual(0);
  }
});
