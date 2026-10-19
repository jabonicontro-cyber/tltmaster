import { NextResponse } from "next/server";
import { authorizedCron } from "@/server/cron";
import { createAdminClient } from "@/server/supabase/admin";

// Scheduled go-live (Vercel Cron, vercel.json): customer companies whose go-live day has come become live
// (public.lifecycle_activate_due_cron, idempotent — a second run activates nothing). Only a request carrying CRON_SECRET
// is served. The platform console also runs the same activation whenever it is opened.

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "Scheduled activation is not configured (CRON_SECRET)." }, 503);
  if (!authorizedCron(request.headers.get("authorization"), secret)) return json({ error: "Unauthorized." }, 401);
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return json({ error: "The service-role key is not configured." }, 503);
  }
  const run = await admin.rpc("lifecycle_activate_due_cron");
  if (run.error) {
    const missing = run.error.code === "PGRST202";
    console.error("lifecycle-activation: database call failed", run.error.code);
    return json({ error: missing ? "Needs the database update 20261118000300, which is not installed yet." : "Activation failed." }, missing ? 503 : 500);
  }
  return json({ ok: true, activated: run.data });
}
