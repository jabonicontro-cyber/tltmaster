import "server-only";
import { addDays } from "@/lib/dates";
import type { OptimizationInput, OptTrailer } from "@/lib/optimization/plan";
import { createClient } from "@/server/supabase/server";

/**
 * Trailers for tractors, shared by Plan the day and Smart Dispatch: active trailers, their active bookings around the
 * days, and unresolved driver reports about trailers. Read through RLS.
 */
export async function getTrailerInput(from: string, to: string): Promise<Pick<OptimizationInput, "trailers" | "trailerBookings" | "trailerReports">> {
  const supabase = await createClient();
  const dayStart = `${addDays(from, -1)}T00:00:00Z`;
  const dayEnd = `${addDays(to, 2)}T00:00:00Z`;
  const [trailers, booked, reports] = await Promise.all([
    supabase.from("trailers").select("id, unit_number, active, service_status, weight_capacity, weight_unit, volume_capacity, capacity_verified_at, compatible_truck_types").eq("active", true),
    supabase.from("dispatch_assignments").select("trailer_id, load_id, starts_at, ends_at").eq("status", "active").not("trailer_id", "is", null).lt("starts_at", dayEnd).gt("ends_at", dayStart),
    supabase.from("field_reports").select("trailer_id, kind").eq("equipment", "trailer").in("status", ["open", "acknowledged"]),
  ]);
  for (const r of [trailers, booked, reports]) if (r.error) throw new Error(`Trailers could not be read: ${r.error.message}`);
  return {
    trailers: ((trailers.data ?? []) as Array<OptTrailer & { weight_capacity: number | string | null; volume_capacity: number | string | null; compatible_truck_types: string[] | null }>).map((t) => ({
      ...t,
      weight_capacity: t.weight_capacity === null ? null : Number(t.weight_capacity),
      volume_capacity: t.volume_capacity === null ? null : Number(t.volume_capacity),
      compatible_truck_types: t.compatible_truck_types ?? [],
    })),
    trailerBookings: (booked.data ?? []) as OptimizationInput["trailerBookings"],
    trailerReports: ((reports.data ?? []) as Array<{ trailer_id: string | null; kind: string }>).filter((r) => r.trailer_id).map((r) => ({ trailer_id: r.trailer_id as string, kind: r.kind })),
  };
}
