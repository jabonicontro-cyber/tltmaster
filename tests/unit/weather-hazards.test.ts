import { describe, expect, it } from "vitest";
import { hazardsByDay, type ForecastPeriod } from "@/lib/weather/hazards";
import { sampleForecast } from "@/lib/weather/sample";

// Weather alerts (B92): NWS forecast periods become plain hazards per local day; calm weather gives nothing.
const p = (over: Partial<ForecastPeriod>): ForecastPeriod => ({ startTime: "2026-10-28T06:00:00-05:00", isDaytime: true, temperature: 60, temperatureUnit: "F", windSpeed: "5 to 10 mph", shortForecast: "Sunny", probabilityOfPrecipitation: { value: 0 }, ...over });

describe("weather hazards", () => {
  it("flags likely rain, snow or ice, storms, strong wind, heat and cold", () => {
    const m = hazardsByDay([
      p({ shortForecast: "Rain Showers Likely", probabilityOfPrecipitation: { value: 70 } }),
      p({ startTime: "2026-10-28T18:00:00-05:00", isDaytime: false, shortForecast: "Chance Thunderstorms", windSpeed: "15 to 35 mph", temperature: 12 }),
      p({ startTime: "2026-10-29T06:00:00-05:00", shortForecast: "Light Snow", probabilityOfPrecipitation: { value: 40 } }),
      p({ startTime: "2026-10-30T06:00:00-05:00", temperature: 103 }),
    ]);
    expect(m.get("2026-10-28")?.map((h) => h.label)).toEqual(["Rain likely (70%)", "Thunderstorms", "Wind up to 35 mph", "Cold 12°F"]);
    expect(m.get("2026-10-29")?.map((h) => h.kind)).toEqual(["snow_ice"]);
    expect(m.get("2026-10-30")?.map((h) => h.label)).toEqual(["Heat 103°F"]);
  });

  it("ignores calm weather and a low chance of rain", () => {
    const m = hazardsByDay([p({}), p({ shortForecast: "Slight Chance Rain Showers", probabilityOfPrecipitation: { value: 20 } })]);
    expect(m.size).toBe(0);
  });

  it("keeps the strongest wind of the day", () => {
    const m = hazardsByDay([p({ windSpeed: "30 mph" }), p({ startTime: "2026-10-28T18:00:00-05:00", windSpeed: "20 to 40 mph" })]);
    expect(m.get("2026-10-28")).toEqual([{ kind: "wind", label: "Wind up to 40 mph" }]);
  });

  it("the demo sample forecast has rain tomorrow and wind the day after", () => {
    const first = hazardsByDay(sampleForecast(0, "2026-10-27"));
    const second = hazardsByDay(sampleForecast(1, "2026-10-27"));
    expect([...first.keys()]).toEqual(["2026-10-28"]);
    expect([...second.keys()]).toEqual(["2026-10-29"]);
  });
});
