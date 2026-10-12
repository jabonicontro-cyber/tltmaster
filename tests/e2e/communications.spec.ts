import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Communications: direct messages with a private attachment, read state,
// announcements with acknowledgment, alerts and settings, and the workspace
// recipient preview. Fictional data only; nothing is emailed or texted.

const pdf = () => Buffer.from("%PDF-1.4\n% e2e test file\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n");

test("a dispatcher messages a driver with a file; the driver reads it and replies", async ({ page, browser }) => {
  const text = `Use the north gate today (${unique()})`;
  await signIn(page, "dispatcher");
  await page.goto("/communications");
  await expect(page.getByRole("heading", { name: "Communications", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New message" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Search people").fill(USERS.driver.name);
  await dialog.getByRole("option", { name: new RegExp(USERS.driver.name) }).click();
  await dialog.getByRole("button", { name: "Open conversation" }).click();
  await page.waitForURL(/\/communications\/c\/[0-9a-f-]{36}$/);
  const url = page.url();

  await page.locator("#comm-file").setInputFiles({ name: "site-map.pdf", mimeType: "application/pdf", buffer: pdf() });
  const files = page.getByRole("list", { name: "Files to send" });
  await expect(files).toContainText("site-map.pdf");
  await expect(files).not.toContainText("Uploading");
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  const messages = page.getByRole("list", { name: "Messages" });
  await expect(messages.getByText(text)).toBeVisible();
  // The direct conversation is reused across runs: look only at this message.
  const sent = messages.locator('li[id^="m-"]').filter({ hasText: text });
  await expect(sent.getByRole("link", { name: /site-map\.pdf/ })).toBeVisible();

  // The file is served only through the access-checked route (a short-lived signed redirect).
  const fileHref = await sent.getByRole("link", { name: /site-map\.pdf/ }).getAttribute("href");
  expect(fileHref).toMatch(/^\/communications\/files\/[0-9a-f-]{36}$/);
  const direct = await page.request.get(fileHref!, { maxRedirects: 0 });
  expect(direct.status()).toBe(302);

  const driver = await browser.newPage();
  await signIn(driver, "driver");
  await driver.goto("/communications");
  await expect(driver.getByRole("link", { name: new RegExp(USERS.dispatcher.name) }).first()).toBeVisible();
  await driver.goto(url);
  await expect(driver.getByText(text)).toBeVisible();
  const reply = `On my way ${unique()}`;
  await driver.getByLabel("Message", { exact: true }).fill(reply);
  await driver.keyboard.press("Enter");
  await expect(driver.getByRole("list", { name: "Messages" }).getByText(reply)).toBeVisible();

  // Another company cannot open the file or the conversation.
  const outsider = await browser.newPage();
  await signIn(outsider, "otherOwner");
  expect((await outsider.request.get(fileHref!, { maxRedirects: 0 })).status()).toBe(404);
  await outsider.goto(url);
  await expect(outsider.getByText("Not found", { exact: true })).toBeVisible();
  await expect(outsider.getByText(text)).toHaveCount(0);
  await Promise.all([driver.close(), outsider.close()]);

  // The dispatcher sees the reply and the read receipt after the page refreshes.
  await page.reload();
  await expect(page.getByRole("list", { name: "Messages" }).getByText(reply)).toBeVisible();
  await expect(sent.getByText("Read", { exact: true })).toBeVisible();
});

test("an announcement that needs acknowledgment is acknowledged and the publisher sees it", async ({ page, browser }) => {
  const title = `Yard safety briefing ${unique()}`;
  await signIn(page, "owner");
  await page.goto("/communications/announcements");
  await page.getByRole("button", { name: "New announcement" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Announcement").fill("Wear high-visibility vests in the yard at all times.");
  await dialog.getByLabel(/Everyone must acknowledge it/).check();
  await dialog.getByRole("button", { name: "Publish" }).click();
  await page.waitForURL(/\/communications\/announcements\/[0-9a-f-]{36}$/);
  await expectToast(page, /No email or text message is sent/);
  const url = page.url();

  const office = await browser.newPage();
  await signIn(office, "office");
  await office.goto("/communications/announcements");
  await expect(office.getByRole("link", { name: new RegExp(title) })).toContainText("Acknowledge");
  await office.goto(url);
  await office.getByRole("button", { name: "I have read and understood this" }).click();
  await expect(office.getByText(/You acknowledged this on/)).toBeVisible();
  await office.close();

  await page.reload();
  await expect(page.getByText(/acknowledged; \d+ opened it/)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: USERS.office.name })).toContainText("Acknowledged");
});

test("alerts, settings and the workspace preview respect safety rules and permissions", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/communications/alerts?status=all");
  await expect(page.getByRole("heading", { name: "Alerts", level: 1 })).toBeVisible();

  await page.goto("/communications/settings");
  await expect(page.getByRole("heading", { name: "Alert policies" })).toBeVisible();
  // Safety alerts cannot be turned off, and the minimum priority is the only floor offered.
  await expect(page.getByLabel(/safety alert — cannot be turned off/)).toBeDisabled();
  await expect(page.locator("#ap-maintenance\\.safety_restriction option")).toHaveCount(1);
  // Retention below 30 days is refused before anything is saved.
  const retention = page.getByLabel("Delete messages older than (days)");
  await retention.fill("10");
  await page.getByRole("button", { name: "Save settings" }).click();
  expect(await retention.evaluate((el) => (el as HTMLInputElement).checkValidity())).toBe(false);

  await page.goto("/communications/workspaces/new");
  await page.getByLabel("Selected loads").check();
  await page.getByRole("button", { name: "Preview recipients" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Choose at least one load/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create workspace" })).toBeDisabled();
});

test("drivers cannot open administrative settings or create workspaces", async ({ page }) => {
  await signIn(page, "driver");
  await page.goto("/communications/settings");
  await expect(page.getByRole("heading", { name: "My notifications" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Company rules" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Administrative search" })).toHaveCount(0);
  await page.goto("/communications");
  await expect(page.getByRole("link", { name: "New workspace" })).toHaveCount(0);
});
