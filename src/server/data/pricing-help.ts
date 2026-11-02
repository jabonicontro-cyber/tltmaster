import "server-only";
import { addDays } from "@/lib/dates";
import { pricingHelp, type PricingHelp } from "@/lib/quotes/pricing-help";
import { straightLineMiles } from "@/lib/routing/route";
import type { QuoteLineRow } from "@/server/data/types";
import { loadDecidedQuotes } from "@/server/data/quote-outcomes";
import { getSettings } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";

// Quote pricing help (B114), read with the person's own session (RLS: their company, quotes they may see). History is
// the last 365 days of decided quotes; the cost per load comes from report_profit over the last 90 days and is only
// read when the person may see billing (the function refuses otherwise).

export interface QuotePricingHelp {
  miles: number | null;
  lines: PricingHelp[];
  /** Whether a measured cost per load was available to compare per-load lines against. */
  costShown: boolean;
}

export async function loadPricingHelp(
  lines: QuoteLineRow[],
  siteId: string | null,
  today: string,
  timeZone: string,
  canSeeCosts: boolean,
): Promise<QuotePricingHelp | null> {
  const priced = lines.filter((l) => l.calc_method === "per_unit" && l.unit_code && (l.material_id || l.charge_item_id) && l.kind !== "discount");
  if (!priced.length) return null;
  const supabase = await createClient();
  const materialIds = [...new Set(priced.map((l) => l.material_id).filter((v): v is string => Boolean(v)))];
  const itemIds = [...new Set(priced.map((l) => l.charge_item_id).filter((v): v is string => Boolean(v)))];
  const [materials, items, site, settings, history, profit] = await Promise.all([
    materialIds.length ? supabase.from("materials").select("id, name").in("id", materialIds) : Promise.resolve({ data: [] }),
    itemIds.length ? supabase.from("charge_items").select("id, name").in("id", itemIds) : Promise.resolve({ data: [] }),
    siteId ? supabase.from("customer_sites").select("latitude, longitude").eq("id", siteId).maybeSingle() : Promise.resolve({ data: null }),
    getSettings(),
    loadDecidedQuotes(addDays(today, -365), today, timeZone).catch(() => []),
    canSeeCosts
      ? supabase.rpc("report_profit", { p_from: addDays(today, -90), p_to: addDays(today, -1) }).then((r) => (r.error ? null : (r.data as { has_rates: boolean; loads_costed: number; cost_cents: number })))
      : Promise.resolve(null),
  ]);
  const names = new Map<string, string>([...((materials.data ?? []) as Array<{ id: string; name: string }>), ...((items.data ?? []) as Array<{ id: string; name: string }>)].map((r) => [r.id, r.name]));
  const y = settings as unknown as { yard_latitude?: number | string | null; yard_longitude?: number | string | null };
  const s = site.data as { latitude: number | string | null; longitude: number | string | null } | null;
  const miles = y.yard_latitude != null && y.yard_longitude != null && s?.latitude != null && s?.longitude != null
    ? straightLineMiles({ lat: Number(y.yard_latitude), lng: Number(y.yard_longitude) }, { lat: Number(s.latitude), lng: Number(s.longitude) })
    : null;
  const costPerLoad = profit?.has_rates && profit.loads_costed > 0 ? Math.round(profit.cost_cents / profit.loads_costed) : null;

  const seen = new Set<string>();
  const out: PricingHelp[] = [];
  for (const l of priced) {
    const name = names.get(l.material_id ?? l.charge_item_id ?? "");
    if (!name) continue;
    const key = `${name}|${l.unit_code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pricingHelp({ name, unit: l.unit_code!, unitLabel: l.unit_label, rateCents: l.unit_rate_cents, miles }, history, costPerLoad));
  }
  return out.length ? { miles, lines: out, costShown: out.some((l) => l.costPerLoadCents !== null) } : null;
}
