import { expect, test } from "@playwright/test";
import pg from "pg";
import { asUser } from "./db";
import { signIn, unique } from "./helpers";
import { TOP_LINE_SLUG, USERS } from "./users";

// First-day walkthrough fixes, batch 4 (2026-11-16), end to end: a ticket over the order is a review reason with
// Correct first (T4); a quote marked sent by hand offers "Email quote", not "Email again", and a declined quote is not
// offered "Cancel quote" (T5); the customer portal separates past-dated open orders, never calls a passed window
// "next", offers only job sites its tickets went to, reads units correctly and answers "How do I pay?" (W1 to W5);
// the demo form on a phone focuses the first field to fix and then the thank-you (W12). Fictional records only.

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const TOP_LINE = "00000000-0000-4000-8000-000000000001";
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;
const owner = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.owner.email, fn as never) as Promise<T>;
const plusDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** An order for Prairie View Landscaping (44 t of gravel) with one assigned load on `day` from `start` to `end`. */
async function order(day: string, start: string, end: string, label: string) {
  const id = unique();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const truckId = await ins("trucks", { unit_number: `B4-${id}`, truck_type: "tri_axle_dump" });
    const driverId = await ins("drivers", { name: `Bea Batch ${id}` });
    const verified = new Date().toISOString();
    await ins("driver_qualifications", { driver_id: driverId, kind: "cdl", cdl_class: "A", expires_on: plusDays(600), verified_at: verified });
    await ins("driver_qualifications", { driver_id: driverId, kind: "medical_card", expires_on: plusDays(600), verified_at: verified });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE]);
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = $1", [TOP_LINE]);
    const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, order_date: day, project_name: `${label} e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 }],
    })]);
    const o = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: day, scheduled_end: day })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    const line = (await q("select id from public.order_lines where order_id = $1", [o.order_id])).rows[0].id as string;
    const load = ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: o.order_id, load_date: day, start_time: start, end_time: end, planned_quantity: "22", unit_code: "ton" })])).rows[0].r as { load_id: string }).load_id;
    await q("select public.assign_load($1, $2, null, $3, '', null)", [load, truckId, driverId]);
    return { orderId: o.order_id, orderNumber: o.order_number, line, load, day, id };
  });
}

async function cancelOrder(orderId: string) {
  await office(async (q) => {
    for (const t of (await q("select id from public.delivery_tickets where order_id = $1 and status in ('submitted', 'needs_review', 'accepted')", [orderId])).rows) {
      await q("select public.review_delivery_ticket($1, 'void', 'e2e cleanup')", [t.id]);
    }
    await q("select public.set_order_status($1, 'on_hold', 'e2e cleanup')", [orderId]);
    await q("select public.set_order_status($1, 'canceled', 'e2e cleanup')", [orderId]);
  });
}

const businessDay = async (offset = 0) =>
  (await sql<{ d: string }>("select ((now() at time zone coalesce(nullif(timezone, ''), 'America/Chicago'))::date + $2::int)::text d from public.company_settings where company_id = $1", [TOP_LINE, offset]))[0].d;

test("T4: a ticket for more than the order is a review reason, and Correct comes first", async ({ page }) => {
  test.setTimeout(120_000);
  const yesterday = await businessDay(-1);
  const f = await order(yesterday, "06:00", "06:40", "Over the order");
  try {
    await office(async (q) => q("select public.set_order_status($1, 'in_progress', '')", [f.orderId]));
    const t = await office(async (q) => (await q("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
      load_id: f.load, order_line_id: f.line, delivered_date: yesterday, delivered_time: "06:30", quantity: "50", unit_code: "ton", external_reference: `B4-${f.id}`,
    })])).rows[0].r as { ticket_id: string; ticket_number: string });
    await signIn(page, "office");
    await page.goto(`/tickets/${t.ticket_id}`);
    const reasons = page.getByRole("list", { name: "Review reasons" });
    await expect(reasons.getByText("More than the order line asks for (over the order).")).toBeVisible();
    await expect(reasons.getByText(/accept it only if more was really delivered/)).toBeVisible();
    await expect(page.getByText("Received, not verified yet")).toHaveCount(0);
    // No internal permission code is shown; the paper number is labelled beside the system number.
    await expect(page.getByText("(tickets.review)")).toHaveCount(0);
    await expect(page.getByText(`B4-${f.id}`).first()).toBeVisible();
    // Correct is the filled button, Accept is not.
    const correct = page.getByRole("link", { name: "Correct" });
    const accept = page.getByRole("button", { name: "Accept", exact: true });
    await expect(correct).toBeVisible();
    await expect(accept).toBeVisible();
    expect(await correct.evaluate((e) => getComputedStyle(e).color)).toBe("rgb(255, 255, 255)");
    expect(await accept.evaluate((e) => getComputedStyle(e).color)).not.toBe("rgb(255, 255, 255)");
  } finally {
    await cancelOrder(f.orderId);
  }
});

test("T5: a quote marked sent by hand offers Email quote; a declined quote explains the decline and has no Cancel", async ({ page }) => {
  test.setTimeout(120_000);
  const q = await owner(async (sqlq) => {
    const ids = (await sqlq("select (select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1) c, (select id from public.materials where code = 'GRV-53' and company_id = $1) m", [TOP_LINE])).rows[0];
    const r = (await sqlq("select public.save_quote_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: ids.c, quote_date: plusDays(0), valid_until: plusDays(30), project_name: `Batch 4 quote e2e ${unique()}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.m, description: "Gravel #53 limestone", unit_code: "ton", quantity: "20", unit_rate_cents: 1000, taxable: false }],
    })])).rows[0].r as { quote_id: string; edit_seq: number; quote_number: string };
    await sqlq("select public.mark_quote_sent($1, $2, 'Printed and handed over (e2e)')", [r.quote_id, r.edit_seq]);
    return r;
  });
  await signIn(page, "owner");
  await page.goto(`/quotes/${q.quote_id}`);
  await expect(page.getByRole("button", { name: "Email quote" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Email again" })).toHaveCount(0);

  await page.getByRole("button", { name: "Mark declined" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Records that the customer said no to this revision.");
  await dialog.getByLabel("Reason").fill("Went with another hauler (e2e)");
  await dialog.getByRole("button", { name: "Mark declined" }).click();
  await expect(page.getByText("Declined").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel quote" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Revise" })).toBeVisible();
});

test.describe("customer portal", () => {
  test.beforeEach(async () => {
    await sql("insert into private.portal_entitlements (company_id, entitled, note) values ($1, true, 'e2e') on conflict (company_id) do update set entitled = true", [TOP_LINE]);
    await sql("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true, feature_documents = true, feature_help = true", [TOP_LINE]);
  });
  test.afterEach(async () => {
    await sql("update public.portal_accounts set status = 'revoked', revoked_at = now() where company_id = $1 and email like 'e2e-b4-%' and status <> 'revoked'", [TOP_LINE]);
    await sql("update public.portal_settings set enabled = false where company_id = $1", [TOP_LINE]);
    await sql("delete from private.portal_entitlements where company_id = $1", [TOP_LINE]);
  });

  test("W1 to W5: Today never calls a passed window next, past-dated orders are apart, the site filter finds tickets, units read right, help answers paying", async ({ page, browser }) => {
    test.setTimeout(240_000);
    const today = await businessDay(0);
    const past = await order(await businessDay(-3), "07:00", "08:00", "Past date");
    // A load today whose window (just after midnight) has passed, still not delivered.
    const passed = await order(today, "00:00", "00:01", "Passed window");
    const username = `e2e-b4-${unique()}`;
    try {
      await signIn(page, "owner");
      await page.goto("/customer-portal?tab=access");
      await page.locator("#signin_customer").selectOption({ label: "Prairie View Landscaping" });
      await page.getByLabel("Person's name").fill(`E2E Batch4 Contact ${unique()}`);
      await page.getByLabel("Username").fill(username);
      await expect(page.getByText(`${username} is available`)).toBeVisible();
      await page.getByRole("button", { name: "Review" }).click();
      await page.getByRole("button", { name: "Create Sign-in" }).click();
      const panel = page.getByRole("region", { name: "Sign-in instructions" });
      await panel.getByRole("button", { name: "Show", exact: true }).click();
      const temp = (await panel.getByText(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/).textContent())!.trim();
      await panel.getByRole("button", { name: "Done" }).click();

      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const cust = await ctx.newPage();
      try {
        await cust.goto(`/portal/${TOP_LINE_SLUG}/login`);
        await cust.getByLabel("Email or username").fill(username);
        await cust.getByLabel("Password", { exact: true }).fill(temp);
        await cust.getByRole("button", { name: "Sign In" }).click();
        await cust.waitForURL(/\/welcome$/);
        await cust.getByLabel("New password").fill("Quarry-Lane-2026!");
        await cust.getByLabel("Type it again").fill("Quarry-Lane-2026!");
        await cust.getByRole("button", { name: "Save My Password" }).click();
        await cust.waitForURL(new RegExp(`/portal/${TOP_LINE_SLUG}$`));

        // W3: the past-dated open order is listed apart, not as upcoming.
        await expect(cust.getByTestId("portal-past-open").getByText(`Order ${past.orderNumber}`)).toBeVisible();
        await expect(cust.getByRole("list", { name: "Upcoming and open orders" }).getByText(`Order ${past.orderNumber}`)).toHaveCount(0);
        // W2: a window that has passed is never "next"; it says it is not recorded as delivered yet.
        const todayCard = cust.getByRole("list", { name: "Today" });
        const row = todayCard.getByRole("listitem").filter({ hasText: `Order ${passed.orderNumber}` });
        await expect(row).toContainText("not recorded as delivered yet");
        await expect(row).not.toContainText("Next load today");
        await expect(row).toContainText(/0 of 1 planned load delivered/);
        // W5: no capitalised or mismatched units anywhere on the overview.
        await expect(cust.locator("main")).not.toContainText(/\b1 (Loads|loads)\b|\b\d+ (Tons|Loads|Miles)\b/);

        // W4: the job-site filter offers only sites the customer's tickets went to (or none when there is nothing to choose).
        const used = await sql<{ id: string }>(
          `select distinct o.site_id::text id from public.delivery_tickets t join public.orders o on o.id = t.order_id join public.customers c on c.id = o.customer_id
             join public.customer_sites s on s.id = o.site_id and s.active
            where t.company_id = $1 and c.name = 'Prairie View Landscaping' and t.status in ('submitted', 'needs_review', 'accepted') and o.status <> 'draft'`, [TOP_LINE]);
        await cust.goto(`/portal/${TOP_LINE_SLUG}/tickets`);
        const site = cust.locator("#tickets-site");
        if (used.length > 1) {
          const values = await site.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
          expect(values.sort()).toEqual(used.map((u) => u.id).sort());
        } else {
          await expect(site).toHaveCount(0);
        }
        await expect(cust.getByTestId("tickets-summary")).not.toContainText(/Tons|Loads/);

        // W1: help matches the portal and answers paying.
        await cust.goto(`/portal/${TOP_LINE_SLUG}/help?q=pay my invoice`);
        await expect(cust.getByText("How do I pay my invoice?")).toBeVisible();
        await cust.getByText("How do I pay my invoice?").click();
        await expect(cust.getByText(/Payment is arranged directly with the company/)).toBeVisible();
        await cust.goto(`/portal/${TOP_LINE_SLUG}/help`);
        const hasInvoices = await cust.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Invoices" }).count();
        await cust.getByText("Where are my invoices?").click();
        if (hasInvoices) await expect(cust.getByText(/^Open Invoices to see every invoice/)).toBeVisible();
        else await expect(cust.getByText(/Invoices are not shown in this portal/)).toBeVisible();
        await cust.getByText("Where are my delivery tickets?").click();
        await expect(cust.getByText(/^Open Tickets to see every delivery ticket/)).toBeVisible();
      } finally {
        await ctx.close();
      }
    } finally {
      await cancelOrder(past.orderId);
      await cancelOrder(passed.orderId);
    }
  });
});

test("W12: on a phone the demo form focuses the first field to fix, then the thank-you", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  try {
    await page.goto("/demo");
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Request a demo" }) });
    await form.getByRole("button", { name: "Request a demo" }).click();
    const name = form.getByLabel("Full name");
    await expect(name).toBeFocused();
    await expect(name).toBeInViewport();
    await expect(page.getByText("Enter your full name.").first()).toBeInViewport();

    await name.fill("Dana Testerly");
    await form.getByLabel("Work email").fill(`dana.testerly+${unique()}@example.com`);
    await form.getByLabel("Company").fill("Fictional Gravel Co (e2e)");
    await form.getByLabel("Number of hauling trucks").fill("6");
    await form.getByLabel("Number of dispatch bases").fill("1");
    await form.getByRole("button", { name: "Request a demo" }).click();
    const thanks = page.getByTestId("lead-sent");
    await expect(thanks).toBeFocused();
    await expect(thanks.getByText(/reached the Taviron team/)).toBeInViewport();
  } finally {
    await ctx.close();
  }
});

test("W8 to W11: the website says AI is in development, hours match the catalog, two-step is required", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/built but not switched on/)).toHaveCount(0);
  await page.goto("/platform/dispatch");
  await expect(page.getByText(/Hours of service are not tracked/)).toHaveCount(0);
  await expect(page.getByText(/does not calculate hours-of-service rules/).first()).toBeVisible();
  await page.goto("/trust");
  await expect(page.getByText(/being rolled out/)).toHaveCount(0);
  await expect(page.getByText(/required for Taviron's own staff and for anyone whose role can see or change money/)).toBeVisible();
  await page.goto("/platform/customers");
  await expect(page.getByText(/until an email provider is configured/)).toHaveCount(0);
});
