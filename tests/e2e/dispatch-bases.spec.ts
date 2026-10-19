import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";
import { OTHER_COMPANY, USERS } from "./users";

// Settings → Dispatch Bases (migrations 20261120000100/000200): the plan limit shows and is enforced, a base can be
// added, edited, made default and deactivated without touching its records, and a person can be limited to a base.

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

test("a one-base plan shows its base and the limit; dispatch reads it without edit controls", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/settings?tab=bases");
  await expect(page.getByRole("heading", { name: "Dispatch Bases" })).toBeVisible();
  const table = page.getByRole("table", { name: "Dispatch bases" });
  await expect(table.getByRole("row").filter({ hasText: "MAIN" })).toContainText("Default");
  await expect(page.getByLabel("Plan allowance")).toHaveText(/1 of 1 active base included/);
  await expect(page.getByText("Base limit reached")).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, "dispatcher");
  await page.goto("/settings?tab=bases");
  await expect(page.getByRole("table", { name: "Dispatch bases" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);
  await expect(page.getByText("Add a Base")).toHaveCount(0);
});

test("on a two-base plan the owner adds, edits, makes default and deactivates a base; a third is refused by the database", async ({ page }) => {
  test.slow();
  const companyId = await admin(async (c) => {
    const id = (await c.query<{ id: string }>("select id from public.companies where slug = $1", [OTHER_COMPANY.slug])).rows[0].id;
    const v = (await c.query<{ id: string }>("select id from private.platform_plan_versions where plan_key = 'growth' order by version desc limit 1")).rows[0].id;
    await c.query("insert into private.company_lifecycle (company_id, plan_version_id) values ($1, $2) on conflict (company_id) do update set plan_version_id = excluded.plan_version_id", [id, v]);
    // A clean start: only the default base active.
    await c.query("update public.dispatch_bases set active = false where company_id = $1 and not is_default", [id]);
    return id;
  });
  const code = `N${unique().toUpperCase().slice(0, 5)}`;
  try {
    await signIn(page, "otherOwner");
    await page.goto("/settings?tab=bases");
    await expect(page.getByLabel("Plan allowance")).toHaveText(/1 of 2 active bases/);
    await page.getByText("Add a Base").click();
    await page.getByLabel("Name").last().fill(`North Yard ${code}`);
    await page.getByLabel("Code").last().fill(code);
    await page.getByLabel("City").last().fill("Fargo");
    await page.getByRole("button", { name: "Add Base" }).click();
    await expect(page.getByText("Base added.")).toBeVisible();
    const row = page.getByRole("table", { name: "Dispatch bases" }).getByRole("row").filter({ hasText: code });
    await expect(row).toContainText("Fargo");
    await expect(page.getByText("Base limit reached")).toBeVisible();

    // A third base is refused by the database too, not only hidden in the page.
    const refused = await admin((c) => c.query("insert into public.dispatch_bases (company_id, code, name) values ($1, 'THIRD', 'Third')", [companyId]).then(() => null, (e: { code: string }) => e.code));
    expect(refused).toBe("P0001");

    // Edit, make default, then deactivate is refused for the default; switch back and deactivate.
    await row.getByText("Edit").click();
    await row.getByLabel("Contact", { exact: true }).fill("Nia North");
    await row.getByRole("button", { name: "Save Base" }).click();
    await expect(page.getByText("Base saved.")).toBeVisible();
    await page.getByRole("table", { name: "Dispatch bases" }).getByRole("row").filter({ hasText: code }).getByRole("button", { name: "Make Default" }).click();
    await expect(page.getByText(/Default base changed/)).toBeVisible();
    await expect(page.getByRole("table", { name: "Dispatch bases" }).getByRole("row").filter({ hasText: code })).toContainText("Default");
    await page.getByRole("table", { name: "Dispatch bases" }).getByRole("row").filter({ hasText: "MAIN" }).getByRole("button", { name: "Make Default" }).click();
    await expect(page.getByText(/Default base changed/)).toBeVisible();

    // Base access: the section lists people (owners are never limited).
    const access = page.getByRole("table", { name: "Base access" });
    await expect(access).toBeVisible();
    await expect(access).not.toContainText(USERS.otherOwner.name);

    await page.getByRole("table", { name: "Dispatch bases" }).getByRole("row").filter({ hasText: code }).getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText(/Base deactivated/)).toBeVisible();
    await expect(page.getByLabel("Plan allowance")).toHaveText(/1 of 2 active bases/);
  } finally {
    await admin(async (c) => {
      await c.query("update public.dispatch_bases set is_default = false where company_id = $1 and code <> 'MAIN' and is_default", [companyId]);
      await c.query("update public.dispatch_bases set is_default = true where company_id = $1 and code = 'MAIN'", [companyId]);
      await c.query("update public.dispatch_bases set active = false where company_id = $1 and code <> 'MAIN'", [companyId]);
      await c.query("delete from private.company_lifecycle where company_id = $1", [companyId]);
    });
  }
});
