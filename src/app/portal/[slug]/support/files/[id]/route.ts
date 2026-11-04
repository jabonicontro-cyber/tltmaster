import { NextResponse, type NextRequest } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { openSupportFile } from "@/server/support/files";

export const runtime = "nodejs";

/** A support attachment for the customer (their own cases, never files on internal notes). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "File not found" }, { status: 404 });
  return openSupportFile("portal_support_file_path", { p_slug: slug, p_file: id });
}
