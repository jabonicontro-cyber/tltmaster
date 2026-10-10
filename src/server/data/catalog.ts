import "server-only";
import { createClient } from "@/server/supabase/server";
import type { ChargeItemRow, MaterialRow, PriceEntryRow, PriceListRow, UnitRow } from "./types";

export async function listUnits(includeInactive = false) {
  const supabase = await createClient();
  let q = supabase.from("units_of_measure").select("*").order("sort_order").order("label");
  if (!includeInactive) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(`Could not load units: ${error.message}`);
  return (data ?? []) as UnitRow[];
}

export async function listMaterials(opts: { includeInactive?: boolean; q?: string } = {}) {
  const supabase = await createClient();
  let q = supabase.from("materials").select("*").order("name");
  if (!opts.includeInactive) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(`Could not load materials: ${error.message}`);
  return (data ?? []) as MaterialRow[];
}

export async function listChargeItems(opts: { includeInactive?: boolean } = {}) {
  const supabase = await createClient();
  let q = supabase.from("charge_items").select("*").order("kind").order("name");
  if (!opts.includeInactive) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(`Could not load charges: ${error.message}`);
  return (data ?? []) as ChargeItemRow[];
}

export async function listPriceLists(opts: { includeInactive?: boolean } = {}) {
  const supabase = await createClient();
  let q = supabase.from("price_lists").select("*").order("is_standard", { ascending: false }).order("name");
  if (!opts.includeInactive) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(`Could not load price lists: ${error.message}`);
  return (data ?? []) as PriceListRow[];
}

export async function getPriceList(id: string) {
  const supabase = await createClient();
  const [list, entries, customers] = await Promise.all([
    supabase.from("price_lists").select("*").eq("id", id).maybeSingle(),
    supabase.from("price_list_entries").select("*").eq("price_list_id", id).order("effective_from", { ascending: false }),
    supabase.from("customers").select("id, name, customer_number").eq("price_list_id", id).order("name"),
  ]);
  if (list.error || entries.error) throw new Error("Could not load price list.");
  if (!list.data) return null;
  return {
    list: list.data as PriceListRow,
    entries: (entries.data ?? []) as PriceEntryRow[],
    customers: (customers.data ?? []) as Array<{ id: string; name: string; customer_number: string }>,
  };
}
