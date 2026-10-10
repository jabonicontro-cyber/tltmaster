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
 * Attach a scan or photo of the paper ticket to a live ticket (office, tickets.edit).
 * Same safeguards as driver photos: the database reserves the path for this
 * person and company, the storage server accepts only that path with the user's
 * own token, and the database confirms size and type before attaching it and
 * recording it in the ticket history. Repeating with the same upload key is safe.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return reply(403, { error: "Not permitted." });

  const access = await getAccess();
  if (!access) return reply(401, { error: "Sign in again." });
  if (!access.active || !can(access, "tickets.edit")) return reply(403, { error: "Not permitted." });
  const { id: ticketId } = await params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "The upload was incomplete. Try again." });
  }
  const file = form.get("file");
  const uploadKey = String(form.get("upload_key") ?? "");
  if (!(file instanceof File)) return reply(400, { error: "No image was sent." });
  if (!uuid.safeParse(ticketId).success || !uuid.safeParse(uploadKey).success) return reply(400, { error: "Invalid upload." });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkPhoto(bytes, file.type);
  if (!check.ok) return reply(check.status, { error: check.error });
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const supabase = await createClient();
  const begin = await supabase.rpc("begin_ticket_scan", { p_ticket_id: ticketId, p_upload_key: uploadKey, p_mime: check.type, p_size: bytes.length, p_sha256: sha256 });
  if (begin.error) return reply(begin.error.code === "42501" ? 403 : begin.error.code === "P0002" ? 404 : 400, { error: dbErrorMessage(begin.error) });
  const reserved = begin.data as { attachment_id: string; object_path: string; status: string };

  if (reserved.status === "pending") {
    const up = await supabase.storage.from(BUCKET).upload(reserved.object_path, bytes, { contentType: check.type, upsert: false, cacheControl: "private, max-age=0" });
    // An earlier attempt may already have stored it (lost response): attaching decides.
    if (up.error && !/exists|duplicate/i.test(up.error.message)) {
      console.error("Ticket scan upload failed", { attachmentId: reserved.attachment_id, error: up.error.message });
      return reply(502, { error: "The image could not be stored. Try again." });
    }
  }
  const attach = await supabase.rpc("attach_ticket_scan", { p_attachment_id: reserved.attachment_id, p_ticket_id: ticketId });
  if (attach.error) return reply(409, { error: dbErrorMessage(attach.error) });
  return reply(200, { attachmentId: reserved.attachment_id, status: "attached" });
}
