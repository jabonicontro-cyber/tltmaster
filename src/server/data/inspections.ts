import "server-only";
import { createClient } from "@/server/supabase/server";
import type { InspectionKind } from "@/lib/inspections/items";

// Digital inspections (B132): recent inspections and today's missing pre-trips. `installed` is false before the
// 20261120006000 update, so pages show their "not available yet" state instead of failing.

export type InspectionRow = {
  id: string; truck_id: string; kind: InspectionKind; inspected_on: string; odometer: number | null;
  items: Array<{ key: string; ok: boolean; note: string }>; defect_count: number; safety_defect: boolean; remarks: string;
  created_at: string; truck: { unit_number: string } | null; driver: { name: string } | null;
  work_order: { id: string; number: string; status: string } | null;
};

export async function loadInspections(from: string, canSeeMissing: boolean) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("vehicle_inspections")
    .select("id, truck_id, kind, inspected_on, odometer, items, defect_count, safety_defect, remarks, created_at, truck:trucks(unit_number), driver:drivers(name), work_order:work_orders(id, number, status)")
    .gte("inspected_on", from).order("inspected_on", { ascending: false }).order("created_at", { ascending: false }).limit(200);
  if (error) return { installed: false as const, rows: [] as InspectionRow[], missing: [] as Array<{ truck_id: string; unit: string }> };
  let missing: Array<{ truck_id: string; unit: string }> = [];
  if (canSeeMissing) {
    const m = await supabase.rpc("inspection_missing_today");
    if (!m.error) missing = (m.data ?? []) as typeof missing;
  }
  return { installed: true as const, rows: (data ?? []) as unknown as InspectionRow[], missing };
}

/** Trucks working today without a pre-trip (dispatch board and Command Center flag); [] when not installed or not allowed. */
export async function missingPreTrips() {
  const m = await (await createClient()).rpc("inspection_missing_today");
  return m.error ? [] : ((m.data ?? []) as Array<{ truck_id: string; unit: string }>);
}
