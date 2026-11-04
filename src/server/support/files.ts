import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { detectImageType } from "@/lib/files/images";
import { SUPPORT_MAX_BYTES } from "@/lib/support";
import { dbErrorMessage } from "@/server/errors";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

const BUCKET = "support-files";

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Photos (by their bytes) or PDFs (starting with %PDF-), at most 10 MB; the declared type must match the content. */
export function checkSupportFile(bytes: Uint8Array, declared: string): { ok: true; type: string } | { ok: false; status: number; error: string } {
  if (bytes.length === 0) return { ok: false, status: 400, error: "The file is empty." };
  if (bytes.length > SUPPORT_MAX_BYTES) return { ok: false, status: 413, error: "Each file can be at most 10 MB." };
  const isPdf = bytes.length > 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  const type = isPdf ? "application/pdf" : detectImageType(bytes);
  if (!type) return { ok: false, status: 415, error: "Attach photos (JPEG, PNG, WebP) or PDFs only." };
  if (declared && declared !== type) return { ok: false, status: 415, error: "The file's content does not match its type." };
  return { ok: true, type };
}

/**
 * Store one support attachment: the database (with the person's own session) checks who may attach, the limits, and
 * reserves the path through `begin`; only then does the service-role client store the file at exactly that path.
 */
export async function storeSupportFile(request: NextRequest, begin: (form: FormData, type: string, size: number, name: string) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return reply(403, { error: "Not permitted." });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "The upload was incomplete. Try again." });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return reply(400, { error: "Invalid upload." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkSupportFile(bytes, file.type);
  if (!check.ok) return reply(check.status, { error: check.error });
  const r = await begin(form, check.type, bytes.length, file.name.slice(0, 200));
  if (r.error) return reply(r.error.code === "42501" ? 403 : 400, { error: dbErrorMessage(r.error as never) });
  if (!adminAvailable()) return reply(503, { error: "Files cannot be stored right now. The message was sent without them." });
  const up = await createAdminClient().storage.from(BUCKET).upload(r.data as string, bytes, { contentType: check.type, upsert: false, cacheControl: "private, max-age=0" });
  if (up.error) {
    console.error("Support file upload failed", { error: up.error.message });
    return reply(502, { error: "The file could not be stored. The message was sent without it." });
  }
  return reply(200, { ok: true });
}

/** Redirect to a one-minute signed link for a file the database says this person may open. */
export async function openSupportFile(fn: string, args: Record<string, unknown>) {
  const { data } = await (await createClient()).rpc(fn, args);
  const f = data as { path?: string; name?: string } | null;
  if (!f?.path || !adminAvailable()) return NextResponse.json({ error: "File not found" }, { status: 404 });
  const signed = await createAdminClient().storage.from(BUCKET).createSignedUrl(f.path, 60, { download: f.path.endsWith(".pdf") ? (f.name ?? true) : undefined });
  if (signed.error || !signed.data?.signedUrl) return NextResponse.json({ error: "The file is missing." }, { status: 404 });
  return NextResponse.redirect(signed.data.signedUrl, { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
