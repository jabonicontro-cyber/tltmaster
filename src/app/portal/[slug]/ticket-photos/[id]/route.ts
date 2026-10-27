import { NextResponse, type NextRequest } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

const LINK_SECONDS = 60;

/**
 * A photo of one of the customer's own confirmed delivery tickets (proof of delivery, B98). The database decides with
 * the customer's own session (public.portal_ticket_photo returns a path only for their confirmed tickets); the
 * service-role client then signs a one-minute link to exactly that file, since portal accounts have no storage access.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  if (!uuid.safeParse(id).success || !/^[a-z0-9-]{1,60}$/.test(slug)) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  const supabase = await createClient();
  const { data: path, error } = await supabase.rpc("portal_ticket_photo", { p_slug: slug, p_attachment: id });
  if (error || typeof path !== "string" || !path) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Photos are not available right now." }, { status: 503 });
  }
  const signed = await admin.storage.from("ticket-photos").createSignedUrl(path, LINK_SECONDS);
  if (signed.error || !signed.data?.signedUrl) return NextResponse.json({ error: "The photo file is missing." }, { status: 404 });
  return NextResponse.redirect(signed.data.signedUrl, { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
