import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Workflow modules (MOD1, docs/MODULES.md): the owner chooses what the company uses; switched-off areas leave the menu
// and their pages say so; "Tickets to billing" enters tickets against the customer's job and sends them to billing;
// "Quotes only" marks an accepted quote won and makes no order. It runs in the second e2e company (Brookside), so
// switching modules never disturbs specs that use Top Line at the same time; every test puts it back to Full operations.

test.use({ deviceScaleFactor: 2 });

const SHOTS = process.env.MOD1_SCREENSHOTS;
async function shot(page: Page, name: string, part?: Locator) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  if (part) await part.screenshot({ path: `${SHOTS}/${name}.png` });
  else await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

const OWNER = USERS.modulesOwner.email;
const setModules = (preset: "full" | "tickets_to_billing" | "quotes_only") =>
  asUser(OWNER, (q) => q("select public.set_company_modules(private.module_preset($1))", [preset]));

/** The company's own customer and material (Brookside starts empty), created once through its owner's permissions. */
async function basics() {
  return asUser(OWNER, async (q) => {
    let c = (await q("select id, name from public.customers where name = 'Ridge Paving (e2e)'")).rows[0] as { id: string; name: string } | undefined;
    if (!c) c = (await q("insert into public.customers (name, customer_type) values ('Ridge Paving (e2e)', 'commercial') returning id, name")).rows[0] as { id: string; name: string };
    let m = (await q("select id from public.materials where name = 'Crushed stone #57 (e2e)'")).rows[0] as { id: string } | undefined;
    if (!m) m = (await q("insert into public.materials (name, default_unit_code) values ('Crushed stone #57 (e2e)', 'ton') returning id")).rows[0] as { id: string };
    return { customer: c, material: m.id };
  });
}

test("the owner picks what the company uses; switched-off areas leave the menu and their pages say so", async ({ page }) => {
  test.slow();
  await setModules("full");
  try {
    await signIn(page, "modulesOwner");
    await page.goto("/settings?tab=company");
    const section = page.getByRole("region", { name: "What you use" });
    await section.getByRole("button", { name: /Tickets to billing/ }).click();
    await expect(section.getByRole("checkbox", { name: "Use Dispatch" })).not.toBeChecked();
    await expect(section.getByRole("checkbox", { name: "Use Delivery tickets" })).toBeChecked();
    // Switching Delivery tickets off takes Billing along (Billing needs tickets), and says so.
    await section.getByRole("checkbox", { name: "Use Delivery tickets" }).uncheck();
    await expect(section.getByRole("status")).toContainText("Also switched off: Billing");
    await section.getByRole("checkbox", { name: "Use Delivery tickets" }).check();
    await section.getByRole("checkbox", { name: "Use Billing" }).check();
    await section.scrollIntoViewIfNeeded();
    await shot(page, "settings-what-you-use", section);
    await section.getByRole("button", { name: "Save" }).click();
    await expectToast(page, /Saved\. Switched off: Quotes, Dispatch/);
    await shot(page, "menu-tickets-to-billing", page.getByRole("navigation", { name: "Main" }).first());

    const menu = page.getByRole("navigation", { name: "Main" }).first();
    await expect(menu.getByRole("link", { name: "Dispatch" })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: "Quotes" })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: "Safety" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Delivery Tickets" })).toBeVisible();

    await page.goto("/dispatch");
    await expect(page.getByText("Dispatch is switched off for your company")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open What you use" })).toBeVisible();

    // Back to everything: nothing was deleted.
    await page.goto("/settings?tab=company");
    await page.getByRole("region", { name: "What you use" }).getByRole("button", { name: /Full operations/ }).click();
    await page.getByRole("region", { name: "What you use" }).getByRole("button", { name: "Save" }).click();
    await expectToast(page, "Saved. Everything is switched on.");
    await expect(page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Dispatch" })).toBeVisible();
  } finally {
    await setModules("full");
  }
});

test("Tickets to billing: enter a ticket against a new job, review it, and billing prices it from the job", async ({ page }) => {
  test.slow();
  const tag = unique();
  const { customer, material } = await basics();
  await setModules("tickets_to_billing");
  try {
    await signIn(page, "modulesOwner");
    await page.goto("/tickets");
    await page.getByRole("main").getByRole("link", { name: "Enter ticket", exact: true }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Enter delivery ticket" })).toBeVisible();
    await page.getByLabel("Customer").selectOption(customer.id);
    // What the paper ticket says first; the new job then expects that quantity unless told otherwise.
    await page.getByLabel("Quantity").fill("18.5");
    await page.getByRole("button", { name: "New job for this customer" }).click();
    const job = page.getByRole("group", { name: "New job" });
    await job.getByLabel("Job or site name").fill(`Gravel drive ${tag} (e2e)`);
    await job.getByLabel("Material").selectOption(material);
    await job.getByLabel(/Agreed price/).fill("12.50");
    await expect(job.getByLabel("Expected quantity for the job")).toHaveValue("18.5");
    await job.getByRole("button", { name: "Create job" }).click();
    await expectToast(page, /Job ORD-\d+ created\./);
    await expect(page.getByLabel("Job")).not.toHaveValue("");

    await page.getByLabel("Ticket number").fill(`P-${tag}`);
    await expect(page.getByLabel("Truck")).toHaveValue("");
    await shot(page, "ticket-entry-without-dispatch");
    await page.getByRole("button", { name: "Submit ticket" }).click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]{36}/);
    await expect(page.getByText("entered without dispatch")).toBeVisible();
    await expect(page.getByText(/No truck recorded/)).toBeVisible();

    // Review: the office accepts it.
    await page.getByRole("button", { name: /^Accept/ }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(async () => (await asUser(OWNER, (q) => q("select count(*)::int n from public.delivery_tickets where external_reference = $1 and status = 'accepted'", [`P-${tag}`]))).rows[0].n).toBe(1);

    // The job is finished; billing shows it ready with the job's price on the accepted quantity.
    const orderId = await asUser(OWNER, async (q) => {
      const id = (await q("select order_id from public.delivery_tickets where external_reference = $1 and status = 'accepted'", [`P-${tag}`])).rows[0].order_id as string;
      await q("select public.set_order_status($1, 'completed', '')", [id]);
      return id;
    });
    await page.goto(`/billing/orders/${orderId}`);
    await expect(page.getByText("18.5").first()).toBeVisible();
    await expect(page.getByText("$12.50").first()).toBeVisible();
    await expect(page.getByText("Ready to bill").first()).toBeVisible();
    await expect(page.getByText("entered from its ticket (no dispatch)")).toBeVisible();
    await expect(page.getByText("$231.25").first()).toBeVisible();
    await shot(page, "tickets-to-billing-invoice-draft");
  } finally {
    await setModules("full");
  }
});

// Financial review 2026-11-18 (M): without Dispatch, a customer on credit hold needs a reason for the new job and for
// the ticket, as every dispatched delivery does; office staff see the hold and the reason field before they start.
test("Tickets to billing: a customer on credit hold needs a reason for the job and the ticket, and it is recorded", async ({ page }) => {
  test.slow();
  const tag = unique();
  const { customer, material } = await basics();
  await setModules("tickets_to_billing");
  await asUser(OWNER, (q) => q("select public.set_customer_credit_hold($1, true, 'Two invoices late (e2e)')", [customer.id]));
  const since = new Date().toISOString();
  try {
    await signIn(page, "modulesOffice");
    await page.goto(`/tickets/new?customer=${customer.id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Enter delivery ticket" })).toBeVisible();
    const hold = page.getByRole("alert").filter({ hasText: "on credit hold" });
    await expect(hold).toBeVisible();
    await expect(hold).toContainText("give a reason; it is recorded with the ticket");
    const reason = page.getByLabel("Reason for going ahead");
    await expect(reason).toBeVisible();
    await shot(page, "ticket-entry-credit-hold", hold);

    await page.getByLabel("Quantity").fill("12");
    await page.getByRole("button", { name: "New job for this customer" }).click();
    const job = page.getByRole("group", { name: "New job" });
    await job.getByLabel("Job or site name").fill(`Held drive ${tag} (e2e)`);
    await job.getByLabel("Material").selectOption(material);
    await job.getByLabel(/Agreed price/).fill("12.50");
    // No reason yet: neither the job nor the ticket can go ahead.
    await expect(job.getByRole("button", { name: "Create job" })).toBeDisabled();
    await reason.fill("Owner approved by phone (e2e)");
    await job.getByRole("button", { name: "Create job" }).click();
    await expectToast(page, /Job ORD-\d+ created\./);
    await expect(page.getByLabel("Job")).not.toHaveValue("");

    await page.getByLabel("Ticket number").fill(`H-${tag}`);
    await reason.fill("");
    await expect(page.getByRole("button", { name: "Submit ticket" })).toBeDisabled();
    await reason.fill("Payment promised Friday (e2e)");
    await page.getByRole("button", { name: "Submit ticket" }).click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]{36}/);

    const recorded = await asUser(OWNER, async (q) => (await q(
      "select o.context, o.reason, o.entity_id = t.order_id as for_job from public.credit_hold_overrides o join public.delivery_tickets t on t.external_reference = $2 where o.customer_id = $1 and o.created_at >= $3 order by o.created_at",
      [customer.id, `H-${tag}`, since])).rows);
    expect(recorded).toEqual([
      { context: "order", reason: "Owner approved by phone (e2e)", for_job: true },
      { context: "order", reason: "Payment promised Friday (e2e)", for_job: true },
    ]);
  } finally {
    await asUser(OWNER, (q) => q("select public.set_customer_credit_hold($1, false, '')", [customer.id]));
    await setModules("full");
  }
});

test("Quotes only: an accepted quote is marked won, with who and when, and no order is made", async ({ page }) => {
  test.slow();
  await setModules("quotes_only");
  try {
    const { customer, material } = await basics();
    const quote = await asUser(OWNER, async (q) => {
      const m = { id: material, unit: "ton" };
      const c = customer.id;
      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      const r = (await q("select public.save_quote_draft($1::jsonb) r", [JSON.stringify({
        customer_id: c, quote_date: day(-1), valid_until: day(30), tax_rate_bp: 0, site_line1: "8 Quote Rd (e2e)",
        lines: [{ kind: "material", calc_method: "per_unit", material_id: m.id, description: "Gravel (e2e)", unit_code: m.unit, quantity: "20", unit_rate_cents: 1500, taxable: false }],
      })])).rows[0].r as { quote_id: string; edit_seq: number };
      await q("select public.mark_quote_sent($1, $2, 'Handed over (e2e)')", [r.quote_id, r.edit_seq]);
      return r.quote_id;
    });
    await signIn(page, "modulesOwner");
    const menu = page.getByRole("navigation", { name: "Main" }).first();
    await expect(menu.getByRole("link", { name: "Quotes" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Orders" })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: "Billing" })).toHaveCount(0);

    await page.goto(`/quotes/${quote}`);
    await page.getByRole("button", { name: "Mark won" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Mark won|Mark accepted|Confirm/ }).click();
    await expect(page.getByText("Won", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/counts as won/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Convert to order" })).toHaveCount(0);
    await shot(page, "quotes-only-won");
    const orders = await asUser(OWNER, (q) => q("select count(*)::int n from public.orders where source_quote_id = $1", [quote]));
    expect(orders.rows[0].n).toBe(0);
  } finally {
    await setModules("full");
  }
});
