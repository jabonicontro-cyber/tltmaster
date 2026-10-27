import { expect, test, type Page } from "@playwright/test";
import { closeDemoWelcome, signIn, unique, signInPlatform } from "./helpers";
import { asUser } from "./db";
import { PASSWORD, PLATFORM_USER } from "./users";

// N13: the public website, the platform team's private area (leads, live demo
// with role previews, team-led onboarding imports), and that none of it is
// reachable without the platform role.
test.describe.configure({ mode: "serial" });

async function signInPlatformHome(page: Page) {
  await signInPlatform(page);
  // Without a company of their own they land on the launchpad; once they have
  // opened the demo company, on its Command Center.
  await expect(page).toHaveURL(/\/admin$|\/command-center/);
  if (!page.url().endsWith("/admin")) await page.goto("/admin");
}

const SITE = ["/", "/platform", "/solutions", "/pricing", "/about", "/contact", "/demo", "/privacy", "/terms"];

test("the public website is open to everyone, works on a phone, and shows the pricing tiers", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  for (const path of SITE) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page, path).toHaveURL(new RegExp(`${path === "/" ? "/$" : `${path}$`}`)); // no redirect to sign-in or the gate
    await expect(page.locator("h1").first(), path).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${path} scrolls sideways`).toBeLessThanOrEqual(0);
  }
  await page.goto("/pricing");
  const essential = page.getByRole("listitem", { name: "Essential" });
  await expect(essential.getByText("$499", { exact: true })).toBeVisible();
  await expect(essential.getByText("$449.10", { exact: true })).toBeVisible();
  await expect(essential.getByRole("link", { name: "Book a Demo" })).toHaveAttribute("href", "/demo");
  await expect(page.getByRole("listitem", { name: "Enterprise" }).getByText("$1,499", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Contact Us" })).toHaveAttribute("href", "/contact");
  await expect(page.getByText(/before applicable taxes/).first()).toBeVisible();
  // Founding-customer pricing is private and never shown.
  await expect(page.getByText(/found/i)).toHaveCount(0);
  await expect(page.getByText("$399.20")).toHaveCount(0);
  // The mobile menu works.
  await page.getByLabel("Menu").click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Platform" }).click();
  await expect(page).toHaveURL(/\/platform$/);
  // App pages still need sign-in.
  await page.goto("/command-center");
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test("the homepage: one heading, demo calls to action lead to the form, and keyboard focus is visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText("Your entire trucking operation. Connected.");
  const demoLinks = page.getByRole("link", { name: /Request a demo/i });
  expect(await demoLinks.count()).toBeGreaterThanOrEqual(2);
  for (const href of await demoLinks.evaluateAll((els) => els.map((e) => e.getAttribute("href")))) expect(href).toBe("/demo");
  // Every product image has a description.
  for (const alt of await page.locator("main img").evaluateAll((els) => els.map((e) => e.getAttribute("alt") ?? ""))) expect(alt.length).toBeGreaterThan(10);
  // Tab to the logo link: the focus outline is drawn.
  await page.keyboard.press("Tab"); // skip link
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
  expect(outline).toBe("solid");
  await page.getByRole("link", { name: /Request a demo/i }).first().click();
  await expect(page).toHaveURL(/\/demo$/);
});

test("a demo request reaches the lead workspace, where the team works it with a full history", async ({ page, browser }) => {
  const id = unique();
  const email = `pat.${id}@example.com`;
  await page.goto("/demo");
  await page.getByLabel("Full name").fill(`Pat Example ${id}`);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel(/^Company/).fill(`Example Hauling ${id} (test)`);
  await page.getByLabel(/What would you most like Taviron to improve/).fill("Dispatch board and ticket review.");
  await page.waitForTimeout(2600); // a person takes a moment; instant submissions are treated as automated
  // The truck and dispatch-base counts are required.
  await page.getByRole("button", { name: "Request a demo" }).click();
  await expect(page.locator("#truck_count-error")).toHaveText("Enter the number of hauling trucks (0 if none).");
  await expect(page.locator("#base_count-error")).toHaveText("Enter the number of dispatch bases.");
  await page.getByLabel("Number of hauling trucks").fill("18");
  await page.getByLabel("Number of dispatch bases").fill("2");
  await page.getByRole("button", { name: "Request a demo" }).click();
  await expect(page.getByText("Thank you — your message reached the Taviron team.")).toBeVisible();

  // Validation is shown in the form (and checked again on the server).
  const other = await browser.newPage();
  await other.goto("/contact");
  await other.getByLabel("Full name").fill("Sam");
  await other.getByLabel("Work email").fill("not-an-email");
  await other.getByLabel("Message").fill("Hello there, a question about pricing.");
  await other.waitForTimeout(2600);
  await other.getByRole("button", { name: "Send message" }).click();
  await expect(other.getByText("Enter a valid email address.").first()).toBeVisible();
  await other.close();

  await signInPlatformHome(page);
  await page.getByRole("link", { name: /Leads/ }).first().click();
  await page.getByLabel("Search").fill(id);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: `Pat Example ${id}` }).click();
  await expect(page.getByText(`Example Hauling ${id} (test)`).first()).toBeVisible();
  await expect(page.getByText("Dispatch board and ticket review.")).toBeVisible();
  await expect(page.getByText("Hauling trucks").locator("..")).toContainText("18");
  await expect(page.getByText("Dispatch bases").locator("..")).toContainText("2");
  // Both emails were recorded, and nothing was sent (preview mode).
  const emails = page.getByRole("list", { name: "Email attempts" });
  await expect(emails.getByRole("listitem")).toHaveCount(2);
  await expect(emails).toContainText("Confirmation to the prospect");
  await expect(emails).toContainText("Notification to Taviron");
  await expect(emails.getByText("Not sent")).toHaveCount(2);
  await expect(page.getByLabel("Status").locator("option")).toHaveText(["New", "Contacted", "Demo Scheduled", "Demo Completed", "Converted", "Not Proceeding"]);
  await page.getByLabel("Status").selectOption("contacted");
  await page.getByLabel("Owner").selectOption({ label: PLATFORM_USER.name });
  await page.getByLabel("Follow up on").fill("2030-01-15");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByLabel("Add a note").fill(`Called ${id}; demo next week.`);
  await page.getByRole("button", { name: "Add note" }).click();
  const history = page.locator("#history");
  await expect(history.getByText("Changed the status")).toBeVisible();
  await expect(history.getByText("New → Contacted")).toBeVisible();
  await expect(history.getByText("Changed the owner")).toBeVisible();
  await expect(history.getByText(`Called ${id}; demo next week.`)).toBeVisible();

  // Spam needs Not Proceeding; flagged leads leave the default queue.
  await page.getByLabel("Spam").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Only a lead marked Not Proceeding can be flagged as spam.")).toBeVisible();
  await page.getByLabel("Status").selectOption("not_proceeding");
  await page.getByLabel("Spam").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(history.getByText("Flagged as spam")).toBeVisible();
  await page.goto(`/admin/leads?q=${id}`);
  await expect(page.getByRole("link", { name: `Pat Example ${id}` })).toHaveCount(0);
  await page.goto(`/admin/leads?q=${id}&status=spam`);
  await expect(page.getByRole("link", { name: `Pat Example ${id}` })).toBeVisible();
});

test("the platform area is not reachable without the platform role", async ({ page, request }) => {
  // Signed out: sign in first.
  const anon = await request.get("/admin/leads", { maxRedirects: 0, headers: { accept: "text/html" } });
  expect(anon.status()).toBe(307);
  expect(anon.headers().location).toMatch(/\/login/);
  // A company owner is not a platform admin: the area does not exist for them.
  await signIn(page, "owner");
  for (const path of ["/admin", "/admin/leads", "/admin/companies", `/admin/companies/${"0".repeat(8)}-0000-4000-8000-000000000001`, "/admin/demo", "/admin/onboarding", "/admin/platform"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.getByText(/Pia Platform|Platform team|Launchpad/)).toHaveCount(0);
  }
});

test("live demo: a separate company with fictional data; role previews only narrow what is shown", async ({ page }) => {
  test.setTimeout(120_000);
  await signInPlatformHome(page);
  await page.goto("/admin/demo");
  await page.getByRole("button", { name: /Start the demo|Reset: start a fresh demo/ }).click();
  await expect(page).toHaveURL(/\/command-center/, { timeout: 60_000 });
  // A one-time welcome says it is a demo (no bar on every page); the menu keeps saying so.
  await expect(page.getByRole("dialog", { name: "Welcome to the Taviron demo" })).toContainText("fictional sample data");
  await closeDemoWelcome(page);
  await expect(page.getByRole("region", { name: "Demo company" })).toHaveCount(0);
  const menu = () => page.getByRole("button", { name: new RegExp(`Account menu: ${PLATFORM_USER.name}`) });
  /** Change view in the profile menu: the existing role preview, which only narrows what is shown. */
  const changeView = async (label: RegExp) => {
    await menu().click();
    await page.getByRole("menuitem", { name: /Change view/ }).click();
    await page.getByRole("dialog", { name: "Change view" }).getByRole("button", { name: label }).click();
  };
  await expect(page.getByRole("heading", { name: "Command Center", level: 1 })).toBeVisible();
  // The platform team member is shown as themselves with the Taviron Administrator role (owner requirement
  // 2026-10-18), never as the demo's fictional employee; the company's own branding stays. The demo's records keep the
  // fictional persona (Daniel Mitchell) and the presenter's real account is untouched.
  await expect(page.getByTestId("greeting")).toHaveText(`Hi, ${PLATFORM_USER.name.split(" ")[0]}!`);
  await expect(page.getByRole("banner")).toContainText(PLATFORM_USER.name);
  await expect(page.getByRole("banner")).toContainText("Taviron Administrator · Northfield Aggregates");
  await expect(page.getByRole("banner")).not.toContainText("Daniel Mitchell");
  await expect(page.getByRole("img", { name: /Northfield Aggregates/ }).first()).toBeVisible();
  const realName = await asUser(PLATFORM_USER.email, async (q) => (await q("select full_name from public.profiles where id = auth.uid()")).rows[0].full_name);
  expect(realName).toBe(PLATFORM_USER.name);
  // People: drivers and staff in the directory, pay visible to the owner, primary trucks set.
  await page.goto("/employees?status=all");
  await expect(page.getByRole("link", { name: "Sam Kowalski" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Avery Lindqvist/ })).toContainText("Truck 101");
  await expect(page.getByRole("row", { name: /Avery Lindqvist/ }).locator("img[src='/avatars/avatar-01.png']")).toBeVisible();
  await page.getByRole("link", { name: "Lena Park" }).click();
  await expect(page.getByText("Pay (confidential)")).toBeVisible();
  await page.goto("/orders");
  await expect(page.getByText("Brightwater office park — topsoil", { exact: true })).toBeVisible();
  await expect(page.getByText(/Prairie View|Top Line/)).toHaveCount(0); // nothing from any other company

  // The owner sees Billing; the dispatcher preview hides it, and the page itself refuses.
  const nav = page.getByRole("navigation").first();
  await page.goto("/command-center");
  await expect(nav.getByRole("link", { name: "Billing" })).toBeVisible();
  await changeView(/^Dispatcher [A-Z]/);
  await expect(page.getByRole("banner")).toContainText("Demo · Dispatcher");
  await expect(nav.getByRole("link", { name: "Billing" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Dispatch" })).toBeVisible();
  await page.goto("/billing");
  await expect(page).toHaveURL(/\/no-access/);

  // Driver preview: the driver portal with the demo assignment.
  await page.goto("/command-center");
  await changeView(/^Driver [A-Z]/);
  await expect(page).toHaveURL(/\/driver/);
  await expect(page.getByText("4th St water main — bedding stone").first()).toBeVisible();
  await expect(page.getByTestId("greeting")).toHaveText(`Hi, ${PLATFORM_USER.name.split(" ")[0]}!`);
  // Ticket history from earlier days, with different customers and statuses.
  await expect(page.getByText(/^Daniel Mitchell · /)).toBeVisible();
  const history = page.getByRole("list", { name: "My recent tickets" });
  expect(await history.getByRole("listitem").count()).toBeGreaterThanOrEqual(3);
  // Only his own loads (truck 103, a 15 t tandem) — not every ticket the demo seeded.
  const quantities = await history.getByRole("listitem").locator("span.tabular").filter({ hasText: /ton$/ }).allTextContents();
  expect(quantities.length).toBeGreaterThanOrEqual(3);
  for (const q of quantities) {
    expect(Number(q.replace(/[^\d.]/g, "")), q).toBeLessThanOrEqual(15);
  }
  // On a phone the header and the Change view menu fit without pushing the page sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await menu().click(); // the account menu keeps its name on a phone, where only the picture shows
  await page.getByRole("menuitem", { name: /Change view/ }).click();
  const views = page.getByRole("dialog", { name: "Change view" });
  const box = (await views.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1366, height: 900 });

  // Back to myself.
  await changeView(/^Myself [A-Z]/);
  await expect(page.getByRole("banner")).not.toContainText("Demo · ");

  // Presentation mode (for screenshots and live demos): the bar is tucked away — data, alerts and
  // permissions unchanged — and comes back from the user menu.
  await page.goto("/command-center");
  const attention = (await page.getByRole("region", { name: "Attention summary" }).textContent())!.split("As of")[0].trim();
  await expect(page.getByRole("banner").getByText("Demo", { exact: true })).toBeVisible();
  await menu().click();
  await page.getByRole("menuitemcheckbox", { name: "Presentation mode" }).click();
  await expect(page.getByRole("banner").getByText("Demo", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Attention summary" })).toContainText(attention); // alerts unchanged
  await page.reload();
  await expect(page.getByRole("banner").getByText("Demo", { exact: true })).toHaveCount(0);
  await menu().click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Presentation mode" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemcheckbox", { name: "Presentation mode" }).click();
  await expect(page.getByRole("banner").getByText("Demo", { exact: true })).toBeVisible();
  await page.goto("/billing");
  await expect(page).toHaveURL(/\/billing/);
  // No external side effects: invitations are refused in the demo company.
  await page.goto("/settings?tab=users");
  await page.getByRole("button", { name: "Invite user" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Email").fill("someone.real@example.com");
  await d.getByLabel("Name").fill("Someone Real");
  await d.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("Invitations are turned off in the demo company").first()).toBeVisible();
});

test("team-led onboarding: map a spreadsheet, review, approve, then revert without touching anything else", async ({ page }) => {
  const id = unique();
  await signInPlatformHome(page);
  await page.goto("/admin/onboarding");
  await page.getByLabel("Company name").fill(`Lakeview Haul ${id} (test)`);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByText("Company created. Import its records below.")).toBeVisible();

  const csv = [
    "Truck #,Type,Make,Year,Plate",
    `A-${id},Tri-axle,Mack,2019,ABC123`,
    `B-${id},tandem,Kenworth,2021,`,
    `a-${id},tri axle,Mack,2019,`,
    `C-${id},spaceship,,1890,`,
  ].join("\r\n");
  await page.getByLabel("The spreadsheet contains").selectOption("trucks");
  await page.getByLabel("Spreadsheet file (CSV)").setInputFiles({ name: "fleet.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  // Columns are matched from the header names; the year column needs no help, "Truck #" maps to the unit number.
  await expect(page.getByLabel("Field for column Truck #")).toHaveValue("unit_number");
  await expect(page.getByLabel("Field for column Type")).toHaveValue("truck_type");
  await expect(page.getByText(/4\s*rows/)).toBeVisible();
  await page.getByRole("button", { name: "Check and send to review" }).click();

  await expect(page).toHaveURL(/\/admin\/onboarding\/batch\//);
  await expect(page.getByText("Nothing has been created yet")).toBeVisible();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Ready");
  await expect(rows.nth(2)).toContainText("Possible duplicate");
  await expect(rows.nth(2)).toContainText("Same as row 2");
  await expect(rows.nth(3)).toContainText("Needs fixing");
  await page.getByRole("button", { name: "Approve and create 2" }).click(); // the confirm box is required
  await expect(page).toHaveURL(/batch\//);
  await page.getByLabel("I reviewed the rows and the decisions above.").check();
  await page.getByRole("button", { name: "Approve and create 2" }).click();
  await expect(page.getByText("Approved. The records now exist in the company.")).toBeVisible();
  await expect(rows.nth(0)).toContainText("Created");

  await page.getByLabel("Reason").fill("Wrong spreadsheet (test)");
  await page.getByRole("button", { name: "Revert import" }).click();
  await expect(page.getByText(/Reverted\. Records that were untouched/)).toBeVisible();
  await expect(rows.nth(0)).toContainText("Removed by revert");
  await page.getByRole("link", { name: `Lakeview Haul ${id} (test)` }).click();
  await expect(page.getByText(/0 trucks/)).toBeVisible();

  // Every step is in the audit log.
  await page.goto("/admin/platform");
  for (const a of ["Company created", "Import staged", "Import approved", "Import reverted"]) await expect(page.getByText(a).first()).toBeVisible();
});

test("the Launchpad shows live platform work, links each item to its record, and the company directory filters and opens a company", async ({ page }) => {
  await signInPlatformHome(page);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Launchpad" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Platform" }).getByRole("link", { name: "Launchpad" })).toHaveAttribute("aria-current", "page");
  const overview = page.getByRole("list", { name: "Platform overview" });
  await expect(overview.getByRole("listitem")).toHaveCount(5);
  await expect(page.getByRole("list", { name: "Business KPIs" }).getByRole("listitem")).toHaveCount(4);
  await expect(page.getByLabel("Platform status")).toContainText(/need attention|Nothing needs attention/);
  // Every attention item links to a record page.
  const items = page.getByRole("list", { name: "Needs attention" }).getByRole("link");
  for (const href of await items.evaluateAll((els) => els.slice(0, 10).map((e) => e.getAttribute("href")))) {
    expect(href).toMatch(/^\/admin\/(leads|companies|onboarding\/batch)\/[0-9a-f-]{36}$|^\/admin\/demo$/);
  }

  // A new company appears in the directory as "setup incomplete" and opens its detail page.
  const name = `Directory Hauling ${unique()}`;
  await page.goto("/admin/onboarding");
  await page.getByLabel("Company name").fill(name);
  await page.getByRole("button", { name: "Create company" }).click();
  await page.waitForURL(/\/admin\/onboarding\/[0-9a-f-]{36}\?created=1/); // the company exists before moving on
  await page.goto(`/admin/companies?q=${encodeURIComponent(name)}&setup=incomplete`);
  await expect(page.getByRole("navigation", { name: "Platform" }).getByRole("link", { name: "Companies" })).toHaveAttribute("aria-current", "page");
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("Setup Incomplete");
  await expect(row).toContainText("Missing owner login, customers, trucks, drivers");
  await row.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("list", { name: "Setup steps" }).getByRole("listitem")).toHaveCount(4);
  await expect(page.getByText("Nobody can sign in to this company yet.")).toBeVisible();
  await expect(page.getByText(/Company created — Created company/)).toBeVisible();
  // The same name is refused instead of creating a duplicate company.
  await page.goto("/admin/onboarding");
  await page.getByLabel("Company name").fill(name);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByText(/already exists/)).toBeVisible();
});

test("the platform team member appears as themselves (name, Taviron Administrator, initials or photo) in the console; a company user keeps their own identity", async ({ page, browser }) => {
  await signInPlatformHome(page);
  await page.goto("/admin");
  const account = page.getByRole("button", { name: new RegExp(`Account menu: ${PLATFORM_USER.name}`) });
  await expect(account).toContainText("Taviron Administrator");
  await account.click();
  await page.getByRole("menuitem", { name: "My profile" }).click();
  await expect(page).toHaveURL(/\/admin\/profile$/);
  await expect(page.getByText("Granted and revoked only by an operator")).toBeVisible();
  // A company owner sees their own name and company role, never the administrator title.
  const ctx = await browser.newContext();
  const owner = await ctx.newPage();
  await signIn(owner, "owner");
  await owner.goto("/command-center");
  await expect(owner.getByRole("banner")).toContainText("Erin Owner");
  await expect(owner.getByRole("banner")).not.toContainText("Taviron Administrator");
  await ctx.close();
});

test("customer lifecycle: plan and founding offer, onboarding fee, go-live only earlier, Go Live Now with the password; acknowledging is not resolving", async ({ page }) => {
  test.slow();
  await signInPlatformHome(page);
  const kpis = page.getByRole("list", { name: "Business KPIs" });
  await expect(kpis).toContainText("Monthly recurring revenue");
  const liveBefore = Number((await kpis.getByRole("listitem").first().locator("p").nth(1).textContent()) ?? "0");

  const name = `Lifecycle Hauling ${unique()}`;
  await page.goto("/admin/onboarding");
  await page.getByLabel("Company name").fill(name);
  await page.getByRole("button", { name: "Create company" }).click();
  await page.waitForURL(/\/admin\/onboarding\/[0-9a-f-]{36}\?created=1/);
  const id = page.url().match(/onboarding\/([0-9a-f-]{36})/)![1];
  await page.goto(`/admin/companies/${id}`);
  const sub = page.getByRole("region", { name: "Subscription" });
  await expect(sub).toContainText("Not set up");
  await sub.getByLabel("Plan").selectOption({ label: "Essential — $499/mo, onboarding $199" });
  await sub.getByLabel("Offer").selectOption("founding");
  await sub.getByRole("button", { name: "Save plan and terms" }).click();
  await expect(sub).toContainText("$399.20");
  await expect(sub).toContainText("Onboarding fee due");

  await sub.getByLabel("Payment reference or waiver reason").fill("Check 2201 (test)");
  await sub.getByRole("button", { name: "Record" }).click();
  await expect(sub).toContainText("received");
  await expect(sub.getByText("Onboarding", { exact: true })).toBeVisible();

  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  await sub.getByLabel("Go-live date").fill(day(30));
  await sub.getByRole("button", { name: "Set go-live date" }).click();
  await expect(sub.getByLabel("Move go-live earlier")).toBeVisible();
  await sub.getByLabel("Move go-live earlier").fill(day(40));
  await sub.getByRole("button", { name: "Move earlier" }).click();
  // The field hint also says "can only move earlier": wait for the refusal itself before typing in the next form.
  await expect(page.getByText(/^The go-live date can only move earlier/)).toBeVisible();

  await sub.getByLabel("Your password").fill("not-the-password-123");
  await sub.getByLabel("This company goes live today").check();
  await sub.getByRole("button", { name: "Go live now" }).click();
  await expect(page.getByText("That password is not correct. Nothing was changed.")).toBeVisible();
  await sub.getByLabel("Your password").fill(PASSWORD);
  await sub.getByLabel("This company goes live today").check();
  await sub.getByRole("button", { name: "Go live now" }).click();
  await expect(sub.getByText("Live", { exact: true })).toBeVisible();
  await expect(sub).toContainText("Live since");

  await page.goto("/admin");
  await expect(kpis.getByRole("listitem").first()).toContainText(String(liveBefore + 1));
  // Acknowledge the first open item: it stays on the list, marked as acknowledged.
  const list = page.getByRole("list", { name: "Needs attention" });
  const first = list.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Acknowledge" }) }).first();
  if (await first.count()) {
    const title = (await first.locator("span.break-words").first().textContent())!;
    await first.getByRole("button", { name: "Acknowledge" }).click();
    await expect(list.getByRole("listitem").filter({ hasText: title }).first()).toContainText(/Acknowledged by .* still open/);
  }
});
