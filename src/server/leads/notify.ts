import "server-only";
import { confirmationEmail, notificationEmail, type LeadForEmail } from "@/lib/site/lead-emails";
import { getEmailMode, type EmailMode } from "@/server/email/provider";
import { env } from "@/server/env";
import { createAdminClient } from "@/server/supabase/admin";

type Kind = "confirmation" | "notification";

/**
 * Sends the prospect's confirmation and the team's notification for a saved
 * lead, and records every attempt on the lead (sent, failed or not sent). The
 * lead is already saved: nothing here can lose it. With EMAIL_PROVIDER=preview
 * (the default) nothing is sent; in test mode everything goes to
 * EMAIL_TEST_RECIPIENT.
 */
export async function notifyLead(
  lead: LeadForEmail & { id: string },
  opts: { created: boolean; confirm: boolean; mode?: EmailMode },
): Promise<void> {
  const mode = opts.mode ?? getEmailMode();
  const e = env();
  const db = createAdminClient();
  const record = async (kind: Kind, recipient: string, status: "sent" | "failed" | "not_sent", providerId: string | null, detail: string) => {
    const { error } = await db.rpc("lead_record_email", {
      p_lead: lead.id, p_kind: kind, p_recipient: recipient, p_mode: mode.mode, p_status: status, p_provider_id: providerId ?? "", p_detail: detail,
    });
    if (error) console.error("Lead email attempt could not be recorded", { leadId: lead.id, kind, error: error.message });
  };

  const jobs: Array<{ kind: Kind; to: string | undefined; subject: string; text: string; replyTo?: string; missing: string }> = [];
  if (opts.confirm) {
    const m = confirmationEmail(lead);
    jobs.push({ kind: "confirmation", to: lead.email, ...m, replyTo: e.EMAIL_REPLY_TO, missing: "" });
  }
  const n = notificationEmail(lead, { leadUrl: `${e.APP_BASE_URL.replace(/\/$/, "")}/admin/leads/${lead.id}`, created: opts.created });
  jobs.push({ kind: "notification", to: e.LEAD_NOTIFY_EMAIL, ...n, replyTo: lead.email, missing: "No team inbox is configured (LEAD_NOTIFY_EMAIL)." });

  for (const job of jobs) {
    if (!job.to) {
      await record(job.kind, "", "not_sent", null, job.missing);
      continue;
    }
    if (mode.mode === "preview") {
      await record(job.kind, job.to, "not_sent", null, mode.reason);
      continue;
    }
    const to = mode.mode === "test" ? mode.testRecipient : job.to;
    const result = await mode.provider.send(
      { to: [to], cc: [], replyTo: job.replyTo, subject: mode.mode === "test" ? `[TEST] ${job.subject}` : job.subject, text: job.text, attachments: [] },
      { idempotencyKey: `lead-${lead.id}-${job.kind}-${Date.now()}` },
    );
    if (result.ok) await record(job.kind, to, "sent", result.providerMessageId, mode.mode === "test" ? `Test mode: sent to the test inbox instead of ${job.to}.` : "");
    else await record(job.kind, to, "failed", null, result.error);
  }
}
