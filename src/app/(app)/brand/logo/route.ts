import { NextResponse } from "next/server";
import { getAccess } from "@/server/auth";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

/**
 * The signed-in user's own company logo (company_settings, read with the
 * user's token so row-level security keeps each company to its own logo).
 * Pages link here with ?c=<company>&v=<last update>, so the browser may cache it.
 */
export async function GET() {
  const access = await getAccess();
  if (!access || !access.active) return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  const supabase = await createClient();
  const { data } = await supabase.from("company_settings").select("brand_logo").maybeSingle();
  const match = DATA_URL.exec((data?.brand_logo as string | undefined) ?? "");
  if (!match) return NextResponse.json({ error: "No logo" }, { status: 404 });
  return new NextResponse(Buffer.from(match[2], "base64"), {
    headers: {
      "Content-Type": `image/${match[1]}`,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
