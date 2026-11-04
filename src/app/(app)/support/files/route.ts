import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { storeSupportFile } from "@/server/support/files";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

/** One attachment on a staff message of a support case (B138); the database checks customers.edit and the limits. */
export async function POST(request: NextRequest) {
  const access = await getAccess();
  if (!access?.active || !access.companyId) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  return storeSupportFile(request, async (form, type, size, name) => {
    const message = String(form.get("message") ?? "");
    if (!uuid.safeParse(message).success) return { data: null, error: { message: "Invalid upload." } };
    return (await createClient()).rpc("support_file_begin", { p_message: message, p_mime: type, p_size: size, p_name: name });
  });
}
