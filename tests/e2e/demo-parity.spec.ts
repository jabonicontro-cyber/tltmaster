import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { closeDemoWelcome, signIn, unique, signInPlatform } from "./helpers";

import { PREVIEW_COOKIE, PREVIEW_ROLES } from "@/lib/platform/preview";

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

/** Go to a page; a navigation superseded by a redirect or a background refresh (ERR_ABORTED) is retried once. */
/** Is the guided onboarding update (20261120001000) installed on this database? */
async function onboardingInstalled(): Promise<boolean> {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return Boolean((await c.query<{ ok: boolean }>("select to_regclass('public.onboarding_tasks') is not null as ok")).rows[0]?.ok);
  } finally {
    await c.end();
  }
}

const visit = async (page: Page, href: string) => {
  try { await page.goto(href); } catch (e) { if (!String(e).includes("ERR_ABORTED")) throw e; await page.goto(href); }
};

/**
 * The sidebar's destinations, read once the page has settled: the dev server can reload a page it has just compiled,
 * which destroys the page mid-read. The pages themselves are still opened and checked one by one by each test.
 */
const sidebarHrefs = async (page: Page): Promise<string[]> => {
  let hrefs: string[] = [];
  await expect(async () => {
    await page.waitForLoadState("networkidle");
    hrefs = (await page.getByRole("complementary", { name: "Sidebar" }).locator("a[href^='/']").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")))
      .filter((h, i, all) => all.indexOf(h) === i);
    expect(hrefs.length).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
  return hrefs;
};

const navHrefs = async (page: Page) =>
  (await sidebarHrefs(page)).filter((h) => h !== "/driver").sort(); // My Day depends on being a driver, not on being a demo

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
  await expect(demo.getByRole("dialog", { name: "Welcome to the Taviron demo" })).toContainText("nothing is sent outside Taviron");
  await closeDemoWelcome(demo);
  await expect(demo.getByRole("banner")).toContainText("Demo"); // still marked as a demo, unobtrusively
  const inDemo = await navHrefs(demo);
  expect(inDemo).toEqual(standard);

  for (const href of inDemo) {
    await demo.goto(href);
    await expect(demo, href).not.toHaveURL(/no-access/);
    await expect(demo.getByText("This page could not be loaded"), href).toHaveCount(0);
  }

  // Communications runs with the same policies as any company (5-minute window, 14-day retention).
  await demo.goto("/communications/settings");
  await expect(demo.getByText(/authors can edit or delete a message for 5 minutes/)).toBeVisible();

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

// Demo feature parity (CLAUDE.md, docs/DEMO_TENANTS.md §3): in a seeded demo, every demo mode (role preview) opens
// every page of its navigation without an error, and each feature's page shows sample data in every mode whose
// role can use it — not only the Owner view.
test("every demo mode opens its pages and each feature shows sample data", async ({ page, context }) => {
  test.setTimeout(600_000);
  await signInPlatform(page);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.goto("/admin/demo");
  await page.getByRole("button", { name: /Start the demo|Reset: start a fresh demo/ }).click();
  await page.waitForURL(/command-center/, { timeout: 240_000 });
  // The presenter demo refreshes like a prospect demo (northfield-refresh.ts): additive, and a second run adds no loads.
  await page.goto("/admin/demo");
  await page.getByRole("button", { name: "Refresh demo data" }).first().click();
  await page.waitForURL(/saved=refreshed/, { timeout: 240_000 });
  // A second run adds nothing.
  await page.getByRole("button", { name: "Refresh demo data" }).first().click();
  await page.waitForURL(/saved=refreshed&loads=0&added=0/, { timeout: 240_000 });
  await expect(page.getByText(/already up to date/)).toBeVisible();
  await page.goto("/command-center");
  await closeDemoWelcome(page);
  // Northfield matches Prairie Lantern's fleet: tractors with end-dump and belly-dump trailers.
  await visit(page, "/fleet/trailers");
  await expect(page.getByRole("link", { name: /E-21/ }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /B-31/ }).first()).toBeVisible();

  // Feature pages that must not be empty, for the modes whose role can open them.
  const filled: Record<string, RegExp> = {
    "/maintenance": /No open work orders/,
    "/time-off": /No requests yet/,
    "/quotes": /No quotes yet/,
    "/communications": /No conversations yet/,
    "/route-planner": /No assigned loads on this day/,
  };
  try {
    for (const role of PREVIEW_ROLES) {
      await context.addCookies([{ name: PREVIEW_COOKIE, value: role, url: page.url() }]);
      await visit(page, "/command-center");
      const nav = await sidebarHrefs(page);
      expect(nav.length, role).toBeGreaterThan(2);
      for (const href of nav) {
        await visit(page, href);
        await expect(page.getByText("This page could not be loaded"), `${role} ${href}`).toHaveCount(0);
        await expect(page.getByRole("heading", { level: 1 }).first(), `${role} ${href}`).toBeVisible();
        const empty = filled[href];
        if (empty) await expect(page.getByText(empty), `${role} ${href} has sample data`).toHaveCount(0);
      }
      // Time-off balances (20261112000100): the owner mode manages a real bank with balances and history.
      if (role === "owner") {
        await visit(page, "/time-off/balances");
        // Before the hosted database update the page says so (the normal "not available yet" state, DEMO_TENANTS §2).
        if (!(await page.getByText("Not available yet").isVisible())) {
          await expect(page.getByRole("row").filter({ hasText: "Paid time off" }).first(), "owner balances").toBeVisible();
          await expect(page.getByText("No balances to show"), "owner balances").toHaveCount(0);
        }
        // Guided onboarding (20261120001000, samples.ts guidedOnboarding): a mid-onboarding checklist in varied states.
        // Before that database update the section is absent (the normal state, DEMO_TENANTS §2).
        await visit(page, "/setup");
        if (await onboardingInstalled()) {
          await expect(page.getByRole("heading", { name: "Onboarding with Taviron" }), "owner onboarding checklist").toBeVisible();
          for (const state of ["Changes requested", "Submitted for review", "Blocked", "Awaiting customer", "Approved"]) {
            await expect(page.getByText(state, { exact: true }).first(), `onboarding state ${state}`).toBeVisible();
          }
        }
      }
      // The mechanic's phone workspace: My jobs lists the demo owner's own jobs, with the mechanic tab bar on a phone.
      if (role === "mechanic") {
        await visit(page, "/maintenance/my-jobs");
        await expect(page.getByText("No jobs for you right now"), "mechanic My jobs has jobs").toHaveCount(0);
        await expect(page.getByRole("link", { name: /^Open MWO-/ }).first(), "mechanic My jobs").toBeVisible();
      }
      // Modes that drive see a day with loads on My Day.
      if (role === "driver" || role === "multi") {
        await visit(page, "/driver");
        await expect(page.getByText(/\bload \d/i).first(), `${role} My Day has loads`).toBeVisible();
      }
    }
  } finally {
    await context.clearCookies({ name: PREVIEW_COOKIE });
  }
});

// The same in a prospect demo, seen by its owner: created and refreshed the operator's way (/admin/demo), the owner
// added as `demo-owner` does. Refresh gives the existing demo the shared samples, including the owner's driver day.
test("a prospect demo's owner sees sample data in every demo mode after Refresh", async ({ page, browser, context }) => {
  test.setTimeout(900_000);
  await signInPlatform(page);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  // A fresh Prairie Lantern demo (retire an earlier one first: its owner record is already linked).
  await page.goto("/admin/demo");
  const old = page.locator("li").filter({ hasText: "Prairie Lantern Freight" }).filter({ has: page.getByRole("button", { name: "Retire" }) });
  // Bounded: a retire that silently does nothing must fail here with a message, not spin until the test times out.
  for (let i = 0; i < 10 && (await old.count()); i++) {
    await old.first().getByRole("checkbox").check();
    await old.first().getByRole("button", { name: "Retire" }).click();
    await page.waitForLoadState("load");
    await page.goto("/admin/demo");
  }
  await expect(old, "earlier Prairie Lantern demos could not be retired").toHaveCount(0);
  await page.getByRole("button", { name: /Create the Prairie Lantern Freight demo/ }).click();
  await page.waitForURL(/command-center/, { timeout: 240_000 });

  // The prospect owner, added the way scripts/platform-admin.mjs demo-owner does (service role).
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: co } = await admin.from("companies").select("id").eq("name", "Prairie Lantern Freight").eq("active", true).single();
  const email = `e2e-prospect-${unique()}@demotest.example`;
  const password = `Pw-${randomUUID()}`;
  const { data: u, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const added = await admin.rpc("platform_prospect_demo_add_owner", { p_company: co!.id, p_user: u.user.id, p_full_name: "Colby Chapman" });
  if (added.error) throw added.error;

  // Existing demo receives the samples through Refresh.
  await page.goto("/admin/demo");
  await page.locator("li").filter({ hasText: "Prairie Lantern Freight" }).getByRole("button", { name: "Refresh demo data" }).first().click();
  await page.waitForURL(/saved=refreshed/, { timeout: 240_000 });

  const owner = await browser.newPage();
  await owner.goto("/login");
  await owner.getByLabel("Email or username").fill(email);
  await owner.getByLabel("Password").fill(password);
  await owner.getByRole("button", { name: "Sign in" }).click();
  await owner.waitForURL(/command-center/);
  await closeDemoWelcome(owner);
  // Plan the day works for a tractor fleet: each tractor is planned with a trailer.
  await visit(owner, "/dispatch/plan");
  await expect(owner.getByRole("region", { name: /Proposed assignments/ })).toContainText("+ trailer");
  // Truck 207 is out of service in the Prairie Lantern sample fleet: listed as unavailable all day, with the reason.
  await expect(owner.getByRole("region", { name: /Unavailable resources/ })).toContainText(/Truck 207 — Out of service/);
  // Smart Dispatch proposes tractors with a trailer (all-tractor fleet; the 2026-10-14 fix).
  await visit(owner, "/dispatch?horizon=7");
  const smart = owner.getByRole("group", { name: "Smart Dispatch" }).or(owner.locator('[aria-label="Smart Dispatch"]'));
  if (await smart.getByText(/unassigned load/).count()) await expect(smart.getByText(/Proposed:/).first()).toBeVisible();
  // Billing shows every state in a demo: an order ready to bill and one handed off (samples.ts billing()).
  await visit(owner, "/billing");
  const views = owner.getByRole("navigation", { name: "Billing views" });
  await expect(views.getByRole("link", { name: /Ready to bill\s*\d/ })).toBeVisible();
  await expect(views.getByRole("link", { name: /Handed off\s*\d/ })).toBeVisible();
  // Site directions verification (samples.ts siteDirections): a safety/access critical site nobody verified is flagged.
  const { data: flagged } = await admin.from("customer_sites").select("customer_id").eq("company_id", co!.id).eq("directions_risk", "safety_access").is("directions_verified_at", null).limit(1).single();
  await visit(owner, `/customers/${flagged!.customer_id}`);
  await expect(owner.getByText("Directions not verified").first()).toBeVisible();
  await expect(owner.getByText("Safety or access critical").first()).toBeVisible();
  // Colby's own touches (prairie-lantern-colby.ts): the Southfield lane and his friend Cam Webster as a driver.
  await visit(owner, `/orders?q=${encodeURIComponent("Southfield Crossing")}`);
  await expect(owner.getByText("Southfield Crossing Distribution").first()).toBeVisible();
  await visit(owner, "/employees?q=Cam");
  await expect(owner.getByText("Cam Webster").first()).toBeVisible();
  const filled: Record<string, RegExp> = { "/maintenance": /No open work orders/, "/time-off": /No requests yet/, "/quotes": /No quotes yet/, "/communications": /No conversations yet/, "/route-planner": /No assigned loads on this day/ };
  const ownerContext = owner.context();
  try {
    for (const role of PREVIEW_ROLES) {
      await ownerContext.addCookies([{ name: PREVIEW_COOKIE, value: role, url: owner.url() }]);
      await visit(owner, "/command-center");
      const nav = await sidebarHrefs(owner);
      for (const href of nav) {
        await visit(owner, href);
        await expect(owner.getByText("This page could not be loaded"), `${role} ${href}`).toHaveCount(0);
        const empty = filled[href];
        if (empty) await expect(owner.getByText(empty), `${role} ${href} has sample data`).toHaveCount(0);
      }
      if (role === "driver" || role === "multi") {
        await visit(owner, "/driver");
        await expect(owner.getByText(/\bload \d/i).first(), `${role} My Day has loads`).toBeVisible();
        await expect(owner.getByText(/Last checked by the office|Not checked by the office yet/), `${role} My Day shows site directions status`).not.toHaveCount(0);
      }
    }
  } finally {
    await ownerContext.clearCookies({ name: PREVIEW_COOKIE });
    await owner.close();
    await context.clearCookies({ name: PREVIEW_COOKIE });
  }
});
