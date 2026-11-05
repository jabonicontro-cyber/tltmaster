"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseAmountCents } from "@/lib/billing/invoices";
import { isIsoDate } from "@/lib/dates";
import { assertPermission } from "@/server/auth";
import { getInvoice } from "@/server/data/invoices";
import { getEmailMode, type EmailMode } from "@/server/email/provider";
import { env } from "@/server/env";
import { dbErrorMessage } from "@/server/errors";
import { buildInvoiceDocument } from "@/server/invoices/document";
import { renderInvoicePdf } from "@/server/pdf/invoice-pdf";
import { createClient } from "@/server/supabase/server";

// Invoices (B99, migration 20261120004800). Every change calls one database function that checks billing.manage, the
// company and the invoice's state again. Results come back as ?saved= / ?error= so the forms work without JavaScript.
// Email follows the quote rules: a demo company or an unconfigured server only previews; test mode goes to the test
// inbox and is not recorded as sent.

const uuid = z.uuid();
const go = (path: string, key: string, value: string): never =>
  redirect(`${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value.slice(0, 300))}`);
const page = (id: string) => `/billing/invoices/${id}`;
const refresh = (id?: string) => {
  revalidatePath("/billing/invoices");
  revalidatePath("/billing");
  if (id) revalidatePath(page(id));
};

async function manage(back: string) {
  try {
    return await assertPermission("billing.manage");
  } catch {
    return go(back, "error", "You do not have permission to change invoices.");
  }
}

export async function createInvoice(formData: FormData) {
  const back = String(formData.get("back") ?? "/billing?view=handed_off").startsWith("/billing") ? String(formData.get("back")) : "/billing?view=handed_off";
  const handoff = uuid.safeParse(formData.get("handoff"));
  if (!handoff.success) go(back, "error", "Handed-off order not found.");
  await manage(back);
  const { data, error } = await (await createClient()).rpc("invoice_create", { p_handoff_order: handoff.data });
  if (error) go(back, "error", dbErrorMessage(error));
  refresh();
  redirect(`${page(data as string)}?saved=created`);
}

/** One draft invoice for several handed-off orders of one customer (UX10). The database checks the customer, the
 * permission, and that no order is already invoiced. */
export async function createCombinedInvoice(formData: FormData) {
  const back = "/billing/invoices/combine";
  const ids = formData.getAll("handoff").map(String).filter((v) => uuid.safeParse(v).success);
  if (ids.length < 2) go(back, "error", "Choose at least two orders to put on one invoice.");
  await manage(back);
  const { data, error } = await (await createClient()).rpc("invoice_create_combined", { p_handoffs: ids });
  if (error) go(back, "error", dbErrorMessage(error));
  refresh();
  revalidatePath(back);
  redirect(`${page(data as string)}?saved=created`);
}

export async function issueInvoice(formData: FormData) {
  const id = uuid.parse(formData.get("invoice"));
  const date = String(formData.get("issue_date") ?? "");
  await manage(page(id));
  const { error } = await (await createClient()).rpc("invoice_issue", { p_invoice: id, p_issue_date: isIsoDate(date) ? date : null });
  if (error) go(page(id), "error", dbErrorMessage(error));
  refresh(id);
  go(page(id), "saved", "issued");
}

export async function voidInvoice(formData: FormData) {
  const id = uuid.parse(formData.get("invoice"));
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 300);
  if (!reason) go(page(id), "error", "Give a reason for voiding the invoice.");
  await manage(page(id));
  const { error } = await (await createClient()).rpc("invoice_void", { p_invoice: id, p_reason: reason });
  if (error) go(page(id), "error", dbErrorMessage(error));
  refresh(id);
  go(page(id), "saved", "voided");
}

export async function addPayment(formData: FormData) {
  const id = uuid.parse(formData.get("invoice"));
  const amount = parseAmountCents(String(formData.get("amount") ?? ""));
  const date = String(formData.get("received_on") ?? "");
  const method = z.enum(["check", "ach", "card", "cash", "other"]).safeParse(formData.get("method"));
  if (!amount) go(page(id), "error", "Enter the amount received, like 1250.00.");
  if (!isIsoDate(date)) go(page(id), "error", "Enter the date the payment was received.");
  if (!method.success) go(page(id), "error", "Choose how it was paid.");
  await manage(page(id));
  const { error } = await (await createClient()).rpc("invoice_add_payment", {
    p_invoice: id, p_amount_cents: amount, p_received_on: date, p_method: method.data,
    p_reference: String(formData.get("reference") ?? "").trim().slice(0, 80), p_note: String(formData.get("note") ?? "").trim().slice(0, 300),
  });
  if (error) go(page(id), "error", dbErrorMessage(error));
  refresh(id);
  go(page(id), "saved", "payment");
}

export async function voidPayment(formData: FormData) {
  const id = uuid.parse(formData.get("invoice"));
  const payment = uuid.parse(formData.get("payment"));
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 300);
  if (!reason) go(page(id), "error", "Give a reason for voiding the payment.");
  await manage(page(id));
  const { error } = await (await createClient()).rpc("invoice_void_payment", { p_payment: payment, p_reason: reason });
  if (error) go(page(id), "error", dbErrorMessage(error));
  refresh(id);
  go(page(id), "saved", "payment_voided");
}

const emails = (v: FormDataEntryValue | null) => String(v ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/** Email the issued invoice as a PDF with the company's branding. */
export async function sendInvoice(formData: FormData) {
  const id = uuid.parse(formData.get("invoice"));
  const access = await manage(page(id));
  const to = emails(formData.get("to"));
  const subject = String(formData.get("subject") ?? "").trim().slice(0, 200);
  const message = String(formData.get("message") ?? "").trim().slice(0, 5000);
  if (!to.length || to.length > 10 || to.some((e) => !z.email().safeParse(e).success)) go(page(id), "error", "Enter up to 10 valid email addresses.");
  if (!subject || !message) go(page(id), "error", "Enter a subject and a message.");
  const inv = await getInvoice(id);
  if (!inv) go(page(id), "error", "Invoice not found.");
  if (inv!.status !== "issued") go(page(id), "error", "Issue the invoice before sending it.");
  const supabase = await createClient();
  // The demo company never sends email; nor does a server without email configured.
  const mode: EmailMode = access.isDemo ? { mode: "preview", reason: "Demo company: emails are shown, never sent." } : getEmailMode();
  if (mode.mode === "preview") {
    const { error } = await supabase.rpc("invoice_record_sent", { p_invoice: id, p_to: to, p_simulated: true });
    if (error) go(page(id), "error", dbErrorMessage(error));
    refresh(id);
    go(page(id), "saved", "previewed");
  }
  let pdf: Awaited<ReturnType<typeof renderInvoicePdf>>;
  let filename: string;
  try {
    const doc = await buildInvoiceDocument(inv!);
    pdf = await renderInvoicePdf(doc);
    filename = doc.filename;
  } catch {
    return go(page(id), "error", "The invoice PDF could not be generated, so nothing was sent. Try again.");
  }
  const live = mode as Exclude<EmailMode, { mode: "preview" }>;
  const testing = live.mode === "test";
  const result = await live.provider.send(
    {
      to: testing ? [live.testRecipient] : to,
      cc: [],
      replyTo: env().EMAIL_REPLY_TO,
      subject: testing ? `[TEST] ${subject}` : subject,
      text: testing ? `TEST MODE. Intended for: ${to.join(", ")}\n\n${message}` : message,
      attachments: [{ filename: filename!, content: pdf!.buffer, contentType: "application/pdf" }],
    },
    { idempotencyKey: `invoice-${id}-${randomUUID()}` },
  );
  if (!result.ok) go(page(id), "error", `The email was not sent: ${result.error}`);
  const { error } = await supabase.rpc("invoice_record_sent", { p_invoice: id, p_to: testing ? [live.testRecipient] : to, p_simulated: testing });
  refresh(id);
  if (error) go(page(id), "error", `The email WAS sent, but it could not be recorded. Do not send it again. (${dbErrorMessage(error)})`);
  go(page(id), "saved", testing ? "test_sent" : "sent");
}

export async function saveInvoicingSettings(formData: FormData) {
  const back = "/settings?tab=invoicing";
  await manage(back);
  const issuer = z.enum(["quickbooks", "taviron"]).safeParse(formData.get("issuer"));
  const terms = Number.parseInt(String(formData.get("terms_days") ?? ""), 10);
  if (!issuer.success) go(back, "error", "Choose who issues your invoices.");
  if (!Number.isInteger(terms) || terms < 0 || terms > 120) go(back, "error", "Payment terms are 0 to 120 days.");
  const { error } = await (await createClient()).rpc("invoicing_save_settings", { p_issuer: issuer.data, p_terms_days: terms, p_footer: String(formData.get("footer") ?? "").trim().slice(0, 500) });
  if (error) go(back, "error", dbErrorMessage(error));
  revalidatePath("/settings");
  refresh();
  go(back, "saved", "invoicing");
}

/** Credit holds (B128): customers go on hold when an issued invoice is this many days past due; empty turns it off. */
export async function saveCreditHoldSettings(formData: FormData) {
  const back = "/settings?tab=invoicing";
  await manage(back);
  const raw = String(formData.get("overdue_days") ?? "").trim();
  const days = raw === "" ? null : Number.parseInt(raw, 10);
  if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365)) go(back, "error", "Days past due are 0 to 365, or empty to turn it off.");
  const { error } = await (await createClient()).rpc("credit_hold_save_settings", { p_overdue_days: days });
  if (error) go(back, "error", dbErrorMessage(error));
  revalidatePath("/settings");
  go(back, "saved", "invoicing");
}

/** Billing tolerance (UX2): quantity differences within this percent of the planned or ordered quantity are not billing
 * exceptions; empty = exact match. The company chooses the number. */
export async function saveBillingTolerance(formData: FormData) {
  const back = "/settings?tab=invoicing";
  await manage(back);
  const raw = String(formData.get("tolerance_percent") ?? "").trim().replace(",", ".");
  const percent = raw === "" ? null : Number(raw);
  if (percent !== null && (!Number.isFinite(percent) || percent <= 0 || percent > 10)) go(back, "error", "The tolerance is above 0 and up to 10 percent, or empty for an exact match.");
  const { error } = await (await createClient()).rpc("billing_save_tolerance", { p_percent: percent === null ? null : Math.round(percent * 100) / 100 });
  if (error) go(back, "error", dbErrorMessage(error));
  revalidatePath("/settings");
  revalidatePath("/billing");
  go(back, "saved", "invoicing");
}
