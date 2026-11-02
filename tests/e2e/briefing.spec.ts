import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Morning briefing (B116): an owner sees yesterday's results, today's picture and a ranked "Do these first" list whose
// buttons open real pages; a driver never sees the briefing. Read-only.

test("an owner's morning briefing ranks what to do first, with working links", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/briefing");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening)/);
  await expect(page.getByText("Loads today")).toBeVisible();
  const first = page.getByRole("list", { name: "Do these first" });
  if (await first.count()) {
    const link = first.getByRole("link").first();
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\//);
    await link.click();
    await expect(page).not.toHaveURL(/\/briefing$/);
    await expect(page.getByText("This page could not be loaded")).toHaveCount(0);
  } else {
    await expect(page.getByText("Nothing needs you right now")).toBeVisible();
  }
});

test("drivers do not get the briefing", async ({ page }) => {
  await signIn(page, "driver");
  await page.goto("/briefing");
  await expect(page).not.toHaveURL(/\/briefing$/);
});
