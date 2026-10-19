import { NextResponse, type NextRequest } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { mfaBlocks } from "@/server/mfa";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

const BUCKET = "onboarding-documents";

/**
 * Open an onboarding document: the database decides (company side with settings.manage, or Taviron with aal2), then a
 * 60-second signed link from Storage, which checks the same rule again with the user's own token. Downloaded as an
 * attachment so a CSV or PDF never renders inside the app's origin.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.safeParse(id).success) return new NextResponse("Not found", { status: 404 });
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return new NextResponse("Sign in first", { status: 401 });
  if (await mfaBlocks()) return new NextResponse("Two-step verification required", { status: 403 });
  const { data, error } = await supabase.rpc("onboarding_document_path", { p_document: id });
  if (error || !data) return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const doc = data as { object_path: string; file_name: string };
  const signed = await supabase.storage.from(BUCKET).createSignedUrl(doc.object_path, 60, { download: doc.file_name });
  if (signed.error || !signed.data?.signedUrl) return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return NextResponse.redirect(signed.data.signedUrl, { headers: { "Cache-Control": "no-store" } });
}
