import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { dbErrorMessage } from "@/server/errors";
import { checkSupportFile } from "@/server/support/files";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

// Order documents (MK2, migration 20261120009500): rate confirmations, bills of lading and proofs of delivery on an
// order. The database (with the person's own session) checks orders.edit, the stop, the type, size and count, and
// reserves the path; only then does the service-role client store the file at exactly that path.

const BUCKET = "order-documents";
const KINDS = new Set(["rate_confirmation", "bill_of_lading", "proof_of_delivery", "other"]);

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function storeOrderDocument(request: NextRequest, orderId: string) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return reply(403, { error: "Not permitted." });
  if (!uuid.safeParse(orderId).success) return reply(404, { error: "Order not found." });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "The upload was incomplete. Try again." });
  }
  const file = form.get("file");
  const kind = String(form.get("kind") ?? "");
  const stop = String(form.get("stop") ?? "");
  if (!(file instanceof File) || !KINDS.has(kind) || (stop && !uuid.safeParse(stop).success)) return reply(400, { error: "Invalid upload." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkSupportFile(bytes, file.type);
  if (!check.ok) return reply(check.status, { error: check.error.replace("Attach", "Add") });
  if (!adminAvailable()) return reply(503, { error: "Documents cannot be stored right now. Try again later." });
  const r = await (await createClient()).rpc("order_document_begin", { p_order: orderId, p_stop: stop || null, p_kind: kind, p_mime: check.type, p_size: bytes.length, p_name: file.name.slice(0, 200) });
  if (r.error) return reply(r.error.code === "42501" ? 403 : 400, { error: dbErrorMessage(r.error) });
  const up = await createAdminClient().storage.from(BUCKET).upload(r.data as string, bytes, { contentType: check.type, upsert: false, cacheControl: "private, max-age=0" });
  if (up.error) {
    console.error("Order document upload failed", { error: up.error.message });
    return reply(502, { error: "The file could not be stored. Try again." });
  }
  return reply(200, { ok: true });
}

/** Redirect to a one-minute signed link for a document the database says this person may open. */
export async function openOrderDocument(documentId: string) {
  if (!uuid.safeParse(documentId).success) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  const { data } = await (await createClient()).rpc("order_document_path", { p_document: documentId });
  const f = data as { path?: string; name?: string } | null;
  if (!f?.path || !adminAvailable()) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  const signed = await createAdminClient().storage.from(BUCKET).createSignedUrl(f.path, 60, { download: f.path.endsWith(".pdf") ? (f.name ?? true) : undefined });
  if (signed.error || !signed.data?.signedUrl) return NextResponse.json({ error: "The file is missing." }, { status: 404 });
  return NextResponse.redirect(signed.data.signedUrl, { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
