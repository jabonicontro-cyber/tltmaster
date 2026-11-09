// Uptime check (LR4, owner 2026-11-05: UptimeRobot free tier). Answers 200 when the app and its database answer, 503
// when the database does not. Returns no data. Sign-in: Supabase Auth's public health endpoint. Database: one real,
// read-only query made from the server (a HEAD request that counts nothing and returns no rows). The data API's root
// page, used before, stopped answering the public key on the hosted project (2026-11-08, 21:29 CST) while every real
// query still worked, so it reported the database down when it was not.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function reachable(url: string, key: string, method = "GET"): Promise<boolean> {
  try {
    // Older keys are JWTs and go in both headers; the newer secret keys (sb_secret_…) go in apikey only.
    const headers: Record<string, string> = { apikey: key };
    if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
    const r = await fetch(url, { method, headers, cache: "no-store", signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const server = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // A real query when the server key is set (it is on every deployment); the data API root otherwise (local setups).
  const database = server
    ? reachable(`${url}/rest/v1/companies?select=id&limit=1`, server, "HEAD")
    : reachable(`${url}/rest/v1/`, key ?? "");
  const [auth, data] = url && key ? await Promise.all([reachable(`${url}/auth/v1/health`, key), database]) : [false, false];
  const ok = auth && data;
  return NextResponse.json(
    { ok, app: "ok", sign_in: auth ? "ok" : "down", database: data ? "ok" : "down", checked_at: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
