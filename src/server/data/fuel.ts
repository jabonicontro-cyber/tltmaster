import "server-only";
import { iftaSummary, type IftaSummary } from "@/lib/fuel/ifta";
import { allRows } from "@/server/data/all-rows";
import { createClient } from "@/server/supabase/server";

// Fuel and IFTA (B130), read with the person's own session (RLS: fleet.view sees the company's, a driver their own).
// What a receipt cost is money (owner 2026-11-12, SEC5, 20261120019800): that column is not readable from the table;
// the amounts come from public.fuel_purchase_amounts, for billing.view only, and only when the caller asks for them.

/** The columns everyone who reads fuel purchases may read: every column but total_cents. */
const PURCHASE_COLUMNS = "id, truck_id, driver_id, purchased_on, jurisdiction, gallons, odometer, vendor, receipt_ref, voided, void_reason";

/** total_cents is null when the amounts were not read (no billing.view, or not available yet). */
export type FuelPurchaseRow = { id: string; truck_id: string; driver_id: string | null; purchased_on: string; jurisdiction: string; gallons: number; total_cents: number | null; odometer: number | null; vendor: string; receipt_ref: string; voided: boolean; void_reason: string };
export type TripSheetRow = { id: string; truck_id: string; driver_id: string | null; sheet_date: string; start_odometer: number; end_odometer: number; legs: Array<{ jurisdiction: string; miles: number }>; voided: boolean; void_reason: string };

/**
 * The fuel purchases and trip sheets of a period. `amounts`: also read what each receipt cost. Pass it only when the
 * person's access (after any demo role preview) holds billing.view, the permission the database checks too.
 * `amountsShown` says whether the amounts were read; when it is false no row has a total_cents.
 */
export async function loadFuel(from: string, to: string, truckId?: string | null, opts: { amounts?: boolean } = {}): Promise<{ installed: boolean; amountsShown: boolean; purchases: FuelPurchaseRow[]; sheets: TripSheetRow[]; summary: IftaSummary }> {
  const supabase = await createClient();
  // Every row of the period (allRows): IFTA miles and gallons are totals for a tax return, never the first 1000 rows.
  const p = () => {
    const q = supabase.from("fuel_purchases").select(PURCHASE_COLUMNS).gte("purchased_on", from).lte("purchased_on", to);
    return (truckId ? q.eq("truck_id", truckId) : q).order("purchased_on", { ascending: false }).order("id");
  };
  const t = () => {
    const q = supabase.from("trip_sheets").select("id, truck_id, driver_id, sheet_date, start_odometer, end_odometer, legs, voided, void_reason").gte("sheet_date", from).lte("sheet_date", to);
    return (truckId ? q.eq("truck_id", truckId) : q).order("sheet_date", { ascending: false }).order("id");
  };
  const [purchases, sheets, amounts] = await Promise.all([allRows<FuelPurchaseRow>(p), allRows<TripSheetRow>(t), opts.amounts ? fuelAmounts(from, to, truckId) : Promise.resolve(null)]);
  if (purchases.error || sheets.error) return { installed: false, amountsShown: false, purchases: [], sheets: [], summary: iftaSummary([], []) };
  const pRows = ((purchases.data ?? []) as FuelPurchaseRow[]).map((r) => ({ ...r, gallons: Number(r.gallons), total_cents: amounts?.get(r.id) ?? null }));
  const tRows = (sheets.data ?? []) as TripSheetRow[];
  const live = { p: pRows.filter((r) => !r.voided), t: tRows.filter((r) => !r.voided) };
  return {
    installed: true,
    amountsShown: amounts !== null,
    purchases: pRows,
    sheets: tRows,
    summary: iftaSummary(live.t.flatMap((s) => s.legs.map((l) => ({ jurisdiction: l.jurisdiction, miles: Number(l.miles) }))), live.p.map((r) => ({ jurisdiction: r.jurisdiction, gallons: r.gallons }))),
  };
}

/**
 * What each receipt of the period cost, by purchase id (public.fuel_purchase_amounts, billing.view; 20261120019800).
 * null when it cannot be read: the database refuses it, or that update is not installed yet.
 */
async function fuelAmounts(from: string, to: string, truckId?: string | null): Promise<Map<string, number> | null> {
  const supabase = await createClient();
  const res = await allRows<{ purchase_id: string; total_cents: number }>(() =>
    supabase.rpc("fuel_purchase_amounts", { p_from: from, p_to: to, p_truck: truckId ?? null }).order("purchase_id"));
  if (res.error) return null;
  return new Map((res.data ?? []).map((r) => [r.purchase_id, Number(r.total_cents)]));
}

/** The company's home state (settings), for form defaults; IA when not set. */
export async function homeState(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.from("company_settings").select("state").maybeSingle();
  const s = String((data as { state?: string } | null)?.state ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : "IA";
}
