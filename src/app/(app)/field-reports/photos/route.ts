import { NextResponse, type NextRequest } from "next/server";
import { checkPhoto } from "@/lib/files/images";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

const BUCKET = "field-report-photos";
const MISSING = new Set(["42883", "PGRST202"]);

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * One photo for a driver's problem report (migration 20261120011100). The database, with the driver's own session,
 * checks that they sent the report (within the hour), the type, size and count, and reserves the path
 * (field_report_photo_begin); the bytes are checked here; only then does the service-role client store the file at
 * exactly that path in the private field-report-photos bucket. The report itself is already saved.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let sameOrigin = false;
  try {
    sameOrigin = Boolean(origin && host && new URL(origin).host === host);
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return reply(403, { error: "Not permitted." });
  const access = await getAccess();
  if (!access?.active || !access.companyId) return reply(401, { error: "Sign in again." });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "The upload was incomplete. Try again." });
  }
  const file = form.get("file");
  const report = String(form.get("report") ?? "");
  if (!(file instanceof File) || !uuid.safeParse(report).success) return reply(400, { error: "Invalid upload." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkPhoto(bytes, file.type);
  if (!check.ok) return reply(check.status, { error: check.error });
  if (!adminAvailable()) return reply(503, { error: "Photos cannot be stored right now. The report was sent without them." });

  const begin = await (await createClient()).rpc("field_report_photo_begin", { p_report: report, p_mime: check.type, p_size: bytes.length });
  if (begin.error) {
    if (MISSING.has(begin.error.code ?? "")) return reply(501, { error: "Photos on reports are not available yet. The report was sent without them." });
    return reply(begin.error.code === "42501" ? 403 : 400, { error: dbErrorMessage(begin.error) });
  }
  const path = begin.data as string;
  const up = await createAdminClient().storage.from(BUCKET).upload(path, bytes, { contentType: check.type, upsert: false, cacheControl: "private, max-age=0" });
  if (up.error) {
    console.error("Field report photo upload failed", { report, error: up.error.message });
    // The reservation is kept on record but never shown, and does not count toward the limit.
    await createAdminClient().from("field_report_photos").update({ failed_at: new Date().toISOString() }).eq("object_path", path).is("failed_at", null);
    return reply(502, { error: "The photo could not be stored. The report was sent without it." });
  }
  return reply(200, { ok: true });
}
