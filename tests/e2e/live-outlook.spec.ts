import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Taviron Live (Command Center "Next 7 days"): read from dispatch, the shop schedule and time off; shown to people who
// see dispatch, with estimated value only for people who also see billing.

test("dispatch sees the next 7 days day by day, and a day opens that day's board", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/command-center");
  const days = page.getByRole("list", { name: "Day by day" });
  await expect(days.getByRole("listitem")).toHaveCount(7);
  await expect(page.getByLabel("Outlook summary")).toContainText("loads planned");
  // A dispatcher does not see estimated revenue.
  await expect(page.getByText("of work not yet covered")).toHaveCount(0);
  const first = days.getByRole("link").first();
  await expect(first).toHaveAttribute("aria-label", /^Today: \d+ loads, \d+ without a truck, \d+ trucks ready, \d+ drivers available/);
  await first.click();
  await expect(page).toHaveURL(/\/dispatch\?date=\d{4}-\d{2}-\d{2}/);
});

test("people without dispatch do not get the outlook", async ({ page }) => {
  await signIn(page, "mechanic");
  await page.goto("/command-center");
  await expect(page.getByRole("list", { name: "Day by day" })).toHaveCount(0);
});
