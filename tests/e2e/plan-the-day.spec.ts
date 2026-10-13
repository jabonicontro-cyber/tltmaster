import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { closeDemoWelcome, signIn } from "./helpers";
import { PASSWORD, PLATFORM_USER } from "./users";
import { PREVIEW_COOKIE } from "@/lib/platform/preview";

// Plan the day (docs/OPTIMIZATION.md) and Company setup (docs/ONBOARDING.md) in the presenter demo: whole-day plans
// with honest statuses, approval through the normal assignment checks, and read-only setup readiness.

async function startDemo(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(PLATFORM_USER.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.goto("/admin/demo");
  await page.getByRole("button", { name: /Start the demo|Reset: start a fresh demo/ }).click();
  await page.waitForURL(/command-center/, { timeout: 240_000 });
  await closeDemoWelcome(page);
}

test("Plan the day: compare plans, see what needs review, approve a selection through the normal checks", async ({ page, context }) => {
  test.setTimeout(300_000);
  await startDemo(page);
  await page.goto("/dispatch");
  await page.getByRole("link", { name: "Plan the day" }).click();
  await expect(page.getByRole("heading", { name: "Plan the day", level: 1 })).toBeVisible();

  // Plans and their measured results; nothing claims to be verified while hours of service are unknown.
  const plans = page.getByRole("tablist", { name: "Plans" });
  await expect(plans.getByRole("tab").first()).toContainText("Balanced (your priorities)");
  await expect(page.getByText("Loads covered")).toBeVisible();
  await expect(page.getByText("Not evaluated — no cost data")).toBeVisible();
  const missing = page.getByRole("region", { name: "Missing or estimated information" });
  await expect(missing).toContainText("Hours of service are not checked");
  await expect(missing).toContainText("Travel distance and drive time are not calculated");
  await expect(page.getByText("Verified feasible")).toHaveCount(0);
  // AI explanation (docs/AI.md): without the owner's AI configuration it is Blocked, says why, and offers no button;
  // the deterministic plan is complete without it.
  const explain = page.getByRole("region", { name: "Explain this plan" });
  await expect(explain).toContainText("AI explanations are not available for this company yet.");
  await expect(explain).toContainText("AI: Blocked");
  await expect(explain.getByRole("button")).toHaveCount(0);
  const assignments = page.getByRole("region", { name: /Proposed assignments/ }).getByRole("listitem").filter({ has: page.getByRole("checkbox") });
  const count = await assignments.count();
  expect(count).toBeGreaterThanOrEqual(2);
  await expect(assignments.first()).toContainText("Needs review");
  await expect(assignments.first()).toContainText("Hours of service not verified");

  // Another preset gives an alternative with its trade-offs (or the same plan, said once).
  await page.getByRole("button", { name: "Service first" }).click();
  await expect(plans.getByRole("tab").first()).toContainText("Service first (your priorities)");

  // Approve only the first proposal: it is re-checked and assigned; the rest stay open.
  // Count again: the service-first plan may cover a different number of loads than the balanced one.
  await expect(assignments.first()).toBeVisible();
  const now = await assignments.count();
  const first = assignments.first();
  const label = (await first.locator("p").first().textContent())!.split(" · ")[0];
  for (let i = 1; i < now; i++) await assignments.nth(i).getByRole("checkbox").uncheck();
  await page.getByRole("button", { name: "Approve 1 selected" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "1 assignment(s) approved." })).toBeVisible();
  await page.reload();
  await expect(page.getByText(label, { exact: false })).toHaveCount(0); // no longer unassigned
  // The assignment exists, made through assign_load with the plan noted, and nothing else was assigned.
  const [orderNumber, loadNo] = label.split(" load ");
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try {
    const rows = (await db.query(
      "select a.status from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id join public.orders o on o.id = l.order_id where o.order_number = $1 and l.load_number = $2 and a.status = 'active' and o.company_id = (select id from public.companies where demo_kind = 'presenter' and active order by created_at desc limit 1)",
      [orderNumber, Number(loadNo)],
    )).rows;
    expect(rows).toHaveLength(1);
  } finally {
    await db.end();
  }

  // Demo modes: the dispatcher view plans and approves; the driver view has no dispatch access.
  await context.addCookies([{ name: PREVIEW_COOKIE, value: "dispatcher", url: page.url() }]);
  await page.goto("/dispatch/plan");
  await expect(page.getByRole("heading", { name: "Plan the day", level: 1 })).toBeVisible();
  await context.addCookies([{ name: PREVIEW_COOKIE, value: "driver", url: page.url() }]);
  await page.goto("/dispatch/plan");
  await expect(page).toHaveURL(/no-access|\/driver/);
  await context.clearCookies({ name: PREVIEW_COOKIE });
});

test("Company setup: owners see what is done, incomplete or missing; others cannot open it", async ({ page, context }) => {
  test.setTimeout(300_000);
  await startDemo(page);
  await page.getByRole("button", { name: /^Account menu/ }).click();
  await page.getByRole("menuitem", { name: "Company setup" }).click();
  await expect(page.getByRole("heading", { name: "Company setup", level: 1 })).toBeVisible();
  await expect(page.getByText(/\d of \d steps complete\./)).toBeVisible();
  for (const step of ["Company profile", "People and roles", "Customers", "Materials and rates", "Trucks and capacity", "Drivers and qualifications"]) {
    await expect(page.getByRole("heading", { name: step, level: 2 })).toBeVisible();
  }
  const ai = page.getByRole("region", { name: "AI capabilities" });
  await expect(ai.getByRole("heading", { name: "Explain this plan", level: 3 })).toBeVisible();
  await expect(ai).toContainText("Blocked");
  await expect(ai).toContainText("No AI provider is configured.");
  await context.addCookies([{ name: PREVIEW_COOKIE, value: "dispatcher", url: page.url() }]);
  await page.goto("/setup");
  await expect(page).toHaveURL(/no-access/);
  await context.clearCookies({ name: PREVIEW_COOKIE });
});

test("a company user without settings access cannot open Company setup", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/setup");
  await expect(page).toHaveURL(/no-access/);
});
