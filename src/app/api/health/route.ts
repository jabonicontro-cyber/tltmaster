// Uptime check (LR4, owner 2026-11-05: UptimeRobot free tier). Answers 200 when the app and its database answer, 503
// when the database does not. Reads nothing private and returns no data: the database check is the same public
// endpoint the browser uses for sign-in (Supabase Auth health) and the data API's root, with the public anon key.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function reachable(url: string, key: string): Promise<boolean> {
  try {
    const r = await fetch(url, { headers: { apikey: key }, cache: "no-store", signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const [auth, data] = url && key ? await Promise.all([reachable(`${url}/auth/v1/health`, key), reachable(`${url}/rest/v1/`, key)]) : [false, false];
  const ok = auth && data;
  return NextResponse.json(
    { ok, app: "ok", sign_in: auth ? "ok" : "down", database: data ? "ok" : "down", checked_at: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
