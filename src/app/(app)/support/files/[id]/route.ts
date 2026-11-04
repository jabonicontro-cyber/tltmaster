import { NextResponse, type NextRequest } from "next/server";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { openSupportFile } from "@/server/support/files";

export const runtime = "nodejs";

/** A support attachment for staff (customers.view, checked by public.support_file_path). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getAccess();
  if (!access?.active) return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  const { id } = await params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "File not found" }, { status: 404 });
  return openSupportFile("support_file_path", { p_file: id });
}
