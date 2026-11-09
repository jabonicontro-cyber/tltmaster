import { NextResponse, type NextRequest } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

/**
 * A driver report photo (migration 20261120011100) for people allowed to see the report: the database answers with the
 * viewer's own session (field_report_photo_path reads under the report's row-level security); the service role then
 * signs a one-minute link to the file in the private bucket.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getAccess();
  if (!access || !access.active) return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  const { id } = await params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  const { data: path } = await (await createClient()).rpc("field_report_photo_path", { p_photo: id });
  if (typeof path !== "string" || !path || !adminAvailable()) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  const signed = await createAdminClient().storage.from("field-report-photos").createSignedUrl(path, 60);
  if (signed.error || !signed.data?.signedUrl) return NextResponse.json({ error: "The photo file is missing." }, { status: 404 });
  return NextResponse.redirect(signed.data.signedUrl, { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
