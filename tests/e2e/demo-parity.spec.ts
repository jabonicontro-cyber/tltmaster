import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";

// Demo tenants run the current product (docs/DEMO_TENANTS.md): a demo company's owner gets the same navigation
// as a standard company's owner, every page loads, the demo is marked as such, and it cannot send anything.
// Local stack only (creates a throwaway demo company and owner).

async function demoOwner() {
  const tag = unique();
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  let companyId: string;
  try {
    companyId = (await c.query<{ id: string }>("select private.create_company($1, $2) as id", [`Parity Demo ${tag}`, `prospect-parity${tag}`])).rows[0].id;
    await c.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [companyId]);
  } finally {
    await c.end();
  }
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const email = `e2e-parity-${tag}@demotest.example`;
  const password = `Pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Parity Owner" } });
  if (error) throw error;
  const c2 = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c2.connect();
  try {
    await c2.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [companyId, data.user.id]);
    await c2.query("update public.profiles set active_company_id = $1 where id = $2", [companyId, data.user.id]);
  } finally {
    await c2.end();
  }
  return { email, password };
}

const navHrefs = async (page: Page) =>
  (await page.getByRole("complementary", { name: "Sidebar" }).locator("a[href^='/']").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")))
    .filter((h, i, all) => all.indexOf(h) === i && h !== "/driver") // My Day depends on being a driver, not on being a demo
    .sort();

test("a demo company's owner has the same navigation and working pages as a standard company's owner", async ({ page, browser }) => {
  await signIn(page, "owner");
  await page.goto("/command-center");
  const standard = await navHrefs(page);
  expect(standard.length).toBeGreaterThan(10); // never compare two empty lists

  const owner = await demoOwner();
  const demo = await browser.newPage();
  await demo.goto("/login");
  await demo.getByLabel("Email or username").fill(owner.email);
  await demo.getByLabel("Password").fill(owner.password);
  await demo.getByRole("button", { name: "Sign in" }).click();
  await demo.waitForURL(/\/command-center/);
  await expect(demo.getByRole("region", { name: "Demo company" })).toContainText("nothing is sent outside Taviron");
  const inDemo = await navHrefs(demo);
  expect(inDemo).toEqual(standard);

  for (const href of inDemo) {
    await demo.goto(href);
    await expect(demo, href).not.toHaveURL(/no-access/);
    await expect(demo.getByText("This page could not be loaded"), href).toHaveCount(0);
  }

  // Nothing leaves a demo: invitations are refused.
  await demo.goto("/settings?tab=users");
  await demo.getByRole("button", { name: "Invite user" }).click();
  const dialog = demo.getByRole("dialog");
  await dialog.getByLabel("Email").fill(`someone-${unique()}@example.com`);
  await dialog.getByLabel("Name").fill("Someone Real");
  await dialog.getByRole("button", { name: /Invite|Send/ }).last().click();
  await expect(dialog.getByText("Invitations are turned off in the demo company")).toBeVisible();
  await demo.close();
});
