import { NextResponse, type NextRequest } from "next/server";
import { defaultYear, invoicesCsv, paymentsCsv } from "@/lib/accounting/year";
import { can } from "@/lib/permissions";
import { getAccess } from "@/server/auth";
import { loadAccountingYear, recordAccountantVisit } from "@/server/data/accountant-view";
import { businessToday } from "@/server/data/settings";

// Accountant view downloads (B134): a year's invoices or payments as CSV. accounting.view; read with the person's own
// session (RLS); each download is recorded like a visit.
export async function GET(req: NextRequest) {
  const access = await getAccess();
  if (!access?.companyId || !can(access, "accounting.view")) return new NextResponse("Not available.", { status: 403 });
  const { today } = await businessToday();
  const y = Number(req.nextUrl.searchParams.get("year"));
  const year = Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : defaultYear(today);
  const kind = req.nextUrl.searchParams.get("kind") === "payments" ? "payments" : "invoices";
  const data = await loadAccountingYear(year, today, false);
  if (!data.invoicesInstalled) return new NextResponse("Not available yet.", { status: 404 });
  await recordAccountantVisit(`download ${kind} ${year}`).catch(() => undefined);
  return new NextResponse(kind === "payments" ? paymentsCsv(data.summary) : invoicesCsv(data.summary), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${kind}-${year}.csv"`, "cache-control": "no-store" },
  });
}
