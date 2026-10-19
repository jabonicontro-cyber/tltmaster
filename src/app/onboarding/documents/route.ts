import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { checkOnboardingFile } from "@/lib/onboarding/tasks";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { assertPlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

const BUCKET = "onboarding-documents";

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Upload one document to an onboarding task (20261120001000). The caller is either the company side (settings.manage,
 * two-step verification as the company requires) or Taviron (platform administrator with aal2). The database reserves
 * the path inside the task's company folder and checks the caller again; storage accepts the object only at that path
 * (storage RLS with the user's own token); the database then confirms size and type. Repeating a request with the same
 * upload key is safe. Files are never public: downloads go through /onboarding/documents/[id].
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return reply(403, { error: "Not permitted." });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "The upload was incomplete. Try again." });
  }
  try {
    if (form.get("side") === "platform") await assertPlatformAdmin();
    else await assertPermission("settings.manage");
  } catch {
    return reply(403, { error: "Not permitted." });
  }
  const file = form.get("file");
  const taskId = String(form.get("task") ?? "");
  const uploadKey = String(form.get("upload_key") ?? "");
  if (!(file instanceof File)) return reply(400, { error: "No file was sent." });
  if (!uuid.safeParse(taskId).success || !uuid.safeParse(uploadKey).success) return reply(400, { error: "Invalid upload." });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkOnboardingFile(bytes, file.name || "");
  if (!check.ok) return reply(check.status, { error: check.error });
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const supabase = await createClient();
  const begin = await supabase.rpc("onboarding_begin_document", {
    p_task: taskId, p_upload_key: uploadKey, p_file_name: file.name || "file", p_mime: check.type, p_size: bytes.length, p_sha256: sha256,
  });
  if (begin.error) {
    if (begin.error.code === "PGRST202") return reply(503, { error: "Documents need a database update that has not been installed yet." });
    return reply(begin.error.code === "P0002" ? 404 : begin.error.code === "23505" ? 409 : 400, { error: dbErrorMessage(begin.error) });
  }
  const reserved = begin.data as { document_id: string; object_path: string; status: string };
  if (reserved.status === "pending") {
    const up = await supabase.storage.from(BUCKET).upload(reserved.object_path, bytes, { contentType: check.type, upsert: false, cacheControl: "private, max-age=0" });
    if (up.error && !/exists|duplicate/i.test(up.error.message)) {
      console.error("Onboarding document upload failed", { documentId: reserved.document_id, error: up.error.message });
      return reply(502, { error: "The file could not be stored. Try again." });
    }
  }
  const confirm = await supabase.rpc("onboarding_confirm_document", { p_document: reserved.document_id });
  if (confirm.error) return reply(409, { error: dbErrorMessage(confirm.error) });
  return reply(200, { documentId: reserved.document_id, name: file.name, size: bytes.length, type: check.type });
}
