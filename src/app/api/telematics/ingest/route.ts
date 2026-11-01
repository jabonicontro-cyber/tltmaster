import { NextResponse } from "next/server";
import { feedKeyFrom, hashFeedKey } from "@/server/telematics";
import { createAdminClient } from "@/server/supabase/admin";

// GPS and hours provider feed (B101, docs/SETUP.md "GPS and hours feed"). A provider or a connector POSTs JSON with
// "Authorization: Bearer <feed key>". The key is hashed here and the database finds the company by the hash
// (public.telematics_ingest, service role only); the source must be "Provider feed" in Settings → GPS and hours.
// Unknown trucks or drivers and invalid rows are skipped and counted. No session, no cookies; nothing is logged
// except error codes.

export const dynamic = "force-dynamic";

const MAX_BYTES = 512 * 1024;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const key = feedKeyFrom(request.headers.get("authorization"));
  if (!key) return json({ error: "Send the company's feed key as: Authorization: Bearer tlk_…" }, 401);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BYTES) return json({ error: "Send at most 512 KB at a time." }, 413);
  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ error: "Send at most 512 KB at a time." }, 413);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json({ error: "The body must be JSON: {\"positions\": [...], \"hours\": [...]}." }, 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ error: "The body must be a JSON object." }, 400);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return json({ error: "The feed is not configured on this server." }, 503);
  }
  const { data, error } = await admin.rpc("telematics_ingest", { p_key_hash: hashFeedKey(key), p_payload: payload });
  if (error) {
    if (error.code === "28000") return json({ error: "Invalid feed key." }, 401);
    if (error.code === "42501") return json({ error: "The provider feed is turned off for this company (Settings → GPS and hours)." }, 403);
    if (error.code === "22023") return json({ error: error.message }, 400);
    if (error.code === "PGRST202") return json({ error: "The GPS and hours feed needs a database update that is not installed yet." }, 503);
    console.error("telematics ingest failed", error.code);
    return json({ error: "The feed could not be saved." }, 500);
  }
  return json({ accepted: data });
}
