import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// An owner links an existing login to an employee record (and unlinks it). Local stack only.

async function fixture() {
  const tag = unique();
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  const userId = randomUUID();
  const email = `e2e-link-${tag}@toplinetest.example`;
  try {
    const company = (await c.query<{ id: string }>("select id from public.companies where slug = 'top-line-trucking'")).rows[0].id;
    await c.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [userId, email]);
    await c.query("update public.profiles set full_name = $2 where id = $1", [userId, `Linky ${tag}`]);
    await c.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'office', true)", [company, userId]);
  } finally {
    await c.end();
  }
  const empId = await asUser(USERS.owner.email, async (q) =>
    (await q("insert into public.employees (full_name, job_title, department) values ($1, 'Office assistant', 'office') returning id", [`Linky ${tag}`])).rows[0].id as string);
  return { tag, userId, empId };
}

test("an owner links an existing login to an employee record and can unlink it", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "owner");
  await page.goto(`/employees/${f.empId}`);
  await expect(page.getByText("No login linked.")).toBeVisible();
  await page.getByLabel("Link an existing login").selectOption({ label: `Linky ${f.tag} — e2e-link-${f.tag}@toplinetest.example` });
  await page.getByRole("button", { name: "Link login" }).click();
  await expectToast(page, "Login linked.");
  await expect(page.getByText(/Has a login · role/)).toBeVisible();
  // The same login is no longer offered for another employee.
  await page.getByRole("button", { name: "Unlink login" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Unlink" }).click();
  await expectToast(page, "Login unlinked.");
  await expect(page.getByText("No login linked.")).toBeVisible();
});

test("people without user management cannot link logins", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "office");
  await page.goto(`/employees/${f.empId}`);
  await expect(page.getByLabel("Link an existing login")).toHaveCount(0);
});
