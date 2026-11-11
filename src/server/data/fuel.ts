import "server-only";
import { iftaSummary, type IftaSummary } from "@/lib/fuel/ifta";
import { allRows } from "@/server/data/all-rows";
import { createClient } from "@/server/supabase/server";

// Fuel and IFTA (B130), read with the person's own session (RLS: fleet.view sees the company's, a driver their own).

export type FuelPurchaseRow = { id: string; truck_id: string; driver_id: string | null; purchased_on: string; jurisdiction: string; gallons: number; total_cents: number; odometer: number | null; vendor: string; receipt_ref: string; voided: boolean; void_reason: string };
export type TripSheetRow = { id: string; truck_id: string; driver_id: string | null; sheet_date: string; start_odometer: number; end_odometer: number; legs: Array<{ jurisdiction: string; miles: number }>; voided: boolean; void_reason: string };

export async function loadFuel(from: string, to: string, truckId?: string | null): Promise<{ installed: boolean; purchases: FuelPurchaseRow[]; sheets: TripSheetRow[]; summary: IftaSummary }> {
  const supabase = await createClient();
  // Every row of the period (allRows): IFTA miles and gallons are totals for a tax return, never the first 1000 rows.
  const p = () => {
    const q = supabase.from("fuel_purchases").select("id, truck_id, driver_id, purchased_on, jurisdiction, gallons, total_cents, odometer, vendor, receipt_ref, voided, void_reason").gte("purchased_on", from).lte("purchased_on", to);
    return (truckId ? q.eq("truck_id", truckId) : q).order("purchased_on", { ascending: false }).order("id");
  };
  const t = () => {
    const q = supabase.from("trip_sheets").select("id, truck_id, driver_id, sheet_date, start_odometer, end_odometer, legs, voided, void_reason").gte("sheet_date", from).lte("sheet_date", to);
    return (truckId ? q.eq("truck_id", truckId) : q).order("sheet_date", { ascending: false }).order("id");
  };
  const [purchases, sheets] = await Promise.all([allRows<FuelPurchaseRow>(p), allRows<TripSheetRow>(t)]);
  if (purchases.error || sheets.error) return { installed: false, purchases: [], sheets: [], summary: iftaSummary([], []) };
  const pRows = ((purchases.data ?? []) as FuelPurchaseRow[]).map((r) => ({ ...r, gallons: Number(r.gallons) }));
  const tRows = (sheets.data ?? []) as TripSheetRow[];
  const live = { p: pRows.filter((r) => !r.voided), t: tRows.filter((r) => !r.voided) };
  return {
    installed: true,
    purchases: pRows,
    sheets: tRows,
    summary: iftaSummary(live.t.flatMap((s) => s.legs.map((l) => ({ jurisdiction: l.jurisdiction, miles: Number(l.miles) }))), live.p.map((r) => ({ jurisdiction: r.jurisdiction, gallons: r.gallons }))),
  };
}

/** The company's home state (settings), for form defaults; IA when not set. */
export async function homeState(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.from("company_settings").select("state").maybeSingle();
  const s = String((data as { state?: string } | null)?.state ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : "IA";
}
