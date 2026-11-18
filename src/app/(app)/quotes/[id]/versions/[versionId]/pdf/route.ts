import { NextResponse, type NextRequest } from "next/server";
import { getAccess } from "@/server/auth";
import { can, canSeeSalesTotals } from "@/lib/permissions";
import { loadQuoteDocument } from "@/server/quotes/document-loader";
import { QUOTES_SENT_BY_OFFICE, QuoteTotalsUnavailableError } from "@/lib/quotes/document";
import { renderQuotePdf } from "@/server/pdf/quote-pdf";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  const access = await getAccess();
  // The quote document shows the customer's prices and totals: billing or pricing access only (SEC7).
  if (!access || !can(access, "quotes.view")) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  }
  if (!canSeeSalesTotals(access)) return NextResponse.json({ error: QUOTES_SENT_BY_OFFICE }, { status: 403 });
  const { id, versionId } = await params;
  let loaded: Awaited<ReturnType<typeof loadQuoteDocument>> = null;
  try {
    loaded = await loadQuoteDocument(id, versionId);
  } catch (e) {
    // Never a PDF with $0.00 in it: no document when the totals could not be read.
    if (e instanceof QuoteTotalsUnavailableError) return NextResponse.json({ error: e.message }, { status: 409 });
    loaded = null;
  }
  if (!loaded) return NextResponse.json({ error: "Quote not found" }, { status: 404 });

  try {
    const { buffer } = await renderQuotePdf(loaded.doc);
    const download = request.nextUrl.searchParams.get("download") === "1";
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${loaded.doc.filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    console.error("Quote PDF generation failed", { quoteId: id, versionId, error: e instanceof Error ? e.message : e });
    return NextResponse.json({ error: "The PDF could not be generated. Use the print preview instead and try again later." }, { status: 500 });
  }
}
