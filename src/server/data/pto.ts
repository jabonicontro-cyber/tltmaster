import "server-only";
import type { LedgerKind, PtoBalance, PtoBank, PtoPolicy } from "@/lib/pto";
import { createClient } from "@/server/supabase/server";

// PTO banks and balances (migration 20261112000100). The database decides who sees what: bank definitions are visible
// to the company; balances and history to the employee and people with time_off.balances.

const missing = (code?: string) => code === "PGRST205" || code === "PGRST202" || code === "42P01" || code === "42883";
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** null = the database update for balances is not installed yet. */
export async function listBanks(): Promise<PtoBank[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("pto_banks").select("id, name, categories, employment_types, waiting_days, active").order("active", { ascending: false }).order("name");
  if (error) {
    if (missing(error.code)) return null;
    throw new Error(`Could not load time-off banks: ${error.message}`);
  }
  return (data ?? []) as PtoBank[];
}

function toBalances(rows: unknown): PtoBalance[] {
  return ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ...(r as unknown as PtoBalance),
    balance: num(r.balance),
    pending: num(r.pending),
    available: num(r.available),
  }));
}

/** The caller's own balances (or one employee's, with time_off.balances). [] when not installed. */
export async function balancesFor(employeeId: string | null = null): Promise<PtoBalance[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pto_balances", { p_employee: employeeId });
  if (error) {
    if (missing(error.code)) return [];
    throw new Error(`Could not load balances: ${error.message}`);
  }
  return toBalances(data);
}

export interface OverviewRow {
  employee_id: string;
  employee_name: string;
  employment_type: string;
  hire_date: string | null;
  bank_id: string;
  bank_name: string;
  eligible: boolean;
  balance: number;
  pending: number;
  available: number;
}

export async function balanceOverview(): Promise<OverviewRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pto_balance_overview");
  if (error) throw new Error(`Could not load balances: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({ ...(r as unknown as OverviewRow), balance: num(r.balance), pending: num(r.pending), available: num(r.available) }));
}

export interface LedgerRow {
  id: string;
  bank_id: string;
  employee_id: string;
  kind: LedgerKind;
  hours: number;
  effective_on: string;
  request_id: string | null;
  note: string;
  created_by: string | null;
  created_at: string;
}

/** Balance history the caller may see (own, or everyone's with time_off.balances), newest first. */
export async function ledger(f: { employee?: string; limit?: number } = {}): Promise<LedgerRow[]> {
  const supabase = await createClient();
  let q = supabase.from("pto_ledger").select("id, bank_id, employee_id, kind, hours, effective_on, request_id, note, created_by, created_at").order("created_at", { ascending: false }).limit(f.limit ?? 100);
  if (f.employee) q = q.eq("employee_id", f.employee);
  const { data, error } = await q;
  if (error) {
    if (missing(error.code)) return [];
    throw new Error(`Could not load balance history: ${error.message}`);
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({ ...(r as unknown as LedgerRow), hours: num(r.hours) }));
}

/** Active accrual policies (20261112000300); [] when not installed. */
export async function listPolicies(): Promise<PtoPolicy[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("pto_policies").select("*").eq("active", true).order("created_at");
  if (error) return missing(error.code) ? null : [];
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ...(r as unknown as PtoPolicy),
    amount: num(r.amount),
    per_hours: r.per_hours === null ? null : num(r.per_hours),
    max_balance: r.max_balance === null ? null : num(r.max_balance),
    carryover_cap: r.carryover_cap === null ? null : num(r.carryover_cap),
  }));
}
