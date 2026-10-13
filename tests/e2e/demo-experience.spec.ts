import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { asUser } from "./db";
import { closeDemoWelcome, signIn, unique } from "./helpers";
import { USERS } from "./users";

// The demo experience (docs/DEMO_TENANTS.md §2): the header shows the person's own profile photo (also when a demo
// shows them by their employee record, as for a prospect owner like Colby Chapman), a one-time welcome replaces the
// demo bar, and "Change view" in the profile menu switches the role preview. Local stack only.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A demo company whose owner is linked to an employee record of the same name (what `demo-owner` sets up). */
async function demoWithLinkedOwner(name: string) {
  const tag = unique();
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const email = `e2e-demo-exp-${tag}-${randomUUID().slice(0, 4)}@demotest.example`;
  const password = `Pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    const companyId = (await c.query<{ id: string }>("select private.create_company($1, $2) as id", [`Demo Experience ${tag}`, `prospect-exp${tag}`])).rows[0].id;
    await c.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [companyId]);
    await c.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [companyId, data.user.id]);
    await c.query("update public.profiles set active_company_id = $1 where id = $2", [companyId, data.user.id]);
    await c.query("insert into public.employees (company_id, full_name, user_id, department, job_title) values ($1, $2, $3, 'management', 'Owner')", [companyId, name, data.user.id]);
  } finally {
    await c.end();
  }
  return { email, password, userId: data.user.id };
}

async function signInAs(page: Page, who: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/command-center/);
}

const welcome = (page: Page) => page.getByRole("dialog", { name: "Welcome to the Taviron demo" });
const account = (page: Page) => page.getByRole("button", { name: /^Account menu/ });
/** The Change view dialog and one of its views (by the view's label). */
const viewList = (page: Page) => page.getByRole("dialog", { name: "Change view" });
const view = (page: Page, label: string) => viewList(page).getByRole("button", { name: new RegExp(`^${label} [A-Z]`) });
async function openChangeView(page: Page) {
  await account(page).click();
  await page.getByRole("menuitem", { name: /Change view/ }).click();
  await expect(viewList(page)).toBeVisible();
}

test("a demo owner's own photo shows in the header, with initials when there is none or it fails", async ({ page }) => {
  const colby = await demoWithLinkedOwner("Colby Chapman");
  await asUser(colby.email, (q) => q("select public.set_my_photo('image/png', $1)", [PNG]));
  await signInAs(page, colby);
  await closeDemoWelcome(page);
  const header = page.getByRole("banner");
  const photo = header.locator(`img[src^='/people/photo/${colby.userId}?v=']`);
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(photo).toHaveCSS("border-radius", /px|%/); // the round crop of the existing avatar
  await expect(header).not.toContainText(/^CC$/);

  // The photo comes from the same record as everywhere else: the employee directory shows it too.
  await page.goto("/employees");
  await expect(page.locator(`main img[src^='/people/photo/${colby.userId}']`).first()).toBeVisible();

  // An unavailable photo falls back to initials, never a broken image.
  await page.route(`**/people/photo/${colby.userId}*`, (r) => r.fulfill({ status: 404, body: "" }));
  await page.reload();
  await expect(header.getByText("CC", { exact: true })).toBeVisible();
  await page.unroute(`**/people/photo/${colby.userId}*`);

  // Removing the photo shows initials at once; a new one replaces them.
  await asUser(colby.email, (q) => q("select public.set_my_photo(null, null)"));
  await page.reload();
  await expect(header.getByText("CC", { exact: true })).toBeVisible();
  await expect(header.locator("img[src^='/people/photo/']")).toHaveCount(0);
});

test("regular accounts keep their own photo in the header", async ({ page }) => {
  await signIn(page, "dispatcher");
  const email = USERS.dispatcher.email;
  const id = await asUser(email, async (q) => (await q("select (public.my_profile()->>'user_id') as id")).rows[0].id as string);
  await asUser(email, (q) => q("select public.set_my_photo('image/png', $1)", [PNG]));
  try {
    await page.reload();
    await expect(page.getByRole("banner").locator(`img[src^='/people/photo/${id}?v=']`)).toBeVisible();
    await expect(welcome(page)).toHaveCount(0); // never in a real company
    await account(page).click();
    await expect(page.getByRole("menuitem", { name: /Change view/ })).toHaveCount(0); // no demo controls
    await expect(page.getByRole("menuitemcheckbox", { name: "Presentation mode" })).toHaveCount(0);
  } finally {
    await asUser(email, (q) => q("select public.set_my_photo(null, null)"));
  }
});

test("the demo welcome shows once, is remembered across pages, reloads and sign-ins, and can be reopened", async ({ page, browser }) => {
  const person = await demoWithLinkedOwner("Wren Okafor");
  await signInAs(page, person);
  await expect(page.getByRole("region", { name: "Demo company" })).toHaveCount(0); // no persistent bar
  const dialog = welcome(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("fictional sample data");
  await expect(dialog).toContainText("Nothing here is a real customer operation or transaction");
  // Keyboard: focus starts on the primary action and stays inside the dialog.
  await expect(dialog.getByRole("button", { name: "Explore the demo" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape"); // dismissing by Escape counts as seen
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("banner").getByText("Demo", { exact: true })).toBeVisible();

  await page.goto("/orders");
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(dialog).toHaveCount(0);

  // Remembered for the account, not the browser: a new browser session does not show it again.
  const fresh = await browser.newPage();
  await signInAs(fresh, person);
  await expect(fresh.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expect(welcome(fresh)).toHaveCount(0);
  await fresh.close();

  // Still available from the profile menu, which also says it is a demo.
  await account(page).click();
  await expect(page.getByRole("menu")).toContainText("Demo company · fictional data · nothing is sent");
  await page.getByRole("menuitem", { name: "About this demo" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Explore the demo" }).click();
  await expect(dialog).toHaveCount(0);
});

test("Change view switches the role preview from the profile menu, on desktop and phone, in light and dark", async ({ page }) => {
  const person = await demoWithLinkedOwner("Juno Alvarez");
  await signInAs(page, person);
  await closeDemoWelcome(page);
  const nav = page.getByRole("navigation").first();
  await expect(nav.getByRole("link", { name: "Billing" })).toBeVisible();

  await account(page).click();
  const trigger = page.getByRole("menuitem", { name: /Change view/ });
  await expect(trigger).toContainText("Myself");
  await trigger.focus();
  await page.keyboard.press("Enter"); // keyboard opens the views
  await expect(viewList(page)).toBeVisible();
  const labels = await viewList(page).getByRole("button").filter({ hasNotText: /^$/ }).locator("span.font-semibold").allTextContents();
  expect(labels).toEqual(["Myself", "Owner", "Dispatcher", "Dispatcher who also drives", "Office", "Driver", "Mechanic"]);
  await expect(view(page, "Myself")).toHaveAttribute("aria-pressed", "true");
  await expect(viewList(page).locator(":focus")).toHaveCount(1); // focus moved into the dialog
  await page.keyboard.press("Escape");
  await expect(viewList(page)).toHaveCount(0);
  await openChangeView(page);
  await view(page, "Office").click();
  await expect(page.getByRole("banner")).toContainText("Demo · Office");
  await expect(nav.getByRole("link", { name: "Dispatch" })).toBeVisible();
  // The preview narrows real permissions; it never adds any (the page itself refuses what the view hides).
  await openChangeView(page);
  await expect(view(page, "Office")).toHaveAttribute("aria-pressed", "true");
  await view(page, "Mechanic").click();
  await expect(page.getByRole("banner")).toContainText("Demo · Mechanic");
  await expect(nav.getByRole("link", { name: "Billing" })).toHaveCount(0);
  // Same person and company throughout.
  await expect(page.getByRole("banner")).toContainText("Juno Alvarez");
  await expect(page.getByRole("banner")).toContainText("Demo Experience");
  await page.goto("/billing");
  await expect(page).toHaveURL(/no-access/);

  // Phone, dark mode: the menu and the views fit the screen and use the theme.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/command-center");
  await page.evaluate(() => { localStorage.setItem("taviron-theme", "dark"); });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await openChangeView(page);
  const sub = viewList(page);
  const box = (await sub.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  const bg = await sub.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe("rgb(255, 255, 255)"); // the dark card, not a white panel
  await view(page, "Driver").click();
  await expect(page).toHaveURL(/\/driver/);
  await page.evaluate(() => { localStorage.removeItem("taviron-theme"); });
});

test("presentation mode hides the demo badge and the welcome, and turns off from the menu", async ({ page }) => {
  const person = await demoWithLinkedOwner("Remy Castellanos");
  await signInAs(page, person);
  await expect(welcome(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await account(page).click();
  await page.getByRole("menuitemcheckbox", { name: "Presentation mode" }).click();
  await expect(page.getByRole("banner").getByText("Demo", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("banner").getByText("Demo", { exact: true })).toHaveCount(0);
  await expect(welcome(page)).toHaveCount(0);
  // Change view still works while presenting.
  await openChangeView(page);
  await view(page, "Dispatcher").click();
  await expect(page.getByRole("navigation").first().getByRole("link", { name: "Billing" })).toHaveCount(0);
  await account(page).click();
  await page.getByRole("menuitemcheckbox", { name: "Presentation mode" }).click();
  await expect(page.getByRole("banner")).toContainText("Demo · Dispatcher");
});
