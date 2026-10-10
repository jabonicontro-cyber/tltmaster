import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { checkPhoto } from "@/lib/files/images";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

const BUCKET = "ticket-photos";

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Upload one paper-ticket photo for the driver's own load. The database
 * reserves the path (and checks the assignment), the storage server accepts
 * the object only for that reserved path (storage RLS with the driver's own
 * token), and the database then confirms size and type. Success is returned
 * only after that confirmation. Repeating a request with the same upload key
 * is safe.
 */
export async function POST(request: NextRequest) {
  // Same-origin only (no cross-site form posts with the driver's cookies).
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return reply(403, { error: "Not permitted." });

  const access = await getAccess();
  if (!access) return reply(401, { error: "Sign in again." });
  if (!access.active || !can(access, "driver.portal")) return reply(403, { error: "Not permitted." });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "The upload was incomplete. Try again." });
  }
  const file = form.get("file");
  const assignmentId = String(form.get("assignment_id") ?? "");
  const uploadKey = String(form.get("upload_key") ?? "");
  if (!(file instanceof File)) return reply(400, { error: "No photo was sent." });
  if (!uuid.safeParse(assignmentId).success || !uuid.safeParse(uploadKey).success) return reply(400, { error: "Invalid upload." });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkPhoto(bytes, file.type);
  if (!check.ok) return reply(check.status, { error: check.error });
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const supabase = await createClient();
  const begin = await supabase.rpc("driver_begin_ticket_photo", {
    p_assignment_id: assignmentId, p_upload_key: uploadKey, p_mime: check.type, p_size: bytes.length, p_sha256: sha256,
  });
  if (begin.error) return reply(begin.error.code === "42501" ? 403 : 400, { error: dbErrorMessage(begin.error) });
  const reserved = begin.data as { attachment_id: string; object_path: string; status: string };

  if (reserved.status === "pending") {
    const up = await supabase.storage.from(BUCKET).upload(reserved.object_path, bytes, { contentType: check.type, upsert: false, cacheControl: "private, max-age=0" });
    // An earlier attempt may already have stored it (lost response): confirm below decides.
    if (up.error && !/exists|duplicate/i.test(up.error.message)) {
      console.error("Ticket photo upload failed", { attachmentId: reserved.attachment_id, error: up.error.message });
      return reply(502, { error: "The photo could not be stored. Try again." });
    }
  }
  const confirm = await supabase.rpc("driver_confirm_ticket_photo", { p_attachment_id: reserved.attachment_id });
  if (confirm.error) return reply(409, { error: dbErrorMessage(confirm.error) });
  return reply(200, { attachmentId: reserved.attachment_id, status: (confirm.data as { status: string }).status });
}
