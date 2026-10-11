import { expect, test, type Page } from "@playwright/test";
import { signIn, unique } from "./helpers";
import { PASSWORD, PLATFORM_USER } from "./users";

// N13: the public website, the platform team's private area (leads, live demo
// with role previews, team-led onboarding imports), and that none of it is
// reachable without the platform role.
test.describe.configure({ mode: "serial" });

async function signInPlatform(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(PLATFORM_USER.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Without a company of their own they land on the launchpad; once they have
  // opened the demo company, on its Command Center.
  await expect(page).toHaveURL(/\/admin$|\/command-center/);
  if (!page.url().endsWith("/admin")) await page.goto("/admin");
}

const SITE = ["/", "/platform", "/solutions", "/pricing", "/about", "/contact", "/demo", "/privacy", "/terms"];

test("the public website is open to everyone, works on a phone, and states pricing as a proposal", async ({ browser }) => {
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
  await expect(page.getByText("$499", { exact: true })).toBeVisible();
  await expect(page.getByText("$399.20", { exact: true })).toBeVisible();
  await expect(page.getByText(/subject to confirmation/).first()).toBeVisible();
  await expect(page.getByText("Onboarding fee waived during the beta")).toBeVisible();
  await expect(page.getByText("Billing starts at go-live, not at sign-up")).toBeVisible();
  // The mobile menu works.
  await page.getByLabel("Menu").click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Platform" }).click();
  await expect(page).toHaveURL(/\/platform$/);
  // App pages still need sign-in.
  await page.goto("/command-center");
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
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

  await signInPlatform(page);
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
  for (const path of ["/admin", "/admin/leads", "/admin/demo", "/admin/onboarding", "/admin/platform"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.getByText(/Pia Platform|Platform team|Launchpad/)).toHaveCount(0);
  }
});

test("live demo: a separate company with fictional data; role previews only narrow what is shown", async ({ page }) => {
  test.setTimeout(120_000);
  await signInPlatform(page);
  await page.goto("/admin/demo");
  await page.getByRole("button", { name: /Start the demo|Reset: start a fresh demo/ }).click();
  await expect(page).toHaveURL(/\/command-center/, { timeout: 60_000 });
  const bar = page.getByRole("region", { name: "Demo company" });
  await expect(bar).toContainText("fictional data");
  await expect(page.getByRole("heading", { name: "Command Center", level: 1 })).toBeVisible();
  await page.goto("/orders");
  await expect(page.getByText("Brightwater office park — topsoil")).toBeVisible();
  await expect(page.getByText(/Prairie View|Top Line/)).toHaveCount(0); // nothing from any other company

  // The owner sees Billing; the dispatcher preview hides it, and the page itself refuses.
  const nav = page.getByRole("navigation").first();
  await page.goto("/command-center");
  await expect(nav.getByRole("link", { name: "Billing" })).toBeVisible();
  await bar.getByLabel("View as").selectOption("dispatcher");
  await expect(bar).toContainText("previewing as Dispatcher");
  await expect(nav.getByRole("link", { name: "Billing" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Dispatch" })).toBeVisible();
  await page.goto("/billing");
  await expect(page).toHaveURL(/\/no-access/);

  // Driver preview: the driver portal with the demo assignment.
  await page.goto("/command-center");
  await page.getByRole("region", { name: "Demo company" }).getByLabel("View as").selectOption("driver");
  await expect(page).toHaveURL(/\/driver/);
  await expect(page.getByText("4th St water main — bedding stone").first()).toBeVisible();

  // Back to myself.
  await page.getByRole("region", { name: "Demo company" }).getByLabel("View as").selectOption("");
  await expect(page.getByRole("region", { name: "Demo company" })).not.toContainText("previewing");
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
  await signInPlatform(page);
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
