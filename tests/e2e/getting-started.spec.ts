import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers";
import { USERS } from "./users";

// Getting started (first days, per role): the checklist sits on each role's landing page, ticks steps from recorded
// data, the owner's includes the company phone prompt when Settings has no phone, and "Hide" puts it away for that
// person only (remembered on the account, migration 20261120014100). Never in presentation mode.

const TOP_LINE = "00000000-0000-4000-8000-000000000001";

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

const userId = async (key: keyof typeof USERS) => (await sql<{ id: string }>("select id from auth.users where email = $1", [USERS[key].email]))[0].id;
const reset = async (key: keyof typeof USERS) => sql("delete from public.user_preferences where company_id = $1 and user_id = $2 and key = 'getting_started'", [TOP_LINE, await userId(key)]);

test.describe.configure({ mode: "serial" });

test("owner: the phone prompt links to the phone field; Hide puts it away for this owner only", async ({ page }) => {
  await reset("owner");
  const phone = (await sql<{ phone: string }>("select coalesce(phone, '') phone from public.company_settings where company_id = $1", [TOP_LINE]))[0]?.phone ?? "";
  await sql("update public.company_settings set phone = '' where company_id = $1", [TOP_LINE]);
  try {
    await signIn(page, "owner");
    await page.goto("/command-center");
    const card = page.getByTestId("getting-started");
    await expect(card.getByRole("heading", { name: "Getting started" })).toBeVisible();
    const step = card.getByRole("link", { name: /Add your company phone so drivers and customers can call you/ });
    await expect(step).toHaveAttribute("href", "/settings?tab=company#phone");
    await expect(card.getByTestId("getting-started-progress")).toContainText(/\d of \d done/);
    // Seeded trucks, customers and orders are already ticked.
    await expect(card.getByRole("link", { name: /Add a truck/ })).toHaveAttribute("data-done", "true");
    // Touch-sized rows and Hide.
    expect((await step.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const hide = card.getByRole("button", { name: "Hide Getting started" });
    expect((await hide.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await hide.click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("getting-started")).toHaveCount(0);
    expect((await sql("select 1 from public.user_preferences where company_id = $1 and user_id = $2 and key = 'getting_started'", [TOP_LINE, await userId("owner")])).length).toBe(1);
  } finally {
    await sql("update public.company_settings set phone = $2 where company_id = $1", [TOP_LINE, phone]);
    await reset("owner");
  }
});

test("dispatcher: opening tomorrow's plan ticks that step on this device", async ({ page }) => {
  await reset("dispatcher");
  await signIn(page, "dispatcher");
  await page.goto("/command-center");
  const card = page.getByTestId("getting-started");
  const plan = card.getByRole("link", { name: /Open tomorrow's plan/ });
  await expect(plan).toHaveAttribute("data-done", "false");
  await plan.click();
  await page.waitForURL(/\/dispatch\/plan/);
  await page.goto("/command-center");
  await expect(page.getByTestId("getting-started").getByRole("link", { name: /Open tomorrow's plan/ })).toHaveAttribute("data-done", "true");
});

test("driver: the checklist is on My Day with the pre-trip step", async ({ page }) => {
  await reset("driver");
  await signIn(page, "driver");
  await page.goto("/driver");
  const card = page.getByTestId("getting-started");
  await expect(card).toBeVisible();
  await expect(card.getByRole("link", { name: /Do your pre-trip inspection/ })).toHaveAttribute("href", "/driver#pre-trip");
  await expect(card.getByRole("link", { name: /Open today's load/ })).toBeVisible();
});

test("office: the steps are its own (order, ticket review, invoice draft)", async ({ page }) => {
  await reset("office");
  await signIn(page, "office");
  await page.goto("/command-center");
  const card = page.getByTestId("getting-started");
  // Shown unless this office login already did every step.
  if (await card.count()) {
    await expect(card.getByRole("link", { name: /Review a delivery ticket/ })).toHaveAttribute("href", "/tickets?view=check");
    await expect(card.getByRole("link", { name: /Add your company phone/ })).toHaveCount(0);
  }
});
