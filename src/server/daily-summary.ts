import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { summaryEmail, type DailySummary } from "@/lib/summary/daily";
import { getEmailMode } from "@/server/email/provider";
import { env } from "@/server/env";

// End-of-day owner summaries (B97), run by the scheduled job with the service-role client. The database returns only
// companies that switched it on, whose hour has come and that were not summarized today — never a demo. Each company is
// recorded once per day whatever happened (sent, test, preview, failed, no recipients), so nothing is sent twice.

export async function runDailySummaries(admin: SupabaseClient): Promise<{ companies: number; sent: number; failed: number; skipped?: string }> {
  const due = await admin.rpc("daily_summary_due");
  if (due.error) {
    if (due.error.code === "PGRST202") return { companies: 0, sent: 0, failed: 0, skipped: "Needs the database update 20261120004200." };
    throw new Error(`daily_summary_due failed (${due.error.code})`);
  }
  const rows = (due.data ?? []) as Array<{ company_id: string; company: string; day: string; recipients: string[]; summary: DailySummary }>;
  const mode = getEmailMode();
  const appUrl = env().APP_BASE_URL;
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const record = (status: string, recipients: number, detail = "") =>
      admin.rpc("daily_summary_record", { p_company: r.company_id, p_day: r.day, p_status: status, p_recipients: recipients, p_detail: detail });
    if (!r.recipients.length) {
      await record("no_recipients", 0, "No active owner with an email address.");
      continue;
    }
    if (mode.mode === "preview") {
      await record("preview", r.recipients.length, mode.reason);
      continue;
    }
    const mail = summaryEmail(r.company, r.summary, appUrl);
    const to = mode.mode === "test" ? [mode.testRecipient] : r.recipients;
    const result = await mode.provider.send({ to, cc: [], subject: mail.subject, text: mail.text, attachments: [] }, { idempotencyKey: `daily-summary-${r.company_id}-${r.day}` });
    if (result.ok) {
      sent++;
      await record(mode.mode === "test" ? "test" : "sent", to.length);
    } else {
      failed++;
      await record("failed", 0, result.error.slice(0, 300));
    }
  }
  return { companies: rows.length, sent, failed };
}
