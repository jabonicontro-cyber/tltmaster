import Link from "next/link";
import { CloudRain } from "lucide-react";
import { formatDate } from "@/lib/dates";
import { THRESHOLD_TEXT } from "@/lib/weather/hazards";
import type { WeatherResult } from "@/server/weather";

// Weather at job sites with planned loads (B92): information for dispatch; nothing is moved or canceled because of it.

export function WeatherSection({ weather, today }: { weather: WeatherResult; today: string }) {
  const note = [
    weather.sample ? "Sample forecast (demo)." : "Forecast: US National Weather Service, refreshed every three hours.",
    weather.unlocated ? `${weather.unlocated} site${weather.unlocated === 1 ? "" : "s"} without a map position cannot be checked.` : "",
    weather.unavailable ? `No forecast for ${weather.unavailable} site${weather.unavailable === 1 ? "" : "s"} (outside the US, or the service did not answer).` : "",
  ].filter(Boolean).join(" ");
  return (
    <div className="space-y-3">
      {weather.alerts.length === 0 ? (
        <p className="text-sm text-muted">No weather concerns at job sites with loads in the next three days.</p>
      ) : (
        <ul className="divide-y divide-line/70 rounded-panel border border-line/70 bg-card" aria-label="Weather at job sites">
          {weather.alerts.map((a) => (
            <li key={`${a.siteId}-${a.day}`} className="flex items-start gap-3 px-4 py-3">
              <CloudRain className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm"><span className="font-semibold">{a.hazards.map((h) => h.label).join(" · ")}</span> at {a.site}</p>
                <p className="text-xs text-muted">
                  {a.day === today ? "Today" : formatDate(a.day)} · {a.loads} load{a.loads === 1 ? "" : "s"} ({a.orders.join(", ")}) ·{" "}
                  <Link href={`/dispatch?date=${a.day}`} className="font-semibold text-brand-fg hover:underline">Open dispatch</Link>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">{note} Alerts for: {THRESHOLD_TEXT}</p>
    </div>
  );
}
