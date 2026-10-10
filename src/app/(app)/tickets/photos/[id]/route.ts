import { NextResponse, type NextRequest } from "next/server";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

/** Seconds a signed photo link stays valid. Pages always link here, so an expired link is never reused. */
const PHOTO_LINK_SECONDS = 60;

/**
 * Shows an attached ticket photo: checks the viewer's access (table RLS and the
 * storage read policy, both with the viewer's own token) on every request and
 * redirects to a short-lived signed URL.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getAccess();
  if (!access || !access.active || !can(access, "tickets.view")) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  }
  const { id } = await params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  const supabase = await createClient();
  const { data: row } = await supabase.from("ticket_attachments").select("object_path").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  const { data, error } = await supabase.storage.from("ticket-photos").createSignedUrl(row.object_path as string, PHOTO_LINK_SECONDS);
  if (error || !data?.signedUrl) {
    console.error("Ticket photo link failed", { attachmentId: id, error: error?.message });
    return NextResponse.json({ error: "The photo file is missing or cannot be opened. Ask the driver for the paper ticket." }, { status: 404 });
  }
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
