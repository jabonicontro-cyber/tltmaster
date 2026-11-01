import { NextResponse, type NextRequest } from "next/server";
import { can } from "@/lib/permissions";
import { getAccess } from "@/server/auth";
import { getInvoice } from "@/server/data/invoices";
import { buildInvoiceDocument } from "@/server/invoices/document";
import { renderInvoicePdf } from "@/server/pdf/invoice-pdf";

export const runtime = "nodejs";

/** The invoice as a PDF (billing.view; the database returns only the caller's company's invoices). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getAccess();
  if (!access || !can(access, "billing.view")) return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  const inv = await getInvoice(id).catch(() => null);
  if (!inv) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  try {
    const doc = await buildInvoiceDocument(inv);
    const { buffer } = await renderInvoicePdf(doc);
    const download = request.nextUrl.searchParams.get("download") === "1";
    return new NextResponse(new Uint8Array(buffer), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${doc.filename}"`, "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    console.error("Invoice PDF generation failed", { invoiceId: id, error: e instanceof Error ? e.message : e });
    return NextResponse.json({ error: "The PDF could not be generated. Try again later." }, { status: 500 });
  }
}
