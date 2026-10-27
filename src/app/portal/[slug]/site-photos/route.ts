import { NextResponse, type NextRequest } from "next/server";
import { checkPhoto } from "@/lib/files/images";
import { isPortalSlug } from "@/lib/portal";
import { uuid } from "@/lib/schemas/common";
import { portalError } from "@/server/portal";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * One photo for the customer's own pending job-site note (B94). The database, with the customer's own session,
 * checks the submission and reserves the path (portal_site_photo_begin: at most three, type and size); only then does
 * the service-role client store the file at exactly that path in the private site-photos bucket.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return reply(403, { error: "Not permitted." });
  const { slug } = await params;
  if (!isPortalSlug(slug)) return reply(404, { error: "Not found." });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "The upload was incomplete. Try again." });
  }
  const file = form.get("file");
  const submission = String(form.get("submission") ?? "");
  if (!(file instanceof File) || !uuid.safeParse(submission).success) return reply(400, { error: "Invalid upload." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkPhoto(bytes, file.type);
  if (!check.ok) return reply(check.status, { error: check.error });

  const supabase = await createClient();
  const begin = await supabase.rpc("portal_site_photo_begin", { p_slug: slug, p_submission: submission, p_mime: check.type, p_size: bytes.length });
  if (begin.error) return reply(400, { error: portalError(begin.error) });
  if (!adminAvailable()) return reply(503, { error: "Photos cannot be stored right now. Your note was sent without them." });
  const up = await createAdminClient().storage.from("site-photos").upload(begin.data as string, bytes, { contentType: check.type, upsert: false, cacheControl: "private, max-age=0" });
  if (up.error) {
    console.error("Site photo upload failed", { submission, error: up.error.message });
    return reply(502, { error: "The photo could not be stored. Your note was sent without it." });
  }
  return reply(200, { ok: true });
}
