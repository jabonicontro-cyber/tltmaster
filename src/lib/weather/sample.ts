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

