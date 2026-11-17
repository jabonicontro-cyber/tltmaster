import { NextResponse, type NextRequest } from "next/server";
import { can } from "@/lib/permissions";
import { UPLOAD_MAX_BYTES } from "@/lib/files/images";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { checkSupportFile } from "@/server/support/files";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

const BUCKET = "order-documents";
/** 4 MB, as driver_pod_begin: the hosting platform refuses request bodies over about 4.5 MB anyway. */
const TOO_LARGE = "The file is larger than 4 MB. Take a photo of the signed paper instead (photos are made smaller on the phone).";

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * A driver adds proof of delivery for a delivery stop of their own active load (MK2, 20261120020800). The database,
 * with the driver's own session, checks the assignment, the stop, the type, size and limits, and reserves the path
 * (public.driver_pod_begin); only then does the service-role client store the file at exactly that path (the
 * order-documents bucket has no policies, as for the office's documents). The same upload key on a retry returns the
 * same record, so a lost response never adds a second copy.
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
  if (!access) return reply(401, { error: "Sign in again." });
  if (!access.active || !can(access, "driver.portal")) return reply(403, { error: "Not permitted." });

  // Refuse an oversized body before reading it (the form adds a little to the file itself).
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > UPLOAD_MAX_BYTES + 64 * 1024) return reply(413, { error: TOO_LARGE });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "The upload was incomplete. Try again." });
  }
  const file = form.get("file");
  const assignment = String(form.get("assignment_id") ?? "");
  const stop = String(form.get("stop_id") ?? "");
  const key = String(form.get("upload_key") ?? "");
  if (!(file instanceof File)) return reply(400, { error: "No photo was sent." });
  if (![assignment, stop, key].every((v) => uuid.safeParse(v).success)) return reply(400, { error: "Invalid upload." });
  if (file.size > UPLOAD_MAX_BYTES) return reply(413, { error: TOO_LARGE });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > UPLOAD_MAX_BYTES) return reply(413, { error: TOO_LARGE });
  const check = checkSupportFile(bytes, file.type);
  if (!check.ok) return reply(check.status, { error: check.status === 415 ? "Send a photo (JPEG, PNG, WebP) or a PDF." : check.error });
  if (!adminAvailable()) return reply(503, { error: "Proof of delivery cannot be stored right now. Keep the paper copy for the office." });

  const begin = await (await createClient()).rpc("driver_pod_begin", {
    p_assignment: assignment, p_stop: stop, p_upload_key: key, p_mime: check.type, p_size: bytes.length, p_name: file.name.slice(0, 200),
  });
  if (begin.error) return reply(begin.error.code === "42501" ? 403 : 400, { error: dbErrorMessage(begin.error) });
  const r = begin.data as { document_id: string; path: string; existing: boolean };

  const admin = createAdminClient();
  const up = await admin.storage.from(BUCKET).upload(r.path, bytes, { contentType: check.type, upsert: false, cacheControl: "private, max-age=0" });
  // A retry after a lost response: the first attempt already stored it.
  if (up.error && !(r.existing && /exists|duplicate/i.test(up.error.message))) {
    console.error("Proof of delivery upload failed", { documentId: r.document_id, error: up.error.message });
    // Release the record so the order never lists a document that cannot open (as for the office's documents).
    await admin.from("order_documents").update({ removed_at: new Date().toISOString(), remove_reason: "Upload failed" }).eq("id", r.document_id).is("removed_at", null);
    return reply(502, { error: "The photo could not be stored. Try again." });
  }
  return reply(200, { ok: true, documentId: r.document_id });
}
