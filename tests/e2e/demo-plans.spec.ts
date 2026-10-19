import { expect, test } from "@playwright/test";
import pg from "pg";

import { signInPlatform } from "./helpers";

// Demo Management → Plan Shown (20261120000300): the platform owner switches the Live Demo between plans; its bases
// follow (Growth = 2 active), and switching back to Essential leaves one. Demo companies only.

async function bases(companyName: string) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<{ code: string }>(
      "select b.code from public.dispatch_bases b join public.companies c on c.id = b.company_id where c.name = $1 and c.is_demo and c.active and c.demo_kind = 'presenter' and b.active order by b.code", [companyName])).rows.map((r) => r.code);
  } finally {
    await c.end();
  }
}

test("the platform owner shows the Live Demo as Growth, then Essential again", async ({ page }) => {
  await signInPlatform(page);
  await expect(page).toHaveURL(/\/admin$|\/command-center/);
  await page.goto("/admin/demo");
  const list = page.getByRole("list", { name: "Demo plans" });
  const live = list.getByRole("listitem").filter({ hasText: "Live Demo" }).first();
  test.skip(!(await live.count()), "No active Live Demo company in this database.");
  const name = (await live.locator("span.font-semibold").textContent())!.trim();
  try {
    await live.getByRole("combobox").selectOption("growth");
    await live.getByRole("button", { name: "Show This Plan" }).click();
    await expect(page.getByText(/Demo now shows the Growth plan/)).toBeVisible();
    expect(await bases(name)).toEqual(["MAIN", "NORTH"]);
  } finally {
    const again = page.getByRole("list", { name: "Demo plans" }).getByRole("listitem").filter({ hasText: name }).first();
    await again.getByRole("combobox").selectOption("essential");
    await again.getByRole("button", { name: "Show This Plan" }).click();
    await expect(page.getByText(/Demo now shows the Essential plan/)).toBeVisible();
  }
  expect(await bases(name)).toEqual(["MAIN"]);
});
