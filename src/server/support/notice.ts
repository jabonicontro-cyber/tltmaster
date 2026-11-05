import "server-only";
import { randomUUID } from "node:crypto";
import { renderEmailHtml } from "@/lib/email/html";
import { env } from "@/server/env";
import { getEmailMode } from "@/server/email/provider";
import { createClient } from "@/server/supabase/server";

/**
 * Tell the customer there is a reply on their support case (B138): a short notice with a link to the portal, never the
 * message itself (the portal is the record). Demo companies never send; nor does a server without email configured.
 * Best effort: a failed notice never undoes the reply. Returns what happened, for the person's confirmation.
 */
export async function sendSupportNotice(requestId: string, isDemo: boolean): Promise<"sent" | "test" | "preview" | "none" | "failed"> {
  if (isDemo) return "preview";
  const mode = getEmailMode();
  if (mode.mode === "preview") return "preview";
  const { data, error } = await (await createClient()).rpc("support_notice_recipients", { p_request: requestId });
  if (error) return "failed";
  const r = data as { emails: string[]; slug: string; company: string; subject: string };
  if (!r.emails?.length) return "none";
  const link = `${env().APP_BASE_URL}/portal/${r.slug}/support/${requestId}`;
  const subject = `${r.company} replied to your support request`;
  const text = `${r.company} replied to "${r.subject}".\n\nRead the reply and answer in your customer portal:\n${link}\n\nYou received this because you have a customer portal login with ${r.company}.`;
  const html = renderEmailHtml({
    preheader: `New reply: ${r.subject}`, heading: "You have a reply", paragraphs: [`${r.company} replied to "${r.subject}".`],
    action: { label: "Read the reply", url: link }, footer: `You received this because you have a customer portal login with ${r.company}.`,
  });
  const testing = mode.mode === "test";
  const result = await mode.provider.send(
    { to: testing ? [mode.testRecipient] : r.emails, cc: [], replyTo: env().EMAIL_REPLY_TO, subject: testing ? `[TEST] ${subject}` : subject,
      text: testing ? `TEST MODE. Intended for: ${r.emails.join(", ")}\n\n${text}` : text, html, attachments: [] },
    { idempotencyKey: `support-${requestId}-${randomUUID()}` },
  );
  if (!result.ok) {
    console.error("Support notice not sent", { requestId, error: result.error });
    return "failed";
  }
  return testing ? "test" : "sent";
}
