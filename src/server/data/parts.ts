import "server-only";
import { summarizeParts, type PartCostLine, type PartsSummary, type UsedMovement } from "@/lib/maintenance/parts-summary";
import { uuid } from "@/lib/schemas/common";
import { allRows } from "@/server/data/all-rows";
import { createClient } from "@/server/supabase/server";

// Shop parts inventory (B105, migration 20261120004500), read with the person's session: parts and movements with
// maintenance.view (RLS); unit costs only through part_costs() for maintenance.costs. Before the migration is
// installed the loaders say so.

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

export interface PartRow { id: string; part_number: string; name: string; unit: string; location: string; on_hand: number; reorder_point: number; active: boolean }
/** `returned` (20261120012600): a part used on a job and put back in stock; `returned_from` is the use it reverses. */
export interface PartMovement { id: number; part_id: string; kind: "received" | "used" | "adjusted" | "returned"; quantity: number; work_order_id: string | null; note: string; created_by: string | null; created_at: string; returned_from?: number | null }

export async function listParts(): Promise<{ installed: boolean; parts: PartRow[] }> {
  const supabase = await createClient();
  const { data, error } = await allRows(() => supabase.from("parts").select("id, part_number, name, unit, location, on_hand, reorder_point, active").order("name").order("id"));
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
  const supabase = await createClient();
  const load = (cols: string) => {
    let q = supabase.from("part_movements").select(cols).order("created_at", { ascending: false }).limit(limit);
    if (workOrderId) q = q.eq("work_order_id", workOrderId);
    return q;
  };
  const base = "id, part_id, kind, quantity, work_order_id, note, created_by, created_at";
  // returned_from comes with 20261120012600; before it, the list loads without it.
  let { data, error } = await load(`${base}, returned_from`);
  if (error?.code === "42703") ({ data, error } = await load(base));
  if (error) return [];
  return ((data ?? []) as unknown as PartMovement[]).map((m) => ({ ...m, quantity: Number(m.quantity) }));
}

/**
 * Parts used per work order (UX20): parts from stock (countable by quantity, measured once), and the part cost total for people with
 * maintenance.costs (RLS returns no cost lines to anyone else, so withCosts must match the person's permission).
 * Before the parts update is installed the counts are zero.
 */
export async function partsSummaryFor(workOrderIds: string[], withCosts: boolean): Promise<Map<string, PartsSummary>> {
  const ids = [...new Set(workOrderIds.filter((id) => uuid.safeParse(id).success))];
  if (!ids.length) return new Map();
  const supabase = await createClient();
  const [moves, costs] = await Promise.all([
    allRows(() => supabase.from("part_movements").select("work_order_id, part_id, kind, quantity, parts(unit)").in("kind", ["used", "returned"]).in("work_order_id", ids).order("id")),
    withCosts ? allRows(() => supabase.from("work_order_costs").select("work_order_id, kind, quantity, unit_cost_cents").eq("kind", "part").in("work_order_id", ids).order("id")) : Promise.resolve(null),
  ]);
  type Row = Omit<UsedMovement, "unit"> & { parts: { unit: string } | null };
  const used: UsedMovement[] = moves.error ? [] : ((moves.data ?? []) as unknown as Row[]).map((m) => ({ ...m, unit: m.parts?.unit ?? null }));
  return summarizeParts(ids, used, costs && !costs.error ? ((costs.data ?? []) as PartCostLine[]) : withCosts ? [] : null);
}

/** A part on order for a work order (20261120012300). `unit_cost_cents` only for maintenance.costs (null otherwise). */
export interface PartWait {
  id: string;
  work_order_id: string;
  work_order_number: string;
  part_id: string | null;
  description: string;
  part_number: string;
  quantity: number;
  vendor_name: string;
  po_number: string;
  expected_on: string | null;
  unit_cost_cents: number | null;
  status: "waiting" | "received" | "canceled";
  received_at: string | null;
  received_by: string | null;
  cancel_reason: string;
  created_by: string | null;
  created_at: string;
}

/**
 * Parts on order: a work order's (every status), or with no work order every part still waiting on an open job (the
 * Maintenance dashboard). Before the update is installed: installed false and nothing listed.
 */
export async function partWaits(workOrderId?: string): Promise<{ installed: boolean; rows: PartWait[] }> {
  if (workOrderId && !uuid.safeParse(workOrderId).success) return { installed: true, rows: [] };
  const { data, error } = await (await createClient()).rpc("part_waits", { p_work_order: workOrderId ?? null });
  if (error) {
    if (MISSING.has(error.code ?? "")) return { installed: false, rows: [] };
    throw new Error(`Could not load parts on order: ${error.message}`);
  }
  return {
    installed: true,
    rows: ((data ?? []) as PartWait[]).map((r) => ({ ...r, quantity: Number(r.quantity), unit_cost_cents: r.unit_cost_cents === null ? null : Number(r.unit_cost_cents) })),
  };
}
