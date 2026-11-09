import { NextResponse, type NextRequest } from "next/server";
import { isPortalSlug } from "@/lib/portal";
import { parseTicketFilter, ticketsCsv, ticketsCsvName } from "@/lib/portal-tickets";
import { portalTickets } from "@/server/portal";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

/**
 * The customer's filtered ticket list as a CSV file. The same path as the Tickets page: public.portal_tickets with the
 * signed-in customer's own session decides who the customer is and what they may see (their own tickets only, the
 * company's Documents switch on); this route only shapes the file. Signed out or refused: no file.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isPortalSlug(slug)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return NextResponse.json({ error: "Sign in to the customer portal first." }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  // The sites are not known here; the database checks that a site is one of the customer's own.
  const filter = parseTicketFilter({ from: sp.get("from"), to: sp.get("to"), site: sp.get("site") }, null);
  const result = await portalTickets(slug, filter);
  if (!result.ok) {
    if (result.reason === "invalid") return NextResponse.json({ error: result.message ?? "Check the dates." }, { status: 400 });
    return NextResponse.json({ error: "Not available." }, { status: result.reason === "missing" ? 404 : 403 });
  }
  // A byte-order mark so spreadsheet programs read names with accents correctly.
  return new NextResponse(`﻿${ticketsCsv(result.data.tickets)}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ticketsCsvName(filter)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
