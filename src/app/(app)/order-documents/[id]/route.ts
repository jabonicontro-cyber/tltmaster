import { NextResponse } from "next/server";
import { getAccess } from "@/server/auth";
import { openOrderDocument } from "@/server/orders/documents";

export const runtime = "nodejs";

/** Open an order document (orders.view, checked by public.order_document_path) through a one-minute signed link. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getAccess();
  if (!access?.active || !access.companyId) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  return openOrderDocument((await params).id);
}
