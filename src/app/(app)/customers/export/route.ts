import { NextResponse } from "next/server";
import { can } from "@/lib/permissions";
import { csvField } from "@/lib/payroll/export";
import { getAccess } from "@/server/auth";
import { listCustomers } from "@/server/data/customers";
import { PAGE_SIZE } from "@/server/data/search";

export const runtime = "nodejs";

/**
 * The customer list as a CSV file, with the same filters as the page (customers.view; RLS keeps it to the company).
 * Fields that a spreadsheet could read as a formula are neutralised (csvField). Up to 50 pages of the list.
 */
export async function GET(request: Request) {
  const access = await getAccess();
  if (!access || !can(access, "customers.view")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const sp = new URL(request.url).searchParams;
  const get = (k: string) => sp.get(k) ?? undefined;
  const header = ["Customer number", "Name", "Relationship", "Type", "Email", "Phone", "City", "State", "Tags", "Active"];
  const lines = [header.map(csvField).join(",")];
  for (let page = 1; page <= 50; page++) {
    const { rows, total } = await listCustomers({ q: get("q"), type: get("type"), status: get("status"), relationship: get("relationship"), tag: get("tag"), sort: "number", page });
    for (const c of rows) {
      lines.push([c.customer_number, c.name, c.relationship ?? "customer", c.customer_type, c.email ?? "", c.phone ?? "", c.billing_city ?? "", c.billing_state ?? "", (c.tags ?? []).join("; "), c.active ? "yes" : "no"].map(csvField).join(","));
    }
    if (page * PAGE_SIZE >= total || rows.length === 0) break;
  }
  return new NextResponse(lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
