import { NextResponse } from "next/server";
import { authorizedCron, housekeepingFailed } from "@/server/cron";
import { createAdminClient } from "@/server/supabase/admin";

// Scheduled Communications housekeeping (Vercel Cron, vercel.json): escalations, document alerts, workspace
// archiving and the 14-day message retention for every company (public.comm_housekeeping_all), then removal of
// expired attachment files through the Storage API (Supabase forbids deleting storage rows in SQL).
// Only a request carrying CRON_SECRET is served; without that variable the route refuses everything.
// The service-role client is used for exactly these three database functions and the one bucket.

export const dynamic = "force-dynamic";

const BUCKET = "comm-attachments";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "Scheduled housekeeping is not configured (CRON_SECRET)." }, 503);
  if (!authorizedCron(request.headers.get("authorization"), secret)) return json({ error: "Unauthorized." }, 401);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return json({ error: "The service-role key is not configured." }, 503);
  }
  const run = await admin.rpc("comm_housekeeping_all");
  if (run.error) {
    const missing = run.error.code === "PGRST202";
    console.error("comm-housekeeping: database call failed", run.error.code);
    return json({ error: missing ? "Needs the database update 20261108000100, which is not installed yet." : "Housekeeping failed." }, missing ? 503 : 500);
  }

  let removed = 0;
  let fileErrors = 0;
  const files = await admin.rpc("comm_expired_attachment_files", { p_limit: 500 });
  const rows = (files.data ?? []) as Array<{ attachment_id: string; object_path: string }>;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const del = await admin.storage.from(BUCKET).remove(chunk.map((r) => r.object_path));
    if (del.error) { fileErrors += chunk.length; continue; }
    // Missing objects count as removed: the goal is that no file of an expired message remains.
    const marked = await admin.rpc("comm_mark_attachment_files_removed", { p_ids: chunk.map((r) => r.attachment_id) });
    if (marked.error) fileErrors += chunk.length; else removed += Number(marked.data ?? 0);
  }
  // Partial failures must be visible: Vercel marks a non-2xx cron run as failed, and the log names what failed
  // (company ids and counts only — never message content or secrets). The next run retries everything.
  if (housekeepingFailed(run.data as { failed?: unknown[] } | null, fileErrors)) {
    console.error("comm-housekeeping: partial failure", JSON.stringify({ failedCompanies: (run.data as { failed?: unknown[] }).failed ?? [], fileErrors }));
    return json({ ok: false, housekeeping: run.data, filesRemoved: removed, fileErrors }, 500);
  }
  return json({ ok: true, housekeeping: run.data, filesRemoved: removed, fileErrors });
}
