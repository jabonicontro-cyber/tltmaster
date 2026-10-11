import { NextResponse } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

/**
 * A person's profile photo — only your own, or someone's in your current
 * company (checked by public.profile_photo with your own token). Anything else
 * is "not found", so the route reveals nothing about other companies.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const access = await getAccess();
  if (!access) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!uuid.safeParse(userId).success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("profile_photo", { p_user_id: userId });
  const row = (data as Array<{ mime_type: string; data_base64: string }> | null)?.[0];
  if (error || !row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(Buffer.from(row.data_base64, "base64"), {
    headers: {
      "Content-Type": row.mime_type,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
