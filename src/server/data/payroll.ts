import "server-only";
import { createClient } from "@/server/supabase/server";

// Payroll reads (20261118000200). Every table is readable only with payroll.manage in the caller's company (RLS);
// null means the database update is not installed yet.

export interface PayrollSettings { enabled: boolean; period_length: string | null; period_anchor: string | null; updated_at: string | null }
export interface RuleVersionRow {
  id: string; rule_id: string; version: number; status: "draft" | "active" | "retired"; formula: string; rate: string | null; unit_code: string | null;
  scope: Record<string, string>; effective_from: string; effective_to: string | null; evidence_note: string; approved_at: string | null; approved_by: string | null; created_at: string;
}
export interface RuleRow { id: string; name: string; versions: RuleVersionRow[] }
export interface PeriodRow { id: string; starts_on: string; ends_on: string; status: string; totals: { total_cents: number; drivers: Array<{ driver_id: string; total_cents: number }> } | null; approved_at: string | null }

const missing = (e: { code?: string } | null) => Boolean(e && (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST202"));

export async function loadPayrollHome(): Promise<{ settings: PayrollSettings; rules: RuleRow[]; periods: PeriodRow[] } | null> {
  const supabase = await createClient();
  const [settings, rules, versions, periods] = await Promise.all([
    supabase.from("payroll_settings").select("enabled, period_length, period_anchor, updated_at").maybeSingle(),
    supabase.from("pay_rules").select("id, name").order("name"),
    supabase.from("pay_rule_versions").select("id, rule_id, version, status, formula, rate, unit_code, scope, effective_from, effective_to, evidence_note, approved_at, approved_by, created_at").order("version", { ascending: false }),
    supabase.from("payroll_periods").select("id, starts_on, ends_on, status, totals, approved_at").order("starts_on", { ascending: false }).limit(52),
  ]);
  if (missing(settings.error) || missing(rules.error)) return null;
  if (settings.error || rules.error || versions.error || periods.error) throw new Error("Payroll could not be loaded.");
  const v = (versions.data ?? []) as Array<RuleVersionRow & { rate: string | number | null }>;
  return {
    settings: (settings.data as PayrollSettings | null) ?? { enabled: false, period_length: null, period_anchor: null, updated_at: null },
    rules: ((rules.data ?? []) as Array<{ id: string; name: string }>).map((r) => ({
      ...r,
      versions: v.filter((x) => x.rule_id === r.id).map((x) => ({ ...x, rate: x.rate === null ? null : String(x.rate) })),
    })),
    periods: (periods.data ?? []) as PeriodRow[],
  };
}

export interface EntryRow {
  id: string; ticket_id: string; driver_id: string; status: "calculated" | "exception" | "excluded" | "reversed"; amount_cents: number | null;
  breakdown: string; exception: string; note: string; rule_version_id: string | null; calculated_at: string;
  delivery_tickets: { ticket_number: string; delivered_at: string; quantity: number; unit_code: string; status: string } | null;
}
export interface AdjustmentRow { id: string; driver_id: string; entry_id: string | null; amount_cents: number; reason: string; created_at: string }
export interface ExportRow { id: string; format: string; status: string; row_count: number; total_cents: number; reference: string; note: string; created_at: string; content_hash: string }
export interface PeriodWork {
  payable: Array<{ ticket_id: string; ticket_number: string; driver_id: string; delivered_on: string; quantity: number; unit_code: string }>;
  not_payable: Array<{ ticket_id: string; ticket_number: string; status: string; driver_id: string | null; reason: "no_driver" | "not_verified" }>;
  corrections: Array<{ entry_id: string; ticket_id: string; ticket_number: string; ticket_status: string; driver_id: string; amount_cents: number; paid_in: string }>;
}

export async function loadPeriod(id: string) {
  const supabase = await createClient();
  const { data: period, error } = await supabase.from("payroll_periods").select("*").eq("id", id).maybeSingle();
  if (error && missing(error)) return null;
  if (error) throw new Error("The payroll period could not be loaded.");
  if (!period) return null;
  const [entries, adjustments, exports, work, drivers, versions] = await Promise.all([
    supabase.from("payroll_entries").select("id, ticket_id, driver_id, status, amount_cents, breakdown, exception, note, rule_version_id, calculated_at, delivery_tickets(ticket_number, delivered_at, quantity, unit_code, status)").eq("period_id", id).order("calculated_at"),
    supabase.from("payroll_adjustments").select("id, driver_id, entry_id, amount_cents, reason, created_at").eq("period_id", id).order("created_at"),
    supabase.from("payroll_exports").select("id, format, status, row_count, total_cents, reference, note, created_at, content_hash").eq("period_id", id).order("created_at", { ascending: false }),
    supabase.rpc("payroll_period_work", { p_period: id }),
    supabase.from("drivers").select("id, name, employee_number"),
    supabase.from("pay_rule_versions").select("id, version, pay_rules(name)"),
  ]);
  for (const r of [entries, adjustments, exports, work, drivers, versions]) if (r.error) throw new Error("The payroll period could not be loaded.");
  return {
    period: period as PeriodRow & { reconciled_note: string; created_at: string },
    entries: (entries.data ?? []) as unknown as EntryRow[],
    adjustments: (adjustments.data ?? []) as AdjustmentRow[],
    exports: (exports.data ?? []) as ExportRow[],
    work: work.data as PeriodWork,
    drivers: new Map(((drivers.data ?? []) as Array<{ id: string; name: string; employee_number: string | null }>).map((d) => [d.id, d])),
    ruleNames: new Map(((versions.data ?? []) as unknown as Array<{ id: string; version: number; pay_rules: { name: string } | null }>).map((v) => [v.id, `${v.pay_rules?.name ?? "Rule"} v${v.version}`])),
  };
}

/** Recent verified tickets, for previewing a draft rule against real work before it is activated. */
export async function previewTickets(limit = 8) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("delivery_tickets")
    .select("id, ticket_number, revision, driver_id, delivered_at, quantity, unit_code, order_id, order_line_id, material_id, truck_id, orders(customer_id)")
    .eq("status", "accepted")
    .not("driver_id", "is", null)
    .order("delivered_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as unknown as Array<{ id: string; ticket_number: string; revision: number; driver_id: string; delivered_at: string; quantity: number; unit_code: string; order_id: string; order_line_id: string | null; material_id: string | null; truck_id: string | null; orders: { customer_id: string } | null }>);
}
