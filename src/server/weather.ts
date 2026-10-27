import "server-only";
import { addDays } from "@/lib/dates";
import { hazardsByDay, type ForecastPeriod, type Hazard } from "@/lib/weather/hazards";
import { sampleForecast } from "@/lib/weather/sample";
import { createClient } from "@/server/supabase/server";

// Weather at job sites with planned loads (master plan B92). Forecasts come from the US National Weather Service
// (api.weather.gov: free, no key; owner 2026-10-27), cached for three hours per position by the fetch cache, so no
// scheduled job is needed. Only a site's map position is sent, never a customer, order or company detail.
// Demo companies get a fictional sample forecast instead (docs/DEMO_TENANTS.md §2): their sites are fictional places,
// and the feature must show something to explain itself.

const NWS = "https://api.weather.gov";
const HEADERS = { "User-Agent": "Taviron operations (mytaviron.com)", Accept: "application/geo+json" };
const REVALIDATE = 3 * 60 * 60;
const MAX_SITES = 15;
export const WEATHER_DAYS = 3;

export interface SiteWeather {
  siteId: string;
  site: string;
  day: string;
  hazards: Hazard[];
  loads: number;
  orders: string[];
}

export interface WeatherResult {
  alerts: SiteWeather[];
  /** Sites with loads but no map position (they cannot be checked). */
  unlocated: number;
  /** Sites whose forecast could not be read (outside the US, or the service did not answer). */
  unavailable: number;
  sample: boolean;
}

async function nwsForecast(lat: number, lng: number): Promise<ForecastPeriod[] | null> {
  try {
    const point = await fetch(`${NWS}/points/${lat.toFixed(4)},${lng.toFixed(4)}`, { headers: HEADERS, next: { revalidate: 24 * 60 * 60 }, signal: AbortSignal.timeout(6000) });
    if (!point.ok) return null;
    const url = ((await point.json()) as { properties?: { forecast?: string } }).properties?.forecast;
    if (!url || !url.startsWith(`${NWS}/`)) return null;
    const res = await fetch(url, { headers: HEADERS, next: { revalidate: REVALIDATE }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return (((await res.json()) as { properties?: { periods?: ForecastPeriod[] } }).properties?.periods ?? null);
  } catch {
    return null;
  }
}

export async function loadSiteWeather(today: string, isDemo: boolean): Promise<WeatherResult> {
  const supabase = await createClient();
  const until = addDays(today, WEATHER_DAYS - 1);
  const loads = await supabase
    .from("order_loads")
    .select("id, load_date, order:orders(order_number, site_id, site_label, site_city)")
    .gte("load_date", today)
    .lte("load_date", until)
    .eq("status", "planned")
    .limit(500);
  if (loads.error) throw new Error(`Could not load the loads: ${loads.error.message}`);
  type Row = { id: string; load_date: string; order: { order_number: string; site_id: string | null; site_label: string | null; site_city: string | null } | null };
  const rows = ((loads.data ?? []) as unknown as Row[]).filter((r) => r.order?.site_id);
  const siteIds = [...new Set(rows.map((r) => r.order!.site_id!))];
  if (!siteIds.length) return { alerts: [], unlocated: 0, unavailable: 0, sample: isDemo };
  const sites = await supabase.from("customer_sites").select("id, label, city, latitude, longitude").in("id", siteIds);
  if (sites.error) throw new Error(`Could not load job sites: ${sites.error.message}`);
  const siteRows = (sites.data ?? []) as Array<{ id: string; label: string; city: string; latitude: number | string | null; longitude: number | string | null }>;
  const located = siteRows.filter((s) => s.latitude != null && s.longitude != null).slice(0, MAX_SITES);

  let unavailable = 0;
  const alerts: SiteWeather[] = [];
  const forecasts = await Promise.all(located.map((s, i) => (isDemo ? Promise.resolve(sampleForecast(i, today)) : nwsForecast(Number(s.latitude), Number(s.longitude)))));
  located.forEach((s, i) => {
    const periods = forecasts[i];
    if (!periods) {
      unavailable++;
      return;
    }
    for (const [day, hazards] of hazardsByDay(periods)) {
      const onDay = rows.filter((r) => r.order!.site_id === s.id && r.load_date === day);
      if (!onDay.length) continue;
      alerts.push({ siteId: s.id, site: [s.label, s.city].filter(Boolean).join(", ") || "Job site", day, hazards, loads: onDay.length, orders: [...new Set(onDay.map((r) => r.order!.order_number))] });
    }
  });
  alerts.sort((a, b) => a.day.localeCompare(b.day) || b.loads - a.loads);
  return { alerts, unlocated: siteRows.length - siteRows.filter((s) => s.latitude != null && s.longitude != null).length, unavailable, sample: isDemo };
}
