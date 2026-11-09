"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { parseAmountCents } from "@/lib/billing/invoices";
import { isIsoDate } from "@/lib/dates";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Payments by delivery ticket (TP1, migration 20261120009400). billing.manage; every check is repeated in the database
// (the ticket belongs to the customer and is billed, never more than is open or than the payment).

const uuid = z.uuid();
const applications = z.array(z.object({
  handoff_order_id: z.uuid(),
  ticket_number: z.string().trim().min(1).max(60),
  amount_cents: z.number().int().positive().max(100_000_000_000),
})).max(500);

function readApplications(formData: FormData) {
  try {
    return applications.safeParse(JSON.parse(String(formData.get("tickets") ?? "[]")));
  } catch {
    return applications.safeParse(null);
  }
}

const refresh = () => {
  revalidatePath("/billing/payments");
  revalidatePath("/billing/invoices");
};

/** Record money received and the tickets it covers; what is not applied stays as the customer's credit. */
export async function recordTicketPayment(formData: FormData): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await assertPermission("billing.manage");
    const customer = uuid.safeParse(formData.get("customer"));
    const amount = parseAmountCents(String(formData.get("amount") ?? ""));
    const date = String(formData.get("received_on") ?? "");
    const method = z.enum(["check", "ach", "card", "cash", "other"]).safeParse(formData.get("method"));
    const apps = readApplications(formData);
    if (!customer.success) return fail("Choose the customer.");
    if (!amount) return fail("Enter the amount received, like 1250.00.", { amount: "Enter the amount received." });
    if (!isIsoDate(date)) return fail("Enter the date the payment was received.", { received_on: "Enter a date." });
    if (!method.success) return fail("Choose how it was paid.");
    if (!apps.success) return fail("The ticket amounts could not be read. Check them and try again.");
    const applied = apps.data.reduce((t, a) => t + a.amount_cents, 0);
    if (applied > amount) return fail("The tickets add up to more than the payment.");
    const { data, error } = await (await createClient()).rpc("customer_payment_record", {
      p: {
        customer_id: customer.data, amount_cents: amount, received_on: date, method: method.data,
        reference: String(formData.get("reference") ?? "").trim().slice(0, 80), note: String(formData.get("note") ?? "").trim().slice(0, 300),
        tickets: apps.data,
      },
    });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    const left = amount - applied;
    return ok({ id: data as string }, left > 0 ? `Payment recorded. ${(left / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} is kept as credit for this customer.` : "Payment recorded.");
  });
}

/** Apply a payment's remaining credit to more tickets. */
export async function applyTicketCredit(formData: FormData): Promise<ActionResult<null>> {
  return guard(async () => {
    await assertPermission("billing.manage");
    const payment = uuid.safeParse(formData.get("payment"));
    const apps = readApplications(formData);
    if (!payment.success) return fail("Payment not found.");
    if (!apps.success || apps.data.length === 0) return fail("Choose at least one ticket.");
    const { error } = await (await createClient()).rpc("customer_payment_apply", { p_payment: payment.data, p_tickets: apps.data });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(null, "Credit applied.");
  });
}

/** Void a payment (bounced check, entered twice): its tickets reopen. */
export async function voidTicketPayment(formData: FormData): Promise<ActionResult<null>> {
  return guard(async () => {
    await assertPermission("billing.manage");
    const payment = uuid.safeParse(formData.get("payment"));
    const reason = String(formData.get("reason") ?? "").trim().slice(0, 300);
    if (!payment.success) return fail("Payment not found.");
    if (!reason) return fail("Give a reason for voiding the payment.", { reason: "Give a reason." });
    const { error } = await (await createClient()).rpc("customer_payment_void", { p_payment: payment.data, p_reason: reason });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(null, "Payment voided. Its tickets are open again.");
  });
}
