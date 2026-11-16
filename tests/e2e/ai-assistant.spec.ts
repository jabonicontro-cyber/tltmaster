import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { expectToast, signIn } from "./helpers";

// Ask Taviron (docs/AI.md §15) on the local stack, which has no AI provider configured: the page opens from the header
// for people who may use it and is not offered to a driver-only login. It is off until the company turns it on in
// Settings (master plan §11a); then each person reads the first-use notice once; then the page says honestly that it is
// not available yet and why (reasons for administrators only). Answers themselves are covered with a mocked provider in
// tests/unit/ai-assistant.test.ts; the gate's opt-in rules in tests/unit/ai-optin.test.ts and tests/db/ai-optin.test.ts.

test.describe.configure({ mode: "serial" });
test.use({ deviceScaleFactor: 2 });

const SHOTS = process.env.AI_OPTIN_SHOTS;

/** Superuser cleanup (local stack only): Top Line back to its default, nobody has read the notice. */
async function resetOptIn() {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    await c.query("update public.company_settings set ai_assistant_allowed = false, ai_assistant_changed_at = null, ai_assistant_changed_by = null where company_id = (select id from public.companies where slug = 'top-line-trucking')");
    await c.query("delete from public.user_preferences where key = 'ai_notice' and company_id = (select id from public.companies where slug = 'top-line-trucking')");
  } finally {
    await c.end();
  }
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

test.beforeAll(resetOptIn);
test.afterAll(resetOptIn);

test("off until the company turns it on: an owner is pointed to Settings, without a question box", async ({ page }) => {
  await signIn(page, "owner");
  await page.getByRole("link", { name: "Ask Taviron" }).click();
  await expect(page.getByRole("heading", { name: "Ask Taviron", level: 1 })).toBeVisible();
  await expect(page.getByText("Ask Taviron is turned off for your company.")).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "Settings → Company and branding" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "Command Center" })).toBeVisible();
  await expect(page.getByLabel("Your question")).toHaveCount(0);
  await shot(page, "assistant-off-owner");
});

test("a dispatcher sees it is off and that an owner turns it on", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/assistant");
  await expect(page.getByText("Ask Taviron is turned off for your company.")).toBeVisible();
  await expect(page.getByText("An owner of your company can turn it on in Settings.")).toBeVisible();
  await expect(page.getByText("No AI provider is configured.")).toHaveCount(0);
});

test("the owner turns it on in Settings; each person reads the first-use notice once, then sees why it is not available yet", async ({ browser }) => {
  const owner = await (await browser.newContext({ deviceScaleFactor: 2 })).newPage();
  await signIn(owner, "owner");
  await owner.goto("/settings?tab=company");
  const section = owner.getByRole("region", { name: "Ask Taviron" });
  await expect(section.getByText("Off", { exact: true })).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shot(owner, "settings-ask-taviron-off");
  await section.getByRole("button", { name: "Turn on Ask Taviron" }).click();
  const confirm = owner.getByRole("dialog");
  await expect(confirm.getByText(/Their questions go to OpenAI with names replaced by codes/)).toBeVisible();
  await shot(owner, "settings-ask-taviron-confirm");
  await confirm.getByRole("button", { name: "Turn on" }).click();
  await expectToast(owner, "Ask Taviron is allowed for your company.");
  await expect(section.getByText("On", { exact: true })).toBeVisible();
  await shot(owner, "settings-ask-taviron-on");

  // First visit: the notice, nothing else.
  await owner.goto("/assistant");
  await expect(owner.getByRole("heading", { name: "Before you use Ask Taviron" })).toBeVisible();
  await expect(owner.getByText("What is sent")).toBeVisible();
  await expect(owner.getByText(/never your questions or the answers/)).toBeVisible();
  await expect(owner.getByRole("link", { name: "How your data is handled" })).toHaveAttribute("href", "/privacy#ai");
  await expect(owner.getByLabel("Your question")).toHaveCount(0);
  await shot(owner, "assistant-first-use-notice");
  await owner.getByRole("button", { name: "I understand, continue" }).click();
  await expectToast(owner, "Thanks. You can ask your question now.");
  // Then the honest state: the local stack has no AI provider, and an administrator sees why.
  await expect(owner.getByText(/Ask Taviron is not available for this company yet \(Blocked\)/)).toBeVisible();
  await expect(owner.getByText("No AI provider is configured.")).toBeVisible();
  await expect(owner.getByRole("main").getByRole("link", { name: "Company setup" })).toBeVisible();
  await shot(owner, "assistant-after-notice-owner");
  // Once only: a new visit goes straight to the page.
  await owner.reload();
  await expect(owner.getByText(/not available for this company yet/)).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Before you use Ask Taviron" })).toHaveCount(0);

  // Another person has not read it yet: they see it too, once, and no configuration details afterwards.
  const dispatcher = await (await browser.newContext()).newPage();
  await signIn(dispatcher, "dispatcher");
  await dispatcher.goto("/assistant");
  await expect(dispatcher.getByRole("heading", { name: "Before you use Ask Taviron" })).toBeVisible();
  await dispatcher.getByRole("button", { name: "I understand, continue" }).click();
  await expect(dispatcher.getByText(/not available for this company yet/)).toBeVisible();
  await expect(dispatcher.getByText("No AI provider is configured.")).toHaveCount(0);
  await expect(dispatcher.getByText(/An administrator of your company can see what is missing/)).toBeVisible();

  // A dispatcher cannot change the company's choice.
  await dispatcher.goto("/settings?tab=company");
  const readOnly = dispatcher.getByRole("region", { name: "Ask Taviron" });
  await expect(readOnly.getByText("An owner of your company can change this.")).toBeVisible();
  await expect(readOnly.getByRole("button", { name: /Turn (on|off) Ask Taviron/ })).toHaveCount(0);

  // Turned off again: nobody can ask, the notice stays read.
  await owner.goto("/settings?tab=company");
  await owner.getByRole("region", { name: "Ask Taviron" }).getByRole("button", { name: "Turn off Ask Taviron" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expectToast(owner, "Ask Taviron is turned off for your company.");
  await owner.goto("/assistant");
  await expect(owner.getByText("Ask Taviron is turned off for your company.")).toBeVisible();
});

test("a driver-only login is not offered Ask Taviron and cannot open it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "driver");
  await expect(page.getByRole("link", { name: "Ask Taviron" })).toHaveCount(0);
  await page.goto("/assistant");
  await expect(page).toHaveURL(/\/no-access/);
});

test("the page and the notice work on a phone without sideways scrolling", async ({ browser }) => {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  await c.query("update public.company_settings set ai_assistant_allowed = true where company_id = (select id from public.companies where slug = 'top-line-trucking')");
  await c.query("delete from public.user_preferences where key = 'ai_notice' and company_id = (select id from public.companies where slug = 'top-line-trucking')");
  await c.end();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  await signIn(page, "owner");
  await page.goto("/assistant");
  await expect(page.getByRole("heading", { name: "Before you use Ask Taviron" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await shot(page, "assistant-first-use-notice-phone");
});
