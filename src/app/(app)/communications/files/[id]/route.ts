import { NextResponse, type NextRequest } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

/** Seconds a signed link stays valid. Pages always link here, so an expired link is never reused. */
const LINK_SECONDS = 60;

/**
 * Opens a message attachment: the viewer's access is checked on every request
 * (table RLS and the storage read policy, both with the viewer's own token,
 * follow the message's visibility) before a short-lived signed URL is issued.
 * There are no public URLs.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getAccess();
  if (!access || !access.active) return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  const { id } = await params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "File not found" }, { status: 404 });
  const supabase = await createClient();
  const { data: row } = await supabase.from("message_attachments").select("object_path, file_name").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "File not found" }, { status: 404 });
  const { data, error } = await supabase.storage.from("comm-attachments").createSignedUrl(row.object_path as string, LINK_SECONDS);
  if (error || !data?.signedUrl) {
    console.error("Communications attachment link failed", { attachmentId: id, error: error?.message });
    return NextResponse.json({ error: "The file is missing or cannot be opened." }, { status: 404 });
  }
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
