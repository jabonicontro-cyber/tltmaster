import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { closeDemoWelcomeIfShown, unique } from "./helpers";

// First-day walkthrough fixes, batch 1 (money, billing, office desk, owner home; 2026-11-16), in a freight demo company
// (Cobalt Plains Freight, MK3) with its own owner and office sign-ins made for this run, so the shared test users'
// sessions are not touched. Demo data only; the payment recorded here is voided again.

type Ctx = { companyId: string; owner: string; office: string; password: string };
let ctx: Ctx | null = null;

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

test.beforeAll(async () => {
  const [co] = await sql<{ id: string }>(
    `select c.id from public.companies c join public.company_settings s on s.company_id = c.id
      where c.is_demo and c.active and s.industry = 'freight' and c.name = 'Cobalt Plains Freight'
        and exists (select 1 from public.invoices i where i.company_id = c.id and i.status = 'issued')
      order by c.created_at desc limit 1`,
  );
  if (!co) return;
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const password = `Pw-${randomUUID()}`;
  const tag = unique();
  const make = async (role: "owner" | "office", name: string) => {
    const email = `e2e-b1-${role}-${tag}@demotest.example`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
    if (error) throw error;
    await admin.from("profiles").update({ full_name: name, active_company_id: co.id }).eq("id", data.user.id);
    const m = await admin.from("company_memberships").insert({ company_id: co.id, user_id: data.user.id, role, active: true });
    if (m.error) throw m.error;
    return email;
  };
  ctx = { companyId: co.id, owner: await make("owner", "Olive Batch"), office: await make("office", "Bea Batch"), password };
});

async function signInAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(email);
  await page.getByLabel("Password").fill(ctx!.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await closeDemoWelcomeIfShown(page);
}

test.describe("batch 1 walkthrough fixes", () => {
  test.beforeEach(() => test.skip(!ctx, "needs an active Cobalt Plains Freight demo with issued invoices"));

  test("M2: a refused payment keeps the check number and says why under Amount; a recorded one clears it", async ({ page }) => {
    const [inv] = await sql<{ id: string; owed: number }>(
      `select i.id, i.total_cents - coalesce((select sum(p.amount_cents) from public.invoice_payments p where p.invoice_id = i.id and p.voided_at is null), 0) as owed
         from public.invoices i where i.company_id = $1 and i.status = 'issued' order by owed desc limit 1`, [ctx!.companyId]);
    test.skip(!inv || Number(inv.owed) < 200, "needs an issued invoice with money owed");
    await signInAs(page, ctx!.office);
    await page.goto(`/billing/invoices/${inv.id}`);
    const pay = page.getByRole("form", { name: "Record a payment" });
    await pay.getByLabel("Amount ($)").fill(String(Number(inv.owed) / 100 + 1000));
    await pay.getByLabel("Check or reference number").fill("CHK-55021");
    await pay.getByLabel("Note").fill("Batch one e2e");
    await pay.getByRole("button", { name: "Record payment" }).click();
    // The reason sits under Amount, the form keeps everything typed, and the URL carries no error.
    await expect(pay.getByRole("alert")).toContainText(/still owed/);
    await expect(pay.getByLabel("Amount ($)")).toHaveAttribute("aria-invalid", "true");
    await expect(pay.getByLabel("Check or reference number")).toHaveValue("CHK-55021");
    await expect(pay.getByLabel("Note")).toHaveValue("Batch one e2e");
    expect(page.url()).not.toContain("error=");
    // Fix the amount only: the check number is still there and goes with the payment.
    await pay.getByLabel("Amount ($)").fill("1.00");
    await pay.getByRole("button", { name: "Record payment" }).click();
    await page.waitForURL(/saved=payment/);
    await expect(page.getByRole("status").filter({ hasText: "Payment recorded." })).toBeVisible();
    const row = page.getByRole("list", { name: "Payments" }).getByRole("listitem").filter({ hasText: "#CHK-55021" });
    await expect(row).toContainText("$1.00");
    // Put the demo back: void the test payment with a reason.
    await row.getByLabel("Reason to void this payment").fill("Batch one e2e test payment");
    await row.getByRole("button", { name: "Void payment" }).click();
    await page.waitForURL(/saved=payment_voided/);
  });

  test("M3 and M4: an added charge shows in the lines and the total without a reload", async ({ page }) => {
    const [order] = await sql<{ order_id: string; total_cents: number }>(
      `select order_id, total_cents from public.billing_order_status where company_id = $1 and readiness = 'ready' order by order_number limit 1`, [ctx!.companyId]);
    test.skip(!order, "needs an order ready to bill");
    await signInAs(page, ctx!.office);
    await page.goto(`/billing/orders/${order.order_id}`);
    const form = page.getByRole("form", { name: "Add a charge" });
    await form.getByLabel("Charge").selectOption({ label: "Lumper fee" });
    await form.getByLabel("Rate ($)").fill("75");
    const note = `Receiver unload ${unique()}`;
    await form.getByLabel("Note (on the invoice)").fill(note);
    await form.getByRole("button", { name: "Add" }).click();
    const total = `$${((Number(order.total_cents) + 7500) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    // The confirmation comes with the new figures: by the time it shows, the lines and the total already have the charge.
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Charge added to the order." })).toBeVisible({ timeout: 20_000 });
    const lines = page.getByRole("table", { name: "Order lines" });
    await expect(lines.getByRole("row").filter({ hasText: note })).toContainText("$75.00");
    await expect(lines.getByRole("row").filter({ hasText: note })).toContainText("Charge, not counted from BOLs");
    await expect(page.getByText(/^Order total \$/)).toContainText(total);
  });

  test("M5 and O1: Money owed opens the invoices; time off waiting for the owner is in the queue", async ({ page }) => {
    const [pending] = await sql<{ n: number }>("select count(*)::int n from public.time_off_requests where company_id = $1 and status = 'pending'", [ctx!.companyId]);
    await signInAs(page, ctx!.owner);
    await page.goto("/command-center");
    if (pending.n > 0) {
      const row = page.getByRole("listitem", { name: `Time off waiting for you (${pending.n})` });
      await expect(row).toBeVisible();
      await expect(row.getByRole("link")).toHaveAttribute("href", "/time-off?status=pending");
    }
    // M9: one item "needs", several "need".
    await expect(page.getByTestId("greeting")).toBeVisible();
    await expect(page.getByText("1 item need attention", { exact: true })).toHaveCount(0);
    const tile = page.getByRole("link", { name: /^Money owed/ });
    await expect(tile).toBeVisible();
    await tile.click();
    await page.waitForURL(/\/billing\/invoices/);
  });

  test("O2: an owner without a People record is told what to do; an empty date says Choose a date", async ({ page }) => {
    await signInAs(page, ctx!.owner);
    await page.goto("/time-off");
    await expect(page.getByTestId("time-off-not-linked")).toContainText("Your sign-in is not linked to a person in People");
    await expect(page.getByTestId("time-off-not-linked").getByRole("link", { name: "People" })).toHaveAttribute("href", "/employees");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByText("Choose a date.")).toBeVisible();
    await expect(page.getByText("Enter a full date with a 4-digit year")).toHaveCount(0);
  });

  test("M7, M8, M10: overdue beside the credit badge, invoices in search, BOL words on payments", async ({ page }) => {
    const [inv] = await sql<{ number: string; customer_id: string }>(
      `select i.number, i.customer_id from public.invoices i where i.company_id = $1 and i.status = 'issued' and i.number is not null
        and i.due_date < current_date and i.total_cents > coalesce((select sum(p.amount_cents) from public.invoice_payments p where p.invoice_id = i.id and p.voided_at is null), 0)
        order by i.number limit 1`, [ctx!.companyId]);
    await signInAs(page, ctx!.office);
    if (inv) {
      await page.goto(`/customers/${inv.customer_id}`);
      await expect(page.getByTestId("credit-overdue")).toContainText("overdue");
      await expect(page.getByText("In good standing")).toHaveCount(0);
      // Search finds the invoice typed without its dash.
      await page.goto(`/search?q=${encodeURIComponent(inv.number.replace("-", ""))}`);
      await expect(page.getByRole("link", { name: new RegExp(`Invoice ${inv.number}`) }).first()).toBeVisible();
    }
    await page.goto("/billing/payments");
    await expect(page.getByRole("heading", { name: "Payments by BOL" })).toBeVisible();
    await expect(page.getByText(/Scale BOL/)).toHaveCount(0);
  });
});
