import Link from "next/link";
import { AlertTriangle, ChevronRight, CloudSun, CloudRain } from "lucide-react";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/dates";
import { THRESHOLD_TEXT } from "@/lib/weather/hazards";
import type { WeatherResult } from "@/server/weather";

/**
 * Weather at the top of the Command Center (owner 2026-10-28): conditions now at each base, official alerts in effect
 * at today's delivery sites, and the forecast concerns for the next three days on one line. Information for dispatch;
 * nothing is moved or canceled because of it. Severe and extreme alerts use the critical red; others amber.
 */
/** "7:00 PM" when the alert ends today (company time), otherwise the date and time. */
function until(iso: string, today: string, timezone: string) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return day === today ? new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(d) : formatDateTime(iso, timezone);
}

export function WeatherStrip({ weather, today, timezone }: { weather: WeatherResult; today: string; timezone: string }) {
  const source = weather.sample ? "Sample weather (demo)." : "US National Weather Service: conditions now from the hourly forecast, alerts in effect, forecast refreshed every three hours.";
  const forecast = weather.alerts;
  const gaps = [
    weather.unlocated ? `${weather.unlocated} job site${weather.unlocated === 1 ? "" : "s"} without a map position cannot be checked.` : "",
    weather.unavailable ? `No forecast for ${weather.unavailable} site${weather.unavailable === 1 ? "" : "s"} (outside the US, or the service did not answer).` : "",
  ].filter(Boolean).join(" ");
  return (
    <section aria-label="Weather" className="mb-6 space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {weather.now.length === 0 ? (
          <span className="inline-flex items-center gap-2 text-muted"><CloudSun className="size-4" aria-hidden />Add a map position to a base (or the yard) to see the weather there.</span>
        ) : (
          weather.now.map((b) => (
            <span key={b.name} className="inline-flex items-center gap-2">
              <CloudSun className="size-4 text-brand-fg" aria-hidden />
              <span className="text-muted">{b.name}</span>
              <span className="font-semibold tabular text-ink">{b.temperatureF === null ? "–" : `${b.temperatureF}°F`}</span>
              <span className="text-ink">{b.conditions}</span>
            </span>
          ))
        )}
        <span className="ml-auto"><InfoTip label="Weather">{source} Forecast concerns: {THRESHOLD_TEXT}{gaps ? ` ${gaps}` : ""}</InfoTip></span>
      </div>

      {weather.active.length > 0 && (
        <ul className="space-y-2" aria-label="Weather alerts at today's delivery sites">
          {weather.active.map((a, i) => {
            const severe = a.severity === "Severe" || a.severity === "Extreme";
            return (
              <li key={`${a.site}-${a.event}-${i}`}>
                {/* The same card as the tiles around it (owner 2026-11-09: the amber box did not match the page): a tinted
                    icon chip carries the severity; severe and extreme alerts use the critical red, others amber. */}
                <Link
                  href={`/dispatch?date=${today}`}
                  className="group flex items-center gap-3 rounded-panel bg-card px-4 py-3 text-sm shadow-card ring-1 ring-line/60 transition-shadow hover:ring-line focus-visible:outline-2 focus-visible:outline-strong sm:px-5"
                >
                  <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", severe ? "bg-red-50 text-critical" : "bg-amber-50 text-amber-700")} aria-hidden>
                    <AlertTriangle className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">
                      <span className={cn("font-semibold", severe && "text-critical")}>{a.event}</span>{weather.sample ? " (sample)" : ""} at {a.site}
                      {a.endsAt ? <>, until {until(a.endsAt, today, timezone)}</> : null}
                    </span>
                    <span className="block text-[13px] text-muted">
                      {a.orders.length} deliver{a.orders.length === 1 ? "y" : "ies"} today ({a.orders.join(", ")})
                    </span>
                  </span>
                  <span className="hidden shrink-0 items-center gap-1 text-sm font-semibold text-brand-fg group-hover:underline sm:inline-flex">
                    Open dispatch<ChevronRight className="size-4" aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {forecast.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1 font-semibold text-amber-800"><CloudRain className="size-3.5" aria-hidden />Forecast</span>
          {forecast.slice(0, 4).map((a) => (
            <Link key={`${a.siteId}-${a.day}`} href={`/dispatch?date=${a.day}`} className="hover:underline">
              {a.hazards.map((h) => h.label).join(", ")} {a.day === today ? "today" : formatDate(a.day)} at {a.site} ({a.loads} load{a.loads === 1 ? "" : "s"})
            </Link>
          ))}
          {forecast.length > 4 && <span>+{forecast.length - 4} more</span>}
        </p>
      )}
    </section>
  );
}
