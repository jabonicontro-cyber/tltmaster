import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers";
import { USERS } from "./users";

// Settings → Security shows who has set up two-step verification (owner 2026-11-12, master plan §12 SEC4b; migration
// 20261120019900): people who manage users see each person's state and a count; anyone else who opens the page sees
// only which roles must use it.

const TOP_LINE = "00000000-0000-4000-8000-000000000001";

async function sql(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return await c.query(text, params);
  } finally {
    await c.end();
  }
}

test("the owner sees who has set up two-step verification, in plain words, with a count", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/settings?tab=security");
  const setUp = page.getByTestId("mfa-set-up");
  await expect(setUp.getByText("Who has set it up")).toBeVisible();
  await expect(page.getByTestId("mfa-set-up-summary")).toHaveText(/^\d+ of \d+ (people who must use two-step have|person who must use two-step has) set it up$/);
  const people = setUp.getByRole("list", { name: "Two-step verification by person" });
  // The office person has money access and set up an authenticator with saved recovery codes (global setup).
  const office = people.getByRole("listitem", { name: USERS.office.name });
  await expect(office).toContainText("Must use it: money access");
  await expect(office).toContainText("Set up");
  // The driver has no money access: not required (unless they chose it).
  await expect(people.getByRole("listitem", { name: USERS.driver.name })).toContainText(/Not required|Set up/);
  await expect(people.getByRole("listitem", { name: USERS.driver.name })).not.toContainText("Must use it");
  // Nothing technical: no factor types or names, assurance levels or codes (people are named as the people list
  // names them: their name, or their sign-in when they have no name).
  await expect(setUp).not.toContainText(/totp|factor|aal2|recovery code [A-Z0-9]/i);
  await expect(setUp).not.toContainText(/\b\d{6}\b/);
});

test("someone who may open Security but does not manage users sees the roles, not each person's state", async ({ page }) => {
  // Office staff are given company settings (not user management) for this test only.
  await sql("insert into public.role_permissions (company_id, role, permission) values ($1, 'office', 'settings.manage') on conflict do nothing", [TOP_LINE]);
  try {
    await signIn(page, "office");
    await page.goto("/settings?tab=security");
    await expect(page.getByTestId("mfa-who")).toBeVisible();
    await expect(page.getByTestId("mfa-set-up")).toHaveCount(0);
    await expect(page.getByText(USERS.driver.name)).toHaveCount(0);
  } finally {
    await sql("delete from public.role_permissions where company_id = $1 and role = 'office' and permission = 'settings.manage'", [TOP_LINE]);
  }
});
