import { addDays } from "@/lib/dates";
import type { ForecastPeriod } from "./hazards";

// Demo companies only (docs/DEMO_TENANTS.md §2): their job sites are fictional places.
/** A fictional forecast for demo sites: rain tomorrow at the first site, strong wind the day after at the second. */
export function sampleForecast(index: number, today: string): ForecastPeriod[] {
  const at = (day: string, hour: string) => `${day}T${hour}:00-05:00`;
  const calm = (day: string): ForecastPeriod => ({ startTime: at(day, "06"), isDaytime: true, temperature: 58, temperatureUnit: "F", windSpeed: "5 to 10 mph", shortForecast: "Mostly Sunny", probabilityOfPrecipitation: { value: 5 } });
  const days = [0, 1, 2].map((d) => addDays(today, d));
  return days.map((day, d) => {
    if (index === 0 && d === 1) return { ...calm(day), shortForecast: "Rain Showers Likely", probabilityOfPrecipitation: { value: 70 }, windSpeed: "10 to 15 mph" };
    if (index === 1 && d === 2) return { ...calm(day), shortForecast: "Breezy", windSpeed: "20 to 35 mph" };
    return calm(day);
  });
}


/** Fictional current conditions for a demo base. */
export function sampleNow(index: number): { temperatureF: number; conditions: string } {
  return [{ temperatureF: 63, conditions: "Partly Cloudy" }, { temperatureF: 58, conditions: "Light Rain" }, { temperatureF: 61, conditions: "Cloudy" }, { temperatureF: 66, conditions: "Sunny" }][index % 4];
}

/** A fictional NWS-style alert for a demo delivery site, ending this evening. */
export function sampleAlert(today: string): { event: string; severity: string; headline: string; endsAt: string } {
  return { event: "Wind Advisory", severity: "Moderate", headline: "Wind Advisory until 7:00 PM — gusts up to 45 mph (sample, demo)", endsAt: `${today}T19:00:00-05:00` };
}
