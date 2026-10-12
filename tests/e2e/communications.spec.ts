import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { asUser } from "./db";
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
  // The edit window and message retention are fixed policies, not settings.
  await expect(page.getByText(/authors can edit or delete a message for 5 minutes/)).toBeVisible();
  await expect(page.getByText(/removed\s+14 days after it was sent unless legal hold is on/)).toBeVisible();
  await expect(page.getByLabel("Delete messages older than (days)")).toHaveCount(0);
  await expect(page.getByLabel("Edit and delete window (minutes)")).toHaveCount(0);

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

test("authors edit and delete within 5 minutes; replies collapse; presence shows on the profile picture", async ({ page }) => {
  const text = `Dock 4 is closed (${unique()})`;
  await signIn(page, "dispatcher");
  await page.goto("/communications");
  await page.getByRole("button", { name: "New message" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Search people").fill(USERS.driver.name);
  await dialog.getByRole("option", { name: new RegExp(USERS.driver.name) }).click();
  await dialog.getByRole("button", { name: "Open conversation" }).click();
  await page.waitForURL(/\/communications\/c\/[0-9a-f-]{36}$/);
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  const messages = page.getByRole("list", { name: "Messages" });
  const sent = messages.locator('li[id^="m-"]').filter({ hasText: text });
  await expect(sent).toBeVisible();

  // Reply, then collapse and expand the thread.
  await sent.getByRole("button", { name: "Reply" }).click();
  await page.getByLabel("Message", { exact: true }).fill("Use dock 5 instead");
  await page.getByRole("button", { name: "Send" }).click();
  const thread = messages.locator(`li:has(> ul > #${await sent.getAttribute("id")})`);
  await expect(thread.getByRole("list", { name: "Replies" })).toContainText("Use dock 5 instead");
  await thread.getByRole("button", { name: "Hide replies" }).click();
  await expect(thread.getByRole("list", { name: "Replies" })).toHaveCount(0);
  await thread.getByRole("button", { name: "Show 1 reply" }).click();
  await expect(thread.getByRole("list", { name: "Replies" })).toContainText("Use dock 5 instead");

  // Edit: marked Edited. Delete: a tombstone remains.
  await sent.getByRole("button", { name: "Edit" }).click();
  await sent.getByLabel("Edit message").fill(`${text} until noon`);
  await sent.getByRole("button", { name: "Save" }).click();
  const edited = messages.locator('li[id^="m-"]').filter({ hasText: `${text} until noon` });
  await expect(edited.getByText("Edited", { exact: true })).toBeVisible();
  const id = await edited.getAttribute("id");
  await edited.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(`#${id}`).getByText("Message deleted")).toBeVisible();
  await expect(page.getByText(`${text} until noon`)).toHaveCount(0);

  // Busy is red on the user's own profile picture.
  await page.goto("/communications");
  await page.getByLabel("My status").selectOption("busy");
  const dot = page.getByRole("banner").getByRole("img", { name: "Busy" });
  await expect(async () => {
    await page.reload();
    await expect(dot).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(dot).toHaveClass(/bg-red-600/);
  await page.getByLabel("My status").selectOption("");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("Communications fits the screen width (no sideways scrolling)", async ({ page }) => {
    await signIn(page, "owner");
    await page.goto("/communications");
    await expect(page.getByRole("heading", { name: "Communications", level: 1 })).toBeVisible();
    const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: document.documentElement.clientWidth }));
    expect(sw).toBeLessThanOrEqual(w);
  });
});

test("a new channel message counts on the Channels tab, not on Messages", async ({ page }) => {
  const title = `Yard notes ${unique()}`;
  await asUser(USERS.owner.email, async (q) => {
    const driver = (await q("select id from public.profiles where email = $1", [USERS.driver.email])).rows[0].id as string;
    const ch = (await q("select public.comm_create_channel($1, '', 'operations', false, $2::uuid[]) as id", [title, [driver]])).rows[0].id as string;
    await q("select public.comm_send($1, 'Gate 3 is closed today')", [ch]);
  });
  await signIn(page, "driver");
  await page.goto("/communications");
  const tabs = page.getByRole("navigation", { name: "Communications sections" });
  await expect(tabs.getByRole("link", { name: /Channels\s*\d+\s*unread/ })).toBeVisible();
  // The Messages badge only counts conversations listed under Messages.
  await page.goto("/communications/channels");
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page.getByText("Gate 3 is closed today")).toBeVisible();
  await page.goto("/communications/channels");
  await expect(page.getByRole("link", { name: new RegExp(title) })).not.toContainText("unread");
});
