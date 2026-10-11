"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { quoteDraftInput, toSavePayload, type QuoteDraftInput } from "@/lib/schemas/quote";
import { uuid } from "@/lib/schemas/common";
import { QUOTE_STATUSES } from "@/lib/quotes/status";
import { formatCents } from "@/lib/money";
import { formatDateLong } from "@/lib/dates";
import { assertPermission, getAccess } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";
import { getCustomerQuoteContext } from "@/server/data/customers";
import { getEmailMode, type EmailMode } from "@/server/email/provider";
import { env } from "@/server/env";
import { loadQuoteDocument } from "@/server/quotes/document-loader";
import { renderQuotePdf } from "@/server/pdf/quote-pdf";
import type { EffectivePrice } from "@/server/data/types";

function revalidateQuote(id: string) {
  revalidatePath("/quotes");
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/command-center");
}

export async function saveQuoteDraft(input: QuoteDraftInput): Promise<ActionResult<{ quoteId: string; editSeq: number; quoteNumber: string; totalCents: number }>> {
  return guard(async () => {
    await assertPermission("quotes.edit");
    const parsed = quoteDraftInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_quote_draft", { p_payload: toSavePayload(parsed.data) });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { quote_id: string; edit_seq: number; quote_number: string; total_cents: number };
    revalidateQuote(r.quote_id);
    if (parsed.data.saveSite) revalidatePath(`/customers/${parsed.data.customerId}`);
    return ok({ quoteId: r.quote_id, editSeq: r.edit_seq, quoteNumber: r.quote_number, totalCents: r.total_cents }, `Quote ${r.quote_number} saved.`);
  });
}

export async function loadCustomerContext(customerId: string, onDate: string) {
  return guard(async () => {
    await assertPermission("quotes.edit");
    if (!uuid.safeParse(customerId).success || !/^\d{4}-\d{2}-\d{2}$/.test(onDate)) return fail("Invalid request.");
    const context = await getCustomerQuoteContext(customerId);
    if (!context) return fail("Customer not found.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("effective_prices", { p_customer_id: customerId, p_on: onDate });
    if (error) return fail(dbErrorMessage(error));
    return ok({ ...context, prices: (data ?? []) as EffectivePrice[] });
  });
}

const emailInput = z.object({
  quoteId: z.uuid(),
  expectedEditSeq: z.number().int().nullable(),
  to: z.array(z.email("Enter valid email addresses.")).min(1, "Enter at least one recipient.").max(10),
  cc: z.array(z.email("Enter valid email addresses.")).max(10).default([]),
  subject: z.string().trim().min(1, "Enter a subject.").max(200),
  message: z.string().trim().min(1, "Enter a message.").max(5000),
});

export type SendQuoteResult =
  | { mode: "preview"; reason: string; subject: string; to: string[]; cc: string[]; message: string; filename: string }
  | { mode: "test"; deliveredTo: string }
  | { mode: "live"; deliveredTo: string[] };

/**
 * Email the current version of a quote with its PDF attached.
 * Order: issue (lock) version → render PDF → send → record outcome.
 * Any failure is recorded and reported; the quote is only marked Sent when
 * the email provider accepted the message.
 */
export async function sendQuoteEmail(input: z.input<typeof emailInput>): Promise<ActionResult<SendQuoteResult>> {
  return guard(async () => {
    const access = await assertPermission("quotes.send");
    const parsed = emailInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const { quoteId, expectedEditSeq, to, cc, subject, message } = parsed.data;
    const supabase = await createClient();
    // The demo company never sends email: it always records a preview.
    const mode: EmailMode = access.isDemo ? { mode: "preview", reason: "Demo company: emails are shown, never sent." } : getEmailMode();

    const { data: quote, error: qErr } = await supabase.from("quotes").select("id, current_version_id, status").eq("id", quoteId).maybeSingle();
    if (qErr || !quote) return fail("Quote not found.");

    if (mode.mode === "preview") {
      const loaded = await loadQuoteDocument(quoteId, quote.current_version_id);
      await supabase.rpc("record_quote_delivery", {
        p_quote_id: quoteId,
        p_version_id: quote.current_version_id,
        p_status: "preview",
        p_to: to,
        p_cc: cc,
        p_subject: subject,
        p_body: message,
        p_provider: "preview",
        p_provider_message_id: null,
        p_error: null,
        p_document: null,
      });
      revalidateQuote(quoteId);
      return ok(
        { mode: "preview", reason: mode.reason, subject, to, cc, message, filename: loaded?.doc.filename ?? "quote.pdf" },
        "Preview only — nothing was sent.",
      );
    }

    // 1. Lock the version that will be sent.
    const { data: issued, error: issueErr } = await supabase.rpc("issue_quote_version", { p_quote_id: quoteId, p_expected_edit_seq: expectedEditSeq });
    if (issueErr) return fail(dbErrorMessage(issueErr));
    const versionId = (issued as { version_id: string }).version_id;

    const record = (status: "sent" | "failed" | "test_sent", extra: { providerMessageId?: string | null; error?: string | null; document?: object | null; to?: string[]; cc?: string[] }) =>
      supabase.rpc("record_quote_delivery", {
        p_quote_id: quoteId,
        p_version_id: versionId,
        p_status: status,
        p_to: extra.to ?? to,
        p_cc: extra.cc ?? cc,
        p_subject: subject,
        p_body: message,
        p_provider: mode.provider.name,
        p_provider_message_id: extra.providerMessageId ?? null,
        p_error: extra.error ?? null,
        p_document: extra.document ?? null,
      });

    // 2. Render the PDF of exactly that version.
    let pdf: Awaited<ReturnType<typeof renderQuotePdf>>;
    let filename: string;
    try {
      const loaded = await loadQuoteDocument(quoteId, versionId);
      if (!loaded) throw new Error("version not found");
      pdf = await renderQuotePdf(loaded.doc);
      filename = loaded.doc.filename;
    } catch (e) {
      const msg = `PDF generation failed: ${e instanceof Error ? e.message : "unknown error"}`;
      await record("failed", { error: msg });
      revalidateQuote(quoteId);
      return fail("The quote PDF could not be generated, so nothing was sent. The draft is still editable. Try again.");
    }
    const document = { filename, sha256: pdf.sha256, byte_size: pdf.byteSize };

    // 3. Send.
    const testing = mode.mode === "test";
    const actualTo = testing ? [mode.testRecipient] : to;
    const actualCc = testing ? [] : cc;
    const result = await mode.provider.send(
      {
        to: actualTo,
        cc: actualCc,
        replyTo: env().EMAIL_REPLY_TO,
        subject: testing ? `[TEST] ${subject}` : subject,
        text: testing ? `TEST MODE — intended for: ${[...to, ...cc].join(", ")}\n\n${message}` : message,
        attachments: [{ filename, content: pdf.buffer, contentType: "application/pdf" }],
      },
      { idempotencyKey: `quote-${versionId}-${randomUUID()}` },
    );

    // 4. Record the outcome.
    if (!result.ok) {
      await record("failed", { error: result.error, document });
      revalidateQuote(quoteId);
      return fail(`The email was not sent: ${result.error} The quote was not marked as sent.`);
    }
    const { error: recErr } = await record(testing ? "test_sent" : "sent", {
      providerMessageId: result.providerMessageId,
      document,
      to: actualTo,
      cc: actualCc,
    });
    revalidateQuote(quoteId);
    if (recErr) {
      console.error("Email sent but delivery could not be recorded", { quoteId, versionId, providerMessageId: result.providerMessageId });
      return fail(
        `The email WAS sent (provider id ${result.providerMessageId ?? "unknown"}), but the system could not record it. Do not resend; ask an owner to mark the quote as sent.`,
      );
    }
    return ok(testing ? { mode: "test", deliveredTo: mode.testRecipient } : { mode: "live", deliveredTo: to });
  });
}

export async function defaultEmailContent(quoteId: string) {
  return guard(async () => {
    await assertPermission("quotes.send");
    const supabase = await createClient();
    const { data: quote } = await supabase.from("quotes").select("id, current_version_id").eq("id", quoteId).maybeSingle();
    if (!quote) return fail("Quote not found.");
    const loaded = await loadQuoteDocument(quoteId, quote.current_version_id);
    if (!loaded) return fail("Quote not found.");
    const { doc, version, customer } = loaded;
    const greeting = version.contact_name ? `Hello ${version.contact_name.split(" ")[0]},` : "Hello,";
    const about = doc.projectName ? ` for ${doc.projectName}` : doc.jobSite.label ? ` for ${doc.jobSite.label}` : "";
    const message = [
      greeting,
      "",
      `Attached is quote ${doc.quoteNumber}${version.version_no > 1 ? ` (revision ${version.version_no})` : ""}${about}.`,
      `Total: ${formatCents(version.total_cents)}. This quote is valid until ${formatDateLong(version.valid_until)}.`,
      "",
      "Please reply to this email or call us with any questions or to accept the quote.",
      "",
      "Thank you,",
      doc.company.name,
      doc.company.contactLine,
    ]
      .filter((l) => l !== undefined)
      .join("\n");
    const to = [version.contact_email || customer.email].filter(Boolean);
    return ok({
      to,
      subject: `Quote ${doc.quoteNumber}${version.version_no > 1 ? ` (rev. ${version.version_no})` : ""} from ${doc.company.name}`,
      message,
      emailMode: (await getAccess())?.isDemo ? "preview" : getEmailMode().mode,
    });
  });
}

export async function markQuoteSent(quoteId: string, expectedEditSeq: number | null, note: string): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("quotes.send");
    if (!uuid.safeParse(quoteId).success) return fail("Invalid quote.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("mark_quote_sent", { p_quote_id: quoteId, p_expected_edit_seq: expectedEditSeq, p_note: note.slice(0, 500) });
    if (error) return fail(dbErrorMessage(error));
    revalidateQuote(quoteId);
    return ok(undefined, "Quote marked as sent.");
  });
}

export async function reviseQuote(quoteId: string, reason: string): Promise<ActionResult<{ versionNo: number }>> {
  return guard(async () => {
    await assertPermission("quotes.edit");
    if (!uuid.safeParse(quoteId).success) return fail("Invalid quote.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("revise_quote", { p_quote_id: quoteId, p_reason: reason.slice(0, 500) });
    if (error) return fail(dbErrorMessage(error));
    revalidateQuote(quoteId);
    const versionNo = (data as { version_no: number }).version_no;
    return ok({ versionNo }, `Revision ${versionNo} created. The sent version is unchanged.`);
  });
}

export async function setQuoteStatus(quoteId: string, status: string, note: string): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("quotes.status");
    if (!uuid.safeParse(quoteId).success || !(QUOTE_STATUSES as readonly string[]).includes(status)) return fail("Invalid request.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_quote_status", { p_quote_id: quoteId, p_status: status, p_note: note.slice(0, 500) });
    if (error) return fail(dbErrorMessage(error));
    revalidateQuote(quoteId);
    if (status === "accepted") {
      // Acceptance creates the Confirmed order in the same database transaction (N15).
      revalidatePath("/orders");
      const { data: order } = await supabase.from("orders").select("order_number").eq("source_quote_id", quoteId).maybeSingle();
      return ok(undefined, order ? `Quote marked accepted. Order ${order.order_number} was created as Confirmed.` : "Quote marked accepted.");
    }
    return ok(undefined, `Quote marked ${status}.`);
  });
}
