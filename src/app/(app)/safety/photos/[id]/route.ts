import { NextResponse, type NextRequest } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

/**
 * A safety incident photo (B103) for people allowed to see it: the database answers with the viewer's own session
 * (public.safety_photo_path: safety.view or the reporter); the service role then signs a one-minute link to the file.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getAccess();
  if (!access || !access.active) return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  const { id } = await params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  const { data: path } = await (await createClient()).rpc("safety_photo_path", { p_photo: id });
  if (typeof path !== "string" || !path || !adminAvailable()) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  const signed = await createAdminClient().storage.from("safety-photos").createSignedUrl(path, 60);
  if (signed.error || !signed.data?.signedUrl) return NextResponse.json({ error: "The photo file is missing." }, { status: 404 });
  return NextResponse.redirect(signed.data.signedUrl, { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
