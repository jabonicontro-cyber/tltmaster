import "server-only";
import { addDays } from "@/lib/dates";
import { hazardsByDay, type ForecastPeriod, type Hazard } from "@/lib/weather/hazards";
import { sampleAlert, sampleForecast, sampleNow } from "@/lib/weather/sample";
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

/** Conditions now at a base (or the company yard): the current hour of the NWS hourly forecast. */
export interface BaseNow {
  name: string;
  temperatureF: number | null;
  conditions: string;
}

/** An official NWS alert in effect now at a job site with a delivery today. */
export interface SiteAlert {
  site: string;
  event: string;
  severity: string;
  headline: string;
  endsAt: string | null;
  orders: string[];
}

export interface WeatherResult {
  alerts: SiteWeather[];
  /** Current conditions per base with a map position (owner 2026-10-28). */
  now: BaseNow[];
  /** NWS alerts in effect now at today's delivery sites. */
  active: SiteAlert[];
  /** Sites with loads but no map position (they cannot be checked). */
  unlocated: number;
  /** Sites whose forecast could not be read (outside the US, or the service did not answer). */
  unavailable: number;
  sample: boolean;
}

async function nwsPoint(lat: number, lng: number): Promise<{ forecast?: string; forecastHourly?: string } | null> {
  const point = await fetch(`${NWS}/points/${lat.toFixed(4)},${lng.toFixed(4)}`, { headers: HEADERS, next: { revalidate: 24 * 60 * 60 }, signal: AbortSignal.timeout(6000) });
  if (!point.ok) return null;
  return ((await point.json()) as { properties?: { forecast?: string; forecastHourly?: string } }).properties ?? null;
}

/** The current hour of the hourly forecast (refreshed every 30 minutes). */
async function nwsNow(lat: number, lng: number): Promise<{ temperatureF: number | null; conditions: string } | null> {
  try {
    const url = (await nwsPoint(lat, lng))?.forecastHourly;
    if (!url || !url.startsWith(`${NWS}/`)) return null;
    const res = await fetch(url, { headers: HEADERS, next: { revalidate: 30 * 60 }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const p = (((await res.json()) as { properties?: { periods?: ForecastPeriod[] } }).properties?.periods ?? [])[0];
    if (!p) return null;
    const f = p.temperatureUnit === "C" ? Math.round((p.temperature * 9) / 5 + 32) : p.temperature;
    return { temperatureF: Number.isFinite(f) ? f : null, conditions: p.shortForecast };
  } catch {
    return null;
  }
}

/** Official alerts in effect now at a point (refreshed every 10 minutes). */
async function nwsActive(lat: number, lng: number): Promise<Array<{ event: string; severity: string; headline: string; ends: string | null }> | null> {
  try {
    const res = await fetch(`${NWS}/alerts/active?point=${lat.toFixed(4)},${lng.toFixed(4)}`, { headers: HEADERS, next: { revalidate: 10 * 60 }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const features = ((await res.json()) as { features?: Array<{ properties?: { event?: string; severity?: string; headline?: string; ends?: string | null; expires?: string | null } }> }).features ?? [];
    return features.map((f) => ({ event: f.properties?.event ?? "Weather alert", severity: f.properties?.severity ?? "Unknown", headline: f.properties?.headline ?? "", ends: f.properties?.ends ?? f.properties?.expires ?? null }));
  } catch {
    return null;
  }
}

async function nwsForecast(lat: number, lng: number): Promise<ForecastPeriod[] | null> {
  try {
    const url = (await nwsPoint(lat, lng))?.forecast;
    if (!url || !url.startsWith(`${NWS}/`)) return null;
    const res = await fetch(url, { headers: HEADERS, next: { revalidate: REVALIDATE }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return (((await res.json()) as { properties?: { periods?: ForecastPeriod[] } }).properties?.periods ?? null);
  } catch {
    return null;
  }
}

/** Bases with a map position, or the company yard when there are none (fictional sample conditions in a demo). */
async function loadBaseNow(isDemo: boolean): Promise<BaseNow[]> {
  const supabase = await createClient();
  const bases = await supabase.from("dispatch_bases").select("name, latitude, longitude, is_default").eq("active", true).not("latitude", "is", null).order("is_default", { ascending: false }).order("code").limit(4);
  let points = ((bases.error ? [] : bases.data ?? []) as Array<{ name: string; latitude: number | string; longitude: number | string }>).map((b) => ({ name: b.name, lat: Number(b.latitude), lng: Number(b.longitude) }));
  if (!points.length) {
    const yard = await supabase.from("company_settings").select("yard_latitude, yard_longitude").maybeSingle();
    const y = yard.data as { yard_latitude: number | string | null; yard_longitude: number | string | null } | null;
    if (y?.yard_latitude != null && y.yard_longitude != null) points = [{ name: "Yard", lat: Number(y.yard_latitude), lng: Number(y.yard_longitude) }];
  }
  if (isDemo) {
    // Demo bases are fictional places, often without a map position: sample conditions under their names.
    if (!points.length) {
      const named = await supabase.from("dispatch_bases").select("name").eq("active", true).order("is_default", { ascending: false }).order("code").limit(4);
      const names = (named.error ? [] : (named.data ?? []).map((b) => (b as { name: string }).name));
      return (names.length ? names : ["Yard"]).map((name, i) => ({ name, ...sampleNow(i) }));
    }
    return points.map((p, i) => ({ name: p.name, ...sampleNow(i) }));
  }
  const now = await Promise.all(points.map((p) => nwsNow(p.lat, p.lng)));
  return points.map((p, i) => ({ name: p.name, temperatureF: now[i]?.temperatureF ?? null, conditions: now[i]?.conditions ?? "Not available" }));
}

export async function loadSiteWeather(today: string, isDemo: boolean): Promise<WeatherResult> {
  const supabase = await createClient();
  const nowP = loadBaseNow(isDemo).catch(() => []);
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
  if (!siteIds.length) return { alerts: [], now: await nowP, active: [], unlocated: 0, unavailable: 0, sample: isDemo };
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

  // Alerts in effect now at sites with a delivery today (a demo shows one fictional sample).
  const todaySites = located.filter((s) => rows.some((r) => r.order!.site_id === s.id && r.load_date === today));
  const siteName = (s: (typeof located)[number]) => [s.label, s.city].filter(Boolean).join(", ") || "Job site";
  const ordersAt = (s: (typeof located)[number]) => [...new Set(rows.filter((r) => r.order!.site_id === s.id && r.load_date === today).map((r) => r.order!.order_number))];
  let active: SiteAlert[] = [];
  if (isDemo) {
    active = todaySites.slice(0, 1).map((s) => ({ site: siteName(s), ...sampleAlert(today), orders: ordersAt(s) }));
  } else {
    const found = await Promise.all(todaySites.slice(0, MAX_SITES).map((s) => nwsActive(Number(s.latitude), Number(s.longitude))));
    todaySites.slice(0, MAX_SITES).forEach((s, i) => {
      for (const a of found[i] ?? []) active.push({ site: siteName(s), event: a.event, severity: a.severity, headline: a.headline, endsAt: a.ends, orders: ordersAt(s) });
    });
  }
  return { alerts, now: await nowP, active, unlocated: siteRows.length - siteRows.filter((s) => s.latitude != null && s.longitude != null).length, unavailable, sample: isDemo };
}
