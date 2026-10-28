import { expect, test } from "@playwright/test";
import { driverFixture } from "./driver-fixture";
import { expectToast, signIn, unique } from "./helpers";

// Safety incidents (B103, migration 20261120004300): a driver reports from the phone with a photo; the office
// investigates, adds a corrective action, completes it and closes the incident; the driver sees only the status.

// A 1×1 JPEG.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

test("a driver reports an incident and the office investigates and closes it", async ({ page }) => {
  test.slow();
  await driverFixture();
  const id = unique();
  const description = `Mirror hit the gate post (e2e ${id})`;

  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "driver");
  await page.goto("/driver");
  await page.getByRole("link", { name: "Report a safety incident" }).click();
  await expect(page.getByRole("heading", { name: "Report a safety incident" })).toBeVisible();
  await page.getByRole("combobox", { name: "What happened", exact: true }).selectOption("accident");
  await page.getByLabel("How serious").selectOption("moderate");
  await page.getByLabel("Describe what happened").fill(description);
  await page.getByLabel("A vehicle was damaged").check();
  await page.locator("#photos").setInputFiles({ name: "gate.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await page.getByRole("button", { name: "Report incident" }).click();
  await expect(page.getByRole("status")).toContainText("Report sent");
  const mine = page.getByRole("list", { name: "My safety reports" }).getByRole("listitem").first();
  await expect(mine).toContainText("Accident");
  await expect(mine).toContainText("Reported");
  const number = (await mine.locator("span.tabular").first().textContent())!.trim();
  expect(number).toMatch(/^INC-\d+$/);
  // Drivers do not open the office's Safety page.
  await page.goto("/safety");
  await expect(page).toHaveURL(/\/driver\/safety/);

  // The office investigates.
  await page.context().clearCookies();
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page, "office");
  await page.goto("/safety");
  await page.getByRole("link", { name: number, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(number);
  await expect(page.getByText(description)).toBeVisible();
  await expect(page.getByRole("list", { name: "Photos" }).getByRole("img")).toHaveCount(1);
  await page.getByRole("button", { name: "Close incident" }).isDisabled();
  await page.getByLabel("Findings", { exact: true }).fill("Narrow gate on a new site (e2e)");
  await page.getByLabel("Root cause").fill("Site directions did not mention the gate");
  await page.getByRole("button", { name: "Save investigation" }).click();
  await expectToast(page, "Investigation saved.");
  await page.getByRole("textbox", { name: "Corrective action", exact: true }).fill("Add the gate width to the site directions (e2e)");
  await page.getByRole("button", { name: "Add action" }).click();
  await expectToast(page, "Corrective action added.");
  await expect(page.getByText("Every corrective action must be done before closing.")).toBeVisible();
  await page.getByRole("listitem", { name: "Add the gate width to the site directions (e2e)" }).getByRole("button", { name: "Mark done" }).click();
  await expectToast(page, "Action marked done.");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Site foreman (e2e)");
  await page.getByRole("button", { name: "Add witness" }).click();
  await expectToast(page, "Witness added.");
  await page.getByRole("button", { name: "Close incident" }).click();
  await expectToast(page, "Incident closed.");
  await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText("Corrective action done");

  // The driver sees it closed, and nothing of the investigation.
  await page.context().clearCookies();
  await signIn(page, "driver");
  await page.goto("/driver/safety");
  const row = page.getByRole("list", { name: "My safety reports" }).getByRole("listitem").filter({ hasText: number });
  await expect(row).toContainText("Closed");
  await expect(page.getByText("Narrow gate on a new site (e2e)")).toHaveCount(0);
});

test("a mechanic cannot open Safety", async ({ page }) => {
  await signIn(page, "mechanic");
  await page.goto("/safety");
  await expect(page).toHaveURL(/no-access/);
});
