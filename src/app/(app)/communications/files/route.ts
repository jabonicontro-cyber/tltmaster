import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { checkAttachment } from "@/lib/communications";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

const BUCKET = "comm-attachments";

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Upload one file for a message. The database reserves the path (and checks
 * membership of the conversation), the storage server accepts the object only
 * at that path (storage RLS with the user's own token), and the database then
 * confirms size and type. The file becomes visible to others only when it is
 * sent with a message. Repeating a request with the same upload key is safe.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return reply(403, { error: "Not permitted." });

  const access = await getAccess();
  if (!access) return reply(401, { error: "Sign in again." });
  if (!access.active || !can(access, "comms.message")) return reply(403, { error: "Not permitted." });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "The upload was incomplete. Try again." });
  }
  const file = form.get("file");
  const conversationId = String(form.get("conversation_id") ?? "");
  const uploadKey = String(form.get("upload_key") ?? "");
  if (!(file instanceof File)) return reply(400, { error: "No file was sent." });
  if (!uuid.safeParse(conversationId).success || !uuid.safeParse(uploadKey).success) return reply(400, { error: "Invalid upload." });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkAttachment(bytes, file.type);
  if (!check.ok) return reply(check.status, { error: check.error });
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const supabase = await createClient();
  const begin = await supabase.rpc("comm_begin_attachment", {
    p_conversation: conversationId, p_upload_key: uploadKey, p_file_name: file.name || "file", p_mime: check.type, p_size: bytes.length, p_sha256: sha256,
  });
  if (begin.error) {
    if (begin.error.code === "PGRST202") return reply(503, { error: "Attachments need a database update that has not been installed yet." });
    return reply(begin.error.code === "42501" ? 403 : 400, { error: dbErrorMessage(begin.error) });
  }
  const reserved = begin.data as { attachment_id: string; object_path: string; status: string };

  if (reserved.status === "pending") {
    const up = await supabase.storage.from(BUCKET).upload(reserved.object_path, bytes, { contentType: check.type, upsert: false, cacheControl: "private, max-age=0" });
    if (up.error && !/exists|duplicate/i.test(up.error.message)) {
      console.error("Communications attachment upload failed", { attachmentId: reserved.attachment_id, error: up.error.message });
      return reply(502, { error: "The file could not be stored. Try again." });
    }
  }
  const confirm = await supabase.rpc("comm_confirm_attachment", { p_attachment: reserved.attachment_id });
  if (confirm.error) return reply(409, { error: dbErrorMessage(confirm.error) });
  return reply(200, { attachmentId: reserved.attachment_id, status: (confirm.data as { status: string }).status, name: file.name, size: bytes.length, type: check.type });
}
