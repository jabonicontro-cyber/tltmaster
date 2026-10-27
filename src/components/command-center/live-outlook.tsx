import Link from "next/link";
import { AlertTriangle, ArrowRight, CalendarClock } from "lucide-react";
import { InfoTip } from "@/components/ui/info-tip";
import { Ring } from "@/components/ui/ring";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import { nextSteps, outlookTotals, type OutlookDay } from "@/lib/live/outlook";
import { formatCents } from "@/lib/money";
import type { Outlook } from "@/server/data/live";

const weekday = (date: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T00:00:00Z`));
const dayNumber = (date: string) => Number(date.slice(8, 10));

/**
 * Taviron Live: the next seven days at a glance — coverage, equipment that cannot run, drivers off — and what to do
 * next. Every figure comes from the records dispatch uses; nothing is predicted. Estimated revenue is labelled as such.
 * Layout (owner's references 2026-10-27): the figures first, the week as a bar chart (covered and open loads, today
 * highlighted), today's capacity as rings, and the next steps as cards.
 */
export function LiveOutlook({ outlook, today }: { outlook: Outlook; today: string }) {
  const totals = outlookTotals(outlook.days);
  const steps = nextSteps(outlook.days, today);
  const busiest = Math.max(1, ...outlook.days.map((d) => d.loads));
  const t = outlook.days.find((d) => d.date === today) ?? outlook.days[0];
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-label="Loads this week" className="min-w-0 rounded-panel bg-card shadow-card ring-1 ring-line/60">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 px-5 pt-5 sm:px-6">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:flex sm:flex-wrap sm:gap-x-8" aria-label="Outlook summary">
            <Figure value={totals.loads} label="loads planned" />
            <Figure value={totals.unassigned} label={`without a truck${totals.firstGap ? `, first on ${totals.firstGap === today ? "today" : formatDate(totals.firstGap)}` : ""}`} tone={totals.unassigned > 0 ? "amber" : undefined} />
            {totals.conflicts > 0 && <Figure value={totals.conflicts} label="booked on equipment that cannot run" tone="critical" />}
            {outlook.valueShown && totals.unassigned > 0 && (
              <Figure
                value={`≈ ${formatCents(totals.uncoveredValueCents)}`}
                label={`of work not yet covered (estimate${totals.uncoveredWithoutRate ? `; ${totals.uncoveredWithoutRate} load${totals.uncoveredWithoutRate === 1 ? "" : "s"} without a rate not included` : ""})`}
              />
            )}
          </div>
          <InfoTip label="Next 7 days">
            Planned loads, trucks that can run and drivers available, day by day — read from dispatch, the shop schedule and time off. Nothing is predicted.
            {outlook.valueShown && " The value is an estimate: each open load's planned quantity × its order's rates; surcharges are not included."}
          </InfoTip>
        </div>

        <ol className="mt-4 grid grid-cols-7 gap-1 px-3 sm:gap-2 sm:px-4" aria-label="Day by day">
          {outlook.days.map((d) => (
            <DayBar key={d.date} day={d} today={today} busiest={busiest} />
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 pt-3 pb-5 text-xs text-muted sm:px-6" aria-hidden>
          <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-brand" />Covered</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-amber-400" />Still open</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-critical" />Open today</span>
          {(!outlook.shopChecked || !outlook.timeOffChecked) && (
            <span className="ml-auto">Not checked: {[!outlook.shopChecked && "shop dates", !outlook.timeOffChecked && "time off"].filter(Boolean).join(", ")} (update not installed)</span>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-1">
        <section aria-label="Today's capacity" className="rounded-panel bg-card p-5 shadow-card ring-1 ring-line/60">
          <h3 className="text-sm font-semibold text-ink">Today</h3>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Ring size={84} part={t.assigned} whole={t.loads} label="Covered" caption={t.loads ? `${t.unassigned} open` : "no loads"} tone={t.unassigned ? "critical" : "green"} />
            <Ring size={84} part={t.trucksReady} whole={t.trucksReady + t.trucksDown} label="Trucks" caption={t.trucksDown ? `${t.trucksDown} down` : "all can run"} tone={t.trucksDown ? "amber" : "brand"} />
            <Ring size={84} part={t.driversAvailable} whole={t.driversAvailable + t.driversOff} label="Drivers" caption={t.driversOff ? `${t.driversOff} off` : "none off"} />
          </div>
        </section>

        <section aria-label="What to do next" className="rounded-panel bg-card p-5 shadow-card ring-1 ring-line/60">
          <h3 className="text-sm font-semibold text-ink">What to do next</h3>
          {steps.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Every load in the next 7 days has a truck and driver, and none is booked on equipment that cannot run.</p>
          ) : (
            <ul className="mt-3 space-y-2" aria-label="Next steps">
              {steps.map((s) => (
                <li key={s.key}>
                  <Link
                    href={s.href}
                    className={cn(
                      "group flex items-start gap-3 rounded-2xl px-3 py-2.5 text-sm transition-colors",
                      s.urgent ? "bg-red-50 text-critical hover:bg-red-100" : "bg-ink/[0.035] text-ink hover:bg-ink/[0.06]",
                    )}
                  >
                    <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full", s.urgent ? "bg-critical text-white" : "bg-card text-muted shadow-xs")} aria-hidden>
                      {s.urgent ? <AlertTriangle className="size-3.5" /> : <CalendarClock className="size-3.5" />}
                    </span>
                    <span className={cn("min-w-0 flex-1", s.urgent && "font-semibold")}>{s.text}</span>
                    <ArrowRight className="mt-1 size-3.5 shrink-0 opacity-60 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Figure({ value, label, tone }: { value: string | number; label: string; tone?: "amber" | "critical" }) {
  return (
    <p className="min-w-0">
      <span className={cn("block text-[1.75rem] leading-none font-semibold tracking-[-0.03em] tabular", tone === "amber" ? "text-amber-700" : tone === "critical" ? "text-critical" : "text-ink")}>{value}</span>
      <span className="mt-1.5 block max-w-[16rem] text-sm text-muted">{label}</span>
    </p>
  );
}

/**
 * One day's bar: height relative to the busiest day, covered loads below in the company colour, open loads on top
 * (red today, amber later). The link opens that day's board. The accessible name starts with the visible words
 * (day, date, loads) and then the spoken details (WCAG 2.5.3).
 */
function DayBar({ day: d, today, busiest }: { day: OutlookDay; today: string; busiest: number }) {
  const isToday = d.date === today;
  const height = d.loads ? Math.max(8, Math.round((d.loads / busiest) * 100)) : 0;
  const detail = `${formatDate(d.date)}: ${d.unassigned} without a truck, ${d.trucksReady} trucks ready, ${d.driversAvailable} drivers available${d.conflicts ? `, ${d.conflicts} booked on equipment that cannot run` : ""}`;
  return (
    <li className="min-w-0">
      <Link href={`/dispatch?date=${d.date}`} className={cn("group flex flex-col items-center rounded-2xl px-1 pt-2 pb-2.5 transition-colors hover:bg-ink/[0.035] focus-visible:outline-2 focus-visible:outline-brand-fg", isToday && "bg-brand-light/60 hover:bg-brand-light")}>
        <span className="order-last mt-2.5 flex flex-col items-center leading-tight">
          <span className={cn("text-xs font-semibold", isToday ? "text-brand-fg" : "text-muted")}>{isToday ? "Today" : weekday(d.date)}</span>
          <span className="text-xs tabular text-muted">{dayNumber(d.date)}</span>
        </span>
        <span className="flex flex-col items-center leading-none">
          <span className={cn("text-base font-semibold tabular", d.loads ? "text-ink" : "text-muted/70")}>{d.loads}</span>
          <span className="sr-only"> loads</span>
        </span>
        <span className="mt-2 flex h-36 w-full max-w-11 flex-col justify-end xl:h-48" aria-hidden>
          {d.loads === 0 ? (
            <span className="h-1.5 w-full rounded-full bg-ink/[0.07]" />
          ) : (
            <span className="flex w-full flex-col overflow-hidden rounded-xl transition-[filter] group-hover:brightness-105" style={{ height: `${height}%` }}>
              {d.unassigned > 0 && <span className={cn("w-full", isToday ? "bg-critical" : "bg-amber-400")} style={{ flexGrow: d.unassigned }} />}
              {d.assigned > 0 && <span className={cn("w-full bg-brand", !isToday && "opacity-80")} style={{ flexGrow: d.assigned }} />}
            </span>
          )}
        </span>
        <span className={cn("mt-1.5 h-4 text-[11px] font-semibold tabular", d.unassigned ? (isToday ? "text-critical" : "text-amber-700") : "text-transparent")} aria-hidden>
          {d.unassigned ? <>{d.unassigned}<span className="max-sm:hidden"> open</span></> : "·"}
        </span>
        <span className="sr-only">{detail}</span>
      </Link>
    </li>
  );
}
