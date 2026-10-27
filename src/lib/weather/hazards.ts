// Weather alerts for job sites (master plan B92, owner 2026-10-27: the free US National Weather Service). Pure parsing
// of NWS forecast periods into plain hazards per day. Thresholds are stated where they are shown; an alert is
// information for dispatch, never an action (nothing is moved or canceled because of it).

export interface ForecastPeriod {
  /** ISO start time with the site's offset, e.g. 2026-10-28T06:00:00-05:00. */
  startTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: "F" | "C";
  /** "10 mph" or "10 to 25 mph". */
  windSpeed: string;
  shortForecast: string;
  probabilityOfPrecipitation?: { value: number | null } | null;
}

export type HazardKind = "rain" | "snow_ice" | "storm" | "wind" | "heat" | "cold";

export interface Hazard {
  kind: HazardKind;
  label: string;
}

export const THRESHOLDS = { rainChance: 60, windMph: 30, heatF: 100, coldF: 15 } as const;

export const THRESHOLD_TEXT = `Rain at ${THRESHOLDS.rainChance}% chance or more, snow or ice, thunderstorms, wind of ${THRESHOLDS.windMph} mph or more, ${THRESHOLDS.heatF}°F or hotter, ${THRESHOLDS.coldF}°F or colder.`;

/** The local calendar day of a period (the date part of its own offset time). */
export const periodDay = (p: ForecastPeriod) => p.startTime.slice(0, 10);

const maxWind = (s: string) => Math.max(0, ...(s.match(/\d+/g) ?? []).map(Number));
const toF = (p: ForecastPeriod) => (p.temperatureUnit === "C" ? Math.round((p.temperature * 9) / 5 + 32) : p.temperature);

/** Hazards for each day, from all of that day's periods (day and night), at most one of each kind. */
export function hazardsByDay(periods: ForecastPeriod[]): Map<string, Hazard[]> {
  const out = new Map<string, Hazard[]>();
  for (const p of periods) {
    const day = periodDay(p);
    const list = out.get(day) ?? [];
    const add = (h: Hazard) => {
      const i = list.findIndex((x) => x.kind === h.kind);
      if (i < 0) list.push(h);
      else if (h.kind === "rain" || h.kind === "wind" || h.kind === "heat" || h.kind === "cold") {
        // Keep the strongest figure of the day.
        const num = (l: string) => Number(l.match(/-?\d+/)?.[0] ?? 0);
        if (h.kind === "cold" ? num(h.label) < num(list[i].label) : num(h.label) > num(list[i].label)) list[i] = h;
      }
    };
    const text = p.shortForecast.toLowerCase();
    const chance = p.probabilityOfPrecipitation?.value ?? null;
    if (/snow|sleet|ice|freezing|wintry|blizzard|flurr/.test(text)) add({ kind: "snow_ice", label: "Snow or ice" });
    if (/thunder|t-storm|tstorm/.test(text)) add({ kind: "storm", label: "Thunderstorms" });
    if (/rain|shower|drizzle/.test(text) && chance !== null && chance >= THRESHOLDS.rainChance) add({ kind: "rain", label: `Rain likely (${chance}%)` });
    const wind = maxWind(p.windSpeed);
    if (wind >= THRESHOLDS.windMph) add({ kind: "wind", label: `Wind up to ${wind} mph` });
    const f = toF(p);
    if (p.isDaytime && f >= THRESHOLDS.heatF) add({ kind: "heat", label: `Heat ${f}°F` });
    if (f <= THRESHOLDS.coldF) add({ kind: "cold", label: `Cold ${f}°F` });
    if (list.length) out.set(day, list);
  }
  return out;
}
