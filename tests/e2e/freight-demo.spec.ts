import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { closeDemoWelcome, signInPlatform, unique } from "./helpers";
import { PREVIEW_COOKIE, PREVIEW_ROLES } from "@/lib/platform/preview";

// Freight demo company (MK3, owner 2026-11-05): the platform team creates "Cobalt Plains Freight" from /admin/demo, beside
// the aggregate demos. Its owner sees a general-freight carrier: bills of lading in the menu, loads with
// shipper-to-receiver stops on the board and the order, and every demo mode opens with data.

const NAME = "Cobalt Plains Freight";
const visit = async (page: Page, href: string) => {
  try { await page.goto(href); } catch (e) { if (!String(e).includes("ERR_ABORTED")) throw e; await page.goto(href); }
};

test("the platform team creates the freight demo and its owner sees a freight carrier in every demo mode", async ({ page, browser }) => {
  test.setTimeout(900_000);
  await signInPlatform(page);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  // A fresh one each run: retire an earlier freight demo first (nothing is deleted).
  await page.goto("/admin/demo");
  const old = page.locator("li").filter({ hasText: NAME }).filter({ has: page.getByRole("button", { name: "Retire" }) });
  for (let i = 0; i < 10 && (await old.count()); i++) {
    await old.first().getByRole("checkbox").check();
    await old.first().getByRole("button", { name: "Retire" }).click();
    await page.waitForLoadState("load");
    await page.goto("/admin/demo");
  }
  await expect(old, "earlier freight demos could not be retired").toHaveCount(0);
  await page.getByRole("button", { name: `Create the ${NAME} demo` }).click();
  await page.waitForURL(/command-center/, { timeout: 300_000 });

  // Its owner, added the way scripts/platform-admin.mjs demo-owner does (service role), linked to the Owner record.
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: co } = await admin.from("companies").select("id").eq("name", NAME).eq("active", true).single();
  const email = `e2e-freight-${unique()}@demotest.example`;
  const password = `Pw-${randomUUID()}`;
  const { data: u, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const added = await admin.rpc("platform_prospect_demo_add_owner", { p_company: co!.id, p_user: u.user.id, p_full_name: "Dana Whitaker" });
  if (added.error) throw added.error;
  // Refresh gives the owner their driver day (shared samples) and adds nothing else on the same day.
  await page.goto("/admin/demo");
  await page.locator("li").filter({ hasText: NAME }).getByRole("button", { name: "Refresh demo data" }).first().click();
  await page.waitForURL(/saved=refreshed/, { timeout: 240_000 });

  const owner = await browser.newPage();
  await owner.goto("/login");
  await owner.getByLabel("Email or username").fill(email);
  await owner.getByLabel("Password").fill(password);
  await owner.getByRole("button", { name: "Sign in" }).click();
  await owner.waitForURL(/command-center/);
  await closeDemoWelcome(owner);

  // General freight: bills of lading everywhere the delivery documents are named.
  const menu = owner.getByRole("navigation", { name: "Main" }).first();
  await expect(menu.getByRole("link", { name: "Bills of Lading" })).toBeVisible();
  await visit(owner, "/tickets");
  await expect(owner.getByRole("heading", { level: 1, name: "Bills of Lading" })).toBeVisible();
  // The board shows routes instead of job sites, and an order lists its stops in order with references.
  await visit(owner, "/dispatch");
  await expect(owner.getByText(/^Stops:/).first()).toBeAttached();
  await visit(owner, `/orders?q=${encodeURIComponent("two drops")}`);
  await owner.getByRole("link", { name: /^ORD-|^O-/ }).first().click();
  const stops = owner.getByRole("list", { name: "Stops" });
  await expect(stops.getByRole("listitem")).toHaveCount(3);
  await expect(stops.getByRole("listitem").first()).toContainText("Marrow Creek Building Products");
  await expect(stops.getByRole("listitem").first()).toContainText(/Ref PU-/);
  await expect(owner.getByText("1 pickup, 2 deliveries, in the order the truck makes them.")).toBeVisible();

  // Tailored to freight (MK4): the menu, Command Center, fleet and places speak freight; no dump bodies or quarries.
  await expect(menu.getByRole("link", { name: "Rates & Charges" })).toBeVisible();
  await visit(owner, "/command-center");
  await expect(owner.getByText(/Missing bills of lading|BOLs to review/).first()).toBeVisible();
  await expect(owner.getByText(/delivery ticket/i)).toHaveCount(0);
  await visit(owner, "/fleet/trucks/new");
  const types = await owner.getByLabel("Type").locator("option").allTextContents();
  expect(types).toEqual(expect.arrayContaining(["Tractor (semi)", "Straight truck (box)"]));
  expect(types.join(" ")).not.toMatch(/dump/i);
  await expect(owner.getByLabel("Body volume (cubic yards)")).toHaveCount(0);
  await visit(owner, "/fleet/trailers");
  await expect(owner.getByRole("cell", { name: "Reefer (refrigerated)" })).toBeVisible();
  await expect(owner.getByRole("cell", { name: /dump/i })).toHaveCount(0);
  await visit(owner, "/dispatch?view=locations");
  await expect(owner.getByText("Ridgeway Distribution Center (fictional)").first()).toBeVisible();
  await expect(owner.getByText(/quarr|gravel pit/i)).toHaveCount(0);
  await visit(owner, "/quotes/new");
  await expect(owner.getByRole("button", { name: "Add linehaul / accessorial" })).toBeVisible();

  // Every demo mode opens its pages with data; drivers see bills of lading on My Day.
  const ctx = owner.context();
  try {
    for (const role of PREVIEW_ROLES) {
      await ctx.addCookies([{ name: PREVIEW_COOKIE, value: role, url: owner.url() }]);
      await visit(owner, "/command-center");
      // Read once the page has settled (a redirect or refresh can replace it mid-read).
      let hrefs: string[] = [];
      await expect(async () => {
        await owner.waitForLoadState("networkidle");
        hrefs = await owner.getByRole("navigation", { name: "Main" }).first().locator("a[href^='/']").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
        expect(hrefs.length).toBeGreaterThan(0);
      }).toPass({ timeout: 30_000 });
      for (const href of [...new Set(hrefs)]) {
        await visit(owner, href);
        await expect(owner.getByText("This page could not be loaded"), `${role} ${href}`).toHaveCount(0);
        await expect(owner.getByRole("heading", { level: 1 }).first(), `${role} ${href}`).toBeVisible();
      }
      if (hrefs.includes("/dispatch")) {
        await visit(owner, "/dispatch?view=timeline");
        await expect(owner.getByRole("table", { name: "Trucks by hour" }).getByRole("button").first(), `${role} timeline has loads`).toBeVisible();
      }
      if (role === "driver" || role === "multi") {
        await visit(owner, "/driver");
        await expect(owner.getByText(/\bload \d/i).first(), `${role} My Day has loads`).toBeVisible();
        await expect(owner.getByText(/bill of lading|BOLs/i).first(), `${role} My Day says bills of lading`).toBeVisible();
      }
    }
  } finally {
    await ctx.clearCookies({ name: PREVIEW_COOKIE });
  }
});
