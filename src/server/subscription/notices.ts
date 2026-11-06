import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderEmailHtml } from "@/lib/email/html";
import { noticeMessage } from "@/lib/subscription/notices";
import { getEmailMode } from "@/server/email/provider";
import { env } from "@/server/env";

// Subscription notices (SUB1): the daily run records events; this emails the pending ones to each customer company's
// owners and marks each one (sent; previewed when email is not configured; failed). Test mode sends to the test inbox.
// Service-role client only (called from the daily cron).

type Pending = { id: string; kind: string; company: string; detail: Record<string, unknown>; to: string[] };

export async function sendSubscriptionNotices(admin: SupabaseClient): Promise<{ sent: number; previewed: number; failed: number }> {
  const out = { sent: 0, previewed: 0, failed: 0 };
  const { data, error } = await admin.rpc("subscription_pending_notices");
  if (error) return out;
  const mode = getEmailMode();
  for (const n of (data ?? []) as Pending[]) {
    const mark = (status: "sent" | "previewed" | "failed", note: string) => admin.rpc("subscription_notice_mark", { p_event: n.id, p_status: status, p_note: note });
    const msg = noticeMessage(n);
    if (!msg) {
      await mark("previewed", "No customer email for this event.");
      out.previewed++;
      continue;
    }
    if (!n.to.length) {
      await mark("failed", "The company has no owner with an email address.");
      out.failed++;
      continue;
    }
    if (mode.mode === "preview") {
      await mark("previewed", mode.reason.slice(0, 300));
      out.previewed++;
      continue;
    }
    const footer = `You received this because you are an owner of ${n.company} in Taviron.`;
    const text = `${msg.paragraphs.join("\n\n")}\n\n${footer}`;
    const html = renderEmailHtml({ preheader: msg.subject, heading: msg.heading, paragraphs: msg.paragraphs, footer });
    const testing = mode.mode === "test";
    const result = await mode.provider.send(
      {
        to: testing ? [mode.testRecipient] : n.to, cc: [], replyTo: env().EMAIL_REPLY_TO,
        subject: testing ? `[TEST] ${msg.subject}` : msg.subject,
        text: testing ? `TEST MODE. Intended for: ${n.to.join(", ")}\n\n${text}` : text, html, attachments: [],
      },
      { idempotencyKey: `subscription-${n.id}` },
    );
    if (result.ok) {
      await mark("sent", testing ? "Sent to the test inbox." : "");
      out.sent++;
    } else {
      await mark("failed", result.error.slice(0, 300));
      out.failed++;
    }
  }
  return out;
}
