import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAccess } from "@/server/auth";
import { storeOrderDocument } from "@/server/orders/documents";

export const runtime = "nodejs";

/** Add one document to an order (MK2); public.order_document_begin checks orders.edit, the stop and the limits. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getAccess();
  if (!access?.active || !access.companyId) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  return storeOrderDocument(request, (await params).id);
}
