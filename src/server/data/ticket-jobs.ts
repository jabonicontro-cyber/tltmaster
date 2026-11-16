import "server-only";
import { createClient } from "@/server/supabase/server";
import { businessToday } from "./settings";
import type { OrderListRow, UnitRow } from "./types";

/** A job a ticket can be entered against without dispatch (MOD1): an order that takes tickets, with its unit lines. */
export interface TicketJob {
  id: string;
  order_number: string;
  customer_id: string;
  customer_name: string;
  label: string;
  status: string;
  lines: Array<{ id: string; description: string; unit_code: string | null; quantity: number | string | null }>;
}

/**
 * Everything the ticket form needs when the company has Dispatch off (MOD1, docs/MODULES.md §5): customers, their open
 * jobs with material lines, the catalog for a new job, units, trucks, trailers and drivers (all optional on the ticket).
 * Read with the person's own permissions (row-level security).
 */
export async function getTicketEntryWithoutDispatch() {
  const supabase = await createClient();
  const [customers, orders, materials, units, trucks, trailers, drivers, settings, { today }] = await Promise.all([
    supabase.from("customers").select("id, name, tax_exempt").eq("active", true).order("name").limit(2000),
    supabase
      .from("order_list")
      .select("id, order_number, customer_id, customer_name, project_name, site_label, site_line1, status")
      .in("status", ["scheduled", "dispatched", "in_progress", "partially_completed"])
      .order("order_number", { ascending: false })
      .limit(500),
    supabase.from("materials").select("id, name, default_unit_code, taxable_default").eq("active", true).order("name"),
    supabase.from("units_of_measure").select("*").eq("active", true).order("sort_order"),
    supabase.from("trucks").select("id, unit_number, active").eq("active", true).order("unit_number"),
    supabase.from("trailers").select("id, unit_number, active").eq("active", true).order("unit_number"),
    supabase.from("driver_list").select("id, display_name, active").eq("active", true).order("display_name"),
    supabase.from("company_settings").select("default_tax_rate_bp, ticket_reference_required").maybeSingle(),
    businessToday(),
  ]);
  type OrderPick = Pick<OrderListRow, "id" | "order_number" | "customer_id" | "customer_name" | "project_name" | "site_label" | "site_line1" | "status">;
  const orderRows = (orders.data ?? []) as OrderPick[];
  const ids = orderRows.map((o) => o.id);
  type LinePick = { id: string; order_id: string; description: string; unit_code: string | null; quantity: number | string | null };
  const lines: LinePick[] = ids.length
    ? (((await supabase.from("order_lines").select("id, order_id, description, unit_code, quantity").in("order_id", ids).eq("calc_method", "per_unit").neq("kind", "discount").order("line_no")).data ?? []) as LinePick[])
    : [];
  const byOrder = new Map<string, TicketJob["lines"]>();
  for (const l of lines) byOrder.set(l.order_id, [...(byOrder.get(l.order_id) ?? []), { id: l.id, description: l.description, unit_code: l.unit_code, quantity: l.quantity }]);
  const jobs: TicketJob[] = orderRows
    .filter((o) => byOrder.has(o.id))
    .map((o) => ({
      id: o.id,
      order_number: o.order_number,
      customer_id: o.customer_id,
      customer_name: o.customer_name,
      label: [o.project_name, o.site_label || o.site_line1].filter(Boolean).join(" · "),
      status: o.status,
      lines: byOrder.get(o.id)!,
    }));
  const s = (settings.data ?? null) as { default_tax_rate_bp?: number; ticket_reference_required?: boolean } | null;
  return {
    customers: (customers.data ?? []) as Array<{ id: string; name: string; tax_exempt: boolean }>,
    jobs,
    materials: (materials.data ?? []) as Array<{ id: string; name: string; default_unit_code: string; taxable_default: boolean }>,
    units: (units.data ?? []) as UnitRow[],
    trucks: (trucks.data ?? []) as Array<{ id: string; unit_number: string; active: boolean }>,
    trailers: (trailers.data ?? []) as Array<{ id: string; unit_number: string; active: boolean }>,
    drivers: (drivers.data ?? []) as Array<{ id: string; display_name: string; active: boolean }>,
    defaultTaxRateBp: s?.default_tax_rate_bp ?? 0,
    referenceRequired: s?.ticket_reference_required ?? true,
    today,
  };
}

export type TicketEntryWithoutDispatch = Awaited<ReturnType<typeof getTicketEntryWithoutDispatch>>;
