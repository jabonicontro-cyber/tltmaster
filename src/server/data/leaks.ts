import "server-only";
import type { Leak, LeakKind } from "@/lib/billing/leaks";
import { createClient } from "@/server/supabase/server";

// Revenue leakage finder (B110, migration 20261120005100). public.revenue_leaks runs as the caller, so company,
// billing.view and dispatch-base access apply. Returns null before the migration is installed.

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

type Row = {
  finding_key: string; kind: LeakKind; order_id: string; order_number: string; customer_name: string; ref_id: string; ref_label: string;
  detail: string; amount_cents: number | string | null; estimated: boolean; since: string | null; checked_reason: string | null; checked_at: string | null;
};

export async function listLeaks(days = 7, includeChecked = false): Promise<Leak[] | null> {
  const { data, error } = await (await createClient()).rpc("revenue_leaks", { p_days: days, p_include_checked: includeChecked });
  if (error) {
    if (MISSING.has(error.code ?? "")) return null;
    throw new Error(`Could not load revenue findings: ${error.message}`);
  }
  return ((data ?? []) as Row[]).map((r) => ({
    key: r.finding_key, kind: r.kind, orderId: r.order_id, orderNumber: r.order_number, customerName: r.customer_name, refId: r.ref_id,
    refLabel: r.ref_label, detail: r.detail, amountCents: r.amount_cents === null ? null : Number(r.amount_cents), estimated: r.estimated,
    since: r.since, checkedReason: r.checked_reason, checkedAt: r.checked_at,
  }));
}
