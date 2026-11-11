import "server-only";
import { addDays } from "@/lib/dates";
import { freeDays, partsUsuallyNeeded, repeatFailures, type PartHint, type PartStock, type PartUse, type PastJob, type RepeatFailure } from "@/lib/maintenance/insights";
import { allRows } from "@/server/data/all-rows";
import { createClient } from "@/server/supabase/server";

// Shop insights (B120): from completed work orders (last 12 months), parts used on them, stock, and the trucks' planned
// loads for the next 7 days (dispatch access; without it free days are left out). Any read error: nothing shown.

export interface JobInsight { workOrderId: string; number: string; unitLabel: string; parts: PartHint[]; freeDays: string[] | null }
export interface ShopInsights { repeats: RepeatFailure[]; jobs: JobInsight[] }

type WoRow = { id: string; number: string; truck_id: string | null; trailer_id: string | null; category: string; status: string; completed_at: string | null; trucks: { unit_number: string } | null; trailers: { unit_number: string } | null };

export async function loadShopInsights(today: string, openIds: string[]): Promise<ShopInsights | null> {
  const supabase = await createClient();
  const [done, open, stock] = await Promise.all([
    allRows(() => supabase.from("work_orders").select("id, number, truck_id, trailer_id, category, status, completed_at, trucks(unit_number), trailers(unit_number)").eq("status", "completed").gte("completed_at", `${addDays(today, -365)}T00:00:00Z`).order("id")),
    openIds.length ? supabase.from("work_orders").select("id, number, truck_id, trailer_id, category, status, completed_at, trucks(unit_number), trailers(unit_number)").in("id", openIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("parts").select("id, name, unit, on_hand, reorder_point").eq("active", true),
  ]);
  if (done.error || open.error || stock.error) return null;
  const unit = (w: WoRow) => (w.truck_id ? { id: w.truck_id, label: `Truck ${w.trucks?.unit_number ?? ""}` } : w.trailer_id ? { id: w.trailer_id, label: `Trailer ${w.trailers?.unit_number ?? ""}` } : null);
  const past: PastJob[] = ((done.data ?? []) as unknown as WoRow[]).flatMap((w) => { const u = unit(w); return u && w.completed_at ? [{ id: w.id, unitId: u.id, unitLabel: u.label, category: w.category, completedAt: w.completed_at }] : []; });
  const uses = await supabase.from("part_movements").select("work_order_id, part_id, quantity").eq("kind", "used").in("work_order_id", past.map((p) => p.id).slice(0, 2000));
  const partUses: PartUse[] = uses.error ? [] : ((uses.data ?? []) as Array<{ work_order_id: string; part_id: string; quantity: number | string }>).map((u) => ({ workOrderId: u.work_order_id, partId: u.part_id, quantity: Math.abs(Number(u.quantity)) }));
  const parts: PartStock[] = ((stock.data ?? []) as Array<{ id: string; name: string; unit: string; on_hand: number | string; reorder_point: number | string | null }>).map((p) => ({ id: p.id, name: p.name, unit: p.unit, onHand: Number(p.on_hand), reorderPoint: p.reorder_point === null ? null : Number(p.reorder_point) }));
  const openRows = (open.data ?? []) as unknown as WoRow[];
  const truckIds = [...new Set(openRows.map((w) => w.truck_id).filter(Boolean))] as string[];
  const busy = truckIds.length
    ? await supabase.from("dispatch_assignments").select("truck_id, order_loads(load_date)").eq("status", "active").in("truck_id", truckIds).gte("starts_at", `${today}T00:00:00Z`).lt("starts_at", `${addDays(today, 9)}T00:00:00Z`)
    : { data: [], error: null };
  const busyBy = new Map<string, string[]>();
  for (const b of (busy.error ? [] : (busy.data ?? [])) as unknown as Array<{ truck_id: string; order_loads: { load_date: string } | null }>) {
    if (b.order_loads) busyBy.set(b.truck_id, [...(busyBy.get(b.truck_id) ?? []), b.order_loads.load_date]);
  }
  const jobs: JobInsight[] = openRows.map((w) => ({
    workOrderId: w.id, number: w.number, unitLabel: unit(w)?.label ?? "",
    parts: partsUsuallyNeeded(w.category, past, partUses, parts),
    freeDays: w.truck_id && !busy.error ? freeDays(busyBy.get(w.truck_id) ?? [], today, 7).slice(0, 3) : null,
  })).filter((j) => j.parts.length > 0 || (j.freeDays?.length ?? 0) > 0);
  return { repeats: repeatFailures(past, today), jobs };
}
