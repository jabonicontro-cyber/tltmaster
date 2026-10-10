import "server-only";
import type { ReportKind } from "@/lib/driver/rules";
import { uuid } from "@/lib/schemas/common";
import { createClient } from "@/server/supabase/server";

export interface FieldReportRow {
  id: string;
  kind: ReportKind;
  status: "open" | "acknowledged" | "resolved";
  driver_id: string;
  assignment_id: string;
  load_id: string;
  order_id: string;
  equipment: "" | "truck" | "trailer";
  truck_id: string | null;
  trailer_id: string | null;
  description: string;
  snapshot: { order_number: string; load_number: number; load_date: string; customer_name: string | null; truck_unit: string | null; trailer_unit: string | null; driver_name: string };
  created_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  acknowledge_note: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string;
}

export const REPORT_VIEWS = { open: "Open", acknowledged: "Acknowledged", resolved: "Resolved", all: "All" } as const;
export type ReportView = keyof typeof REPORT_VIEWS;

/** Reports the caller may see (RLS: equipment reports with field_reports.view, delay reports also need dispatch.view). */
export async function listFieldReports(view: ReportView) {
  const supabase = await createClient();
  let q = supabase.from("field_reports").select("*").order("created_at", { ascending: false }).limit(200);
  if (view !== "all") q = q.eq("status", view);
  const [rows, open, ack] = await Promise.all([
    q,
    supabase.from("field_reports").select("id", { count: "exact", head: true }).eq("status", "open"),
    supabase.from("field_reports").select("id", { count: "exact", head: true }).eq("status", "acknowledged"),
  ]);
  if (rows.error) throw new Error(`Could not load reports: ${rows.error.message}`);
  return { rows: (rows.data ?? []) as FieldReportRow[], counts: { open: open.count ?? 0, acknowledged: ack.count ?? 0 } };
}

export async function getFieldReport(id: string) {
  if (!uuid.safeParse(id).success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("field_reports").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load the report: ${error.message}`);
  return (data ?? null) as FieldReportRow | null;
}
