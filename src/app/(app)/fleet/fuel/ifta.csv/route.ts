import { NextResponse, type NextRequest } from "next/server";
import { iftaCsv, quarterOf, quarterRange } from "@/lib/fuel/ifta";
import { can } from "@/lib/permissions";
import { getAccess } from "@/server/auth";
import { loadFuel } from "@/server/data/fuel";
import { businessToday } from "@/server/data/settings";

// IFTA summary as CSV for the accountant (B130). fleet.view or accounting.view (B134); the data is read with the person's own session (RLS).
export async function GET(req: NextRequest) {
  const access = await getAccess();
  if (!access?.companyId || !(can(access, "fleet.view") || can(access, "accounting.view"))) return new NextResponse("Not available.", { status: 403 });
  const { today } = await businessToday();
  const m = /^(\d{4})-([1-4])$/.exec(req.nextUrl.searchParams.get("q") ?? "");
  const { year, quarter } = m ? { year: Number(m[1]), quarter: Number(m[2]) } : quarterOf(today);
  const { from, to } = quarterRange(year, quarter);
  const data = await loadFuel(from, to);
  if (!data.installed) return new NextResponse("Not available yet.", { status: 404 });
  return new NextResponse(iftaCsv(data.summary, `${year} Q${quarter} (${from} to ${to})`), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="ifta-${year}-q${quarter}.csv"`, "cache-control": "no-store" },
  });
}
