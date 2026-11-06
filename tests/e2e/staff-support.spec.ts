import { expect, test, type Browser, type Page } from "@playwright/test";
import { signIn, signInPlatform, unique, expectToast } from "./helpers";
import { platformTotpSecret, totp } from "./mfa";
import { PASSWORD } from "./users";

// Taviron staff and support access (SA1, 20261120008900): an Admin invites a Support team member from the console
// (password and code again); the invitee joins in three steps; a live company's owner lets Taviron in for a set time;
// staff go in with the owner's permissions, both sides see a banner, and the owner ends it.

/** A code for the next 30-second window, so it is never the one just used to sign in. */
async function freshCode(page: Page): Promise<string> {
  const now = Date.now();
  await page.waitForTimeout(30_000 - (now % 30_000) + 500);
  return totp(platformTotpSecret());
}

async function joinWithLink(browser: Browser, link: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Join the Taviron team" })).toBeVisible();
  await expect(page.getByText(/invited as Support/)).toBeVisible();
  await page.getByLabel("Choose a password").fill(PASSWORD);
  await page.getByLabel("Type it again").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => u.pathname === "/mfa");
  await page.getByRole("button", { name: "Set Up Authenticator App" }).click();
  const secret = await page.getByLabel("Or type this key").inputValue();
  await page.getByLabel("6-digit code from the app").fill(totp(secret));
  await page.getByRole("button", { name: "Turn On Two-Step Verification" }).click();
  await page.getByRole("button", { name: "Create Recovery Codes" }).click();
  await page.getByRole("button", { name: "I Saved Them, Continue" }).click();
  await page.waitForURL((u) => u.pathname === "/join-team");
  await page.getByRole("button", { name: "Join the Taviron team" }).click();
  await page.waitForURL((u) => u.pathname === "/staff");
  return { ctx, page };
}

test.describe.configure({ mode: "serial" });

test("invite a Support team member, the owner lets Taviron in, staff go in and the owner ends it", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const name = `Sam Support ${unique()}`;
  const email = `staff-${unique()}-${Date.now().toString(36)}@tavirontest.example`;

  // 1. The Admin invites from Administration.
  await signInPlatform(page);
  await page.goto("/admin/platform");
  const form = page.getByRole("form", { name: "Invite someone to the team" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Email").fill(email);
  await form.getByLabel(/^Support/).check();
  await form.getByLabel("Your password").fill(PASSWORD);
  // A wrong code changes nothing.
  await form.getByLabel("Your 6-digit code").fill("000000");
  await form.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(/That code is not correct/)).toBeVisible();
  await form.getByLabel("Your 6-digit code").fill(await freshCode(page));
  await form.getByRole("button", { name: "Send invitation" }).click();
  const linkBox = page.getByRole("status", { name: "Invitation link" });
  await expect(linkBox).toContainText(`Invitation for ${name} (Support)`);
  const link = (await linkBox.getByLabel("Invitation link", { exact: true }).textContent())!.trim();
  expect(link).toMatch(/\/join-team\?token=[0-9a-f]{64}$/);

  // 2. The invitee joins: password, authenticator app, join. Support sees the company access desk only.
  const staff = await joinWithLink(browser, link.replace(/^https?:\/\/[^/]+/, ""));
  const sp = staff.page;
  await expect(sp.getByRole("navigation", { name: "Platform" }).getByRole("link")).toHaveText(["Company access"]);
  await sp.goto("/admin");
  await sp.waitForURL((u) => u.pathname === "/staff");
  await sp.getByLabel("Company name").fill("Top Line");
  await sp.getByRole("button", { name: "Find" }).click();
  await sp.waitForURL((u) => u.search.includes("q=Top"));
  const row = sp.getByRole("table", { name: "Customer companies" }).getByRole("row", { name: /Top Line Trucking/ });
  await expect(row).toContainText("Not allowed");
  await expect(row).toContainText("Waiting for the owner");

  // 3. Top Line's owner gives access for 1 day.
  const ownerCtx = await browser.newContext();
  const op = await ownerCtx.newPage();
  await signIn(op, "owner");
  await op.goto("/settings?tab=support");
  await op.getByLabel("1 day").check();
  await op.getByRole("button", { name: "Give access" }).click();
  await expectToast(op, /can come in for 1 day/);

  // 4. Staff go in, with a reason; they see the banner and work with the owner's permissions.
  await sp.reload();
  await expect(row).toContainText("Allowed until");
  await row.getByLabel(/What are you helping Top Line Trucking with/).fill("Check a rate");
  await row.getByRole("button", { name: "Go in" }).click();
  await sp.waitForURL((u) => u.pathname === "/command-center");
  await expect(sp.getByRole("status", { name: "Taviron support visit" })).toContainText("You are in Top Line Trucking as Taviron support");
  await sp.goto("/settings?tab=permissions");
  await expect(sp.getByRole("heading", { name: /Roles and permissions/i }).first()).toBeVisible();

  // 5. The owner sees the banner and the visit, then ends access: staff are out at once.
  await op.goto("/settings?tab=support");
  await expect(op.getByRole("status", { name: "Taviron support is in your account" })).toBeVisible();
  await expect(op.getByRole("list", { name: "Taviron support visits" })).toContainText(`${name}: Check a rate`);
  op.once("dialog", (d) => d.accept());
  await op.getByRole("button", { name: "End access now" }).click();
  await expectToast(op, /access ended/);
  await sp.goto("/command-center");
  await sp.waitForURL((u) => u.pathname === "/staff");

  // 6. The Admin removes the team member again.
  await page.goto("/admin/platform");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("listitem", { name: `Team member ${name}` }).getByRole("button", { name: "Remove" }).click();
  await expectToast(page, /Removed from the team/);
  await ownerCtx.close();
  await staff.ctx.close();
});

test("an invitation link works once and a made-up one shows nothing", async ({ page }) => {
  await page.goto(`/join-team?token=${"0".repeat(64)}`);
  await expect(page.getByText(/This invitation link is not valid/)).toBeVisible();
  await page.goto("/join-team");
  await expect(page.getByText(/This invitation link is not valid/)).toBeVisible();
});
