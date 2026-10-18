import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { detailCsv, summaryCsv } from "@/lib/payroll/export";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { can } from "@/lib/permissions";
import { loadPeriod } from "@/server/data/payroll";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

/**
 * Download an approved period's payroll file. Built from the approved records only; recorded with its content hash
 * (payroll_export_record refuses unapproved periods and totals that differ from the approved total; the same file is
 * the same export). payroll.manage only — checked here and in the database.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getAccess();
  if (!access || !can(access, "payroll.manage")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const format = new URL(request.url).searchParams.get("format") === "detail_csv" ? "detail_csv" : "summary_csv";
  const p = await loadPeriod(id);
  if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!p.period.totals) return NextResponse.json({ error: "Approve the period before exporting it." }, { status: 409 });
  const driver = (d: string) => p.drivers.get(d);
  const live = p.entries.filter((e) => e.status === "calculated");
  let csv: string;
  let rows: number;
  if (format === "summary_csv") {
    const byDriver = (p.period.totals as unknown as { drivers: Array<{ driver_id: string; tickets: number; earnings_cents: number; adjustments_cents: number; total_cents: number }> }).drivers;
    csv = summaryCsv(p.period, byDriver.map((d) => ({ driver_name: driver(d.driver_id)?.name ?? "", employee_number: driver(d.driver_id)?.employee_number ?? "", tickets: d.tickets, earnings_cents: d.earnings_cents, adjustments_cents: d.adjustments_cents, total_cents: d.total_cents })));
    rows = byDriver.length;
  } else {
    csv = detailCsv(p.period, live.map((e) => ({
      driver_name: driver(e.driver_id)?.name ?? "", employee_number: driver(e.driver_id)?.employee_number ?? "",
      ticket_number: e.delivery_tickets?.ticket_number ?? "", delivered_on: e.delivery_tickets?.delivered_at.slice(0, 10) ?? "",
      quantity: String(e.delivery_tickets?.quantity ?? ""), unit_code: e.delivery_tickets?.unit_code ?? "",
      rule: e.rule_version_id ? p.ruleNames.get(e.rule_version_id) ?? "" : "", breakdown: e.breakdown, amount_cents: e.amount_cents ?? 0,
    })).concat(p.adjustments.map((a) => ({
      driver_name: driver(a.driver_id)?.name ?? "", employee_number: driver(a.driver_id)?.employee_number ?? "",
      ticket_number: "", delivered_on: "", quantity: "", unit_code: "", rule: "Adjustment", breakdown: a.reason, amount_cents: a.amount_cents,
    }))));
    rows = live.length + p.adjustments.length;
  }
  const hash = createHash("sha256").update(csv).digest("hex");
  const supabase = await createClient();
  // Both files add up to the approved total (detail: ticket earnings plus adjustment rows); the database checks it.
  const fileTotal = format === "summary_csv"
    ? (p.period.totals as unknown as { drivers: Array<{ total_cents: number }> }).drivers.reduce((n, d) => n + d.total_cents, 0)
    : live.reduce((n, e) => n + (e.amount_cents ?? 0), 0) + p.adjustments.reduce((n, a) => n + a.amount_cents, 0);
  const { error } = await supabase.rpc("payroll_export_record", { p_period: id, p_format: format, p_hash: hash, p_rows: rows, p_total_cents: fileTotal });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-${p.period.starts_on}-${p.period.ends_on}-${format === "summary_csv" ? "summary" : "detail"}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
