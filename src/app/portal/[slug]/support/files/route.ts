import type { NextRequest } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { storeSupportFile } from "@/server/support/files";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

/** One attachment on the customer's own message (B138); public.portal_support_file_begin checks the account and limits. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return storeSupportFile(request, async (form, type, size, name) => {
    const message = String(form.get("message") ?? "");
    if (!uuid.safeParse(message).success) return { data: null, error: { message: "Invalid upload." } };
    return (await createClient()).rpc("portal_support_file_begin", { p_slug: slug, p_message: message, p_mime: type, p_size: size, p_name: name });
  });
}
