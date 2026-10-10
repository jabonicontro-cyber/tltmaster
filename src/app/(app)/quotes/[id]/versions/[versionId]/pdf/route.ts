import { NextResponse, type NextRequest } from "next/server";
import { getAccess } from "@/server/auth";
import { can } from "@/lib/permissions";
import { loadQuoteDocument } from "@/server/quotes/document-loader";
import { renderQuotePdf } from "@/server/pdf/quote-pdf";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  const access = await getAccess();
  if (!access || !can(access, "quotes.view")) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  }
  const { id, versionId } = await params;
  const loaded = await loadQuoteDocument(id, versionId).catch(() => null);
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
