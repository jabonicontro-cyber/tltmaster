import "server-only";
import { uuid } from "@/lib/schemas/common";
import { createClient } from "@/server/supabase/server";

// Shop parts inventory (B105, migration 20261120004500), read with the person's session: parts and movements with
// maintenance.view (RLS); unit costs only through part_costs() for maintenance.costs. Before the migration is
// installed the loaders say so.

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

export interface PartRow { id: string; part_number: string; name: string; unit: string; location: string; on_hand: number; reorder_point: number; active: boolean }
export interface PartMovement { id: number; part_id: string; kind: "received" | "used" | "adjusted"; quantity: number; work_order_id: string | null; note: string; created_by: string | null; created_at: string }

export async function listParts(): Promise<{ installed: boolean; parts: PartRow[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("parts").select("id, part_number, name, unit, location, on_hand, reorder_point, active").order("name").limit(1000);
  if (error) {
    if (MISSING.has(error.code ?? "")) return { installed: false, parts: [] };
    throw new Error(`Could not load parts: ${error.message}`);
  }
  return { installed: true, parts: ((data ?? []) as PartRow[]).map((p) => ({ ...p, on_hand: Number(p.on_hand), reorder_point: Number(p.reorder_point) })) };
}

export const isLow = (p: PartRow) => p.active && p.reorder_point > 0 && p.on_hand <= p.reorder_point;

/** Latest known unit cost and stock value per part (maintenance.costs; empty otherwise). */
export async function partCosts(): Promise<Map<string, { unit: number | null; value: number | null }>> {
  const { data, error } = await (await createClient()).rpc("part_costs");
  const out = new Map<string, { unit: number | null; value: number | null }>();
  if (error) return out;
  for (const r of (data ?? []) as Array<{ part_id: string; unit_cost_cents: number | null; stock_value_cents: number | null }>) {
    out.set(r.part_id, { unit: r.unit_cost_cents === null ? null : Number(r.unit_cost_cents), value: r.stock_value_cents === null ? null : Number(r.stock_value_cents) });
  }
  return out;
}

export async function recentMovements(limit = 25, workOrderId?: string): Promise<PartMovement[]> {
  if (workOrderId && !uuid.safeParse(workOrderId).success) return [];
  let q = (await createClient()).from("part_movements").select("id, part_id, kind, quantity, work_order_id, note, created_by, created_at").order("created_at", { ascending: false }).limit(limit);
  if (workOrderId) q = q.eq("work_order_id", workOrderId);
  const { data, error } = await q;
  if (error) return [];
  return ((data ?? []) as PartMovement[]).map((m) => ({ ...m, quantity: Number(m.quantity) }));
}
