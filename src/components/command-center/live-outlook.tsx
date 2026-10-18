import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
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
 */
export function LiveOutlook({ outlook, today }: { outlook: Outlook; today: string }) {
  const totals = outlookTotals(outlook.days);
  const steps = nextSteps(outlook.days, today);
  const busiest = Math.max(1, ...outlook.days.map((d) => d.loads));
  return (
    <Card>
      <CardHeader
        title="Next 7 days"
        description="Planned loads, trucks that can run and drivers available, day by day — read from dispatch, the shop schedule and time off."
      />
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-line px-4 py-3 text-sm sm:px-5" aria-label="Outlook summary">
        <p><span className="text-lg font-semibold tabular text-ink">{totals.loads}</span> <span className="text-muted">loads planned</span></p>
        <p>
          <span className={cn("text-lg font-semibold tabular", totals.unassigned > 0 ? "text-amber-700" : "text-ink")}>{totals.unassigned}</span>{" "}
          <span className="text-muted">without a truck{totals.firstGap ? `, first on ${totals.firstGap === today ? "today" : formatDate(totals.firstGap)}` : ""}</span>
        </p>
        {totals.conflicts > 0 && (
          <p><span className="text-lg font-semibold tabular text-critical">{totals.conflicts}</span> <span className="text-muted">booked on equipment that cannot run</span></p>
        )}
        {outlook.valueShown && totals.unassigned > 0 && (
          <p title="Estimate: each open load's planned quantity × its order's material and hauling rates in that unit. Surcharges are not included.">
            <span className="text-lg font-semibold tabular text-ink">≈ {formatCents(totals.uncoveredValueCents)}</span>{" "}
            <span className="text-muted">
              of work not yet covered (estimate{totals.uncoveredWithoutRate ? `; ${totals.uncoveredWithoutRate} load${totals.uncoveredWithoutRate === 1 ? "" : "s"} without a rate not included` : ""})
            </span>
          </p>
        )}
      </div>

      <ol className="grid auto-cols-[minmax(8.75rem,1fr)] grid-flow-col overflow-x-auto" aria-label="Day by day">
        {outlook.days.map((d) => (
          <DayColumn key={d.date} day={d} today={today} busiest={busiest} shopChecked={outlook.shopChecked} />
        ))}
      </ol>

      <div className="border-t border-line px-4 py-3 sm:px-5">
        <h3 className="text-sm font-semibold text-ink">What to do next</h3>
        {steps.length === 0 ? (
          <p className="mt-1 text-sm text-muted">Every load in the next 7 days has a truck and driver, and none is booked on equipment that cannot run.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5" aria-label="Next steps">
            {steps.map((s) => (
              <li key={s.key}>
                <Link href={s.href} className={cn("group inline-flex items-start gap-1.5 text-sm hover:underline", s.urgent ? "font-semibold text-critical" : "text-ink")}>
                  <ArrowRight className="mt-0.5 size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  {s.text}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {(!outlook.shopChecked || !outlook.timeOffChecked) && (
          <p className="mt-2 text-xs text-muted">
            Not checked: {[!outlook.shopChecked && "shop dates (maintenance update not installed)", !outlook.timeOffChecked && "time off (time-off update not installed)"].filter(Boolean).join(", ")}.
          </p>
        )}
      </div>
    </Card>
  );
}

function DayColumn({ day: d, today, busiest, shopChecked }: { day: OutlookDay; today: string; busiest: number; shopChecked: boolean }) {
  const isToday = d.date === today;
  const gapTone = d.unassigned === 0 ? "" : isToday ? "bg-critical" : "bg-amber-400";
  const label = `${isToday ? "Today" : formatDate(d.date)}: ${d.loads} loads, ${d.unassigned} without a truck, ${d.trucksReady} trucks ready, ${d.driversAvailable} drivers available${d.conflicts ? `, ${d.conflicts} booked on equipment that cannot run` : ""}`;
  return (
    <li className="border-r border-line last:border-r-0">
      <Link href={`/dispatch?date=${d.date}`} aria-label={label} className={cn("flex h-full flex-col gap-2 px-3 py-3 transition-colors hover:bg-surface/60", isToday && "bg-surface/40")}>
        <p className="flex items-baseline justify-between gap-1">
          <span className={cn("text-xs font-semibold uppercase tracking-wide", isToday ? "text-brand-fg" : "text-muted")}>{isToday ? "Today" : weekday(d.date)}</span>
          <span className="text-xs tabular text-muted">{dayNumber(d.date)}</span>
        </p>
        <div>
          <p className="text-xl font-semibold tabular leading-none text-ink">{d.loads}</p>
          <p className="text-xs text-muted">load{d.loads === 1 ? "" : "s"}</p>
        </div>
        {/* Coverage: assigned in a neutral tone, open loads coloured; width relative to the busiest day. */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden>
          <div className="flex h-full" style={{ width: `${Math.round((d.loads / busiest) * 100)}%` }}>
            <div className="h-full bg-strong/70" style={{ width: d.loads ? `${(d.assigned / d.loads) * 100}%` : "0%" }} />
            <div className={cn("h-full", gapTone)} style={{ width: d.loads ? `${(d.unassigned / d.loads) * 100}%` : "0%" }} />
          </div>
        </div>
        <p className={cn("text-xs", d.unassigned ? (isToday ? "font-semibold text-critical" : "font-semibold text-amber-700") : "text-muted")}>
          {d.loads === 0 ? "Nothing planned" : d.unassigned ? `${d.unassigned} open` : "All covered"}
        </p>
        <dl className="mt-auto space-y-0.5 text-xs text-muted">
          <div className="flex justify-between gap-1"><dt>Trucks</dt><dd className="whitespace-nowrap tabular text-ink">{d.trucksReady}{d.trucksDown ? <span className="text-muted"> · {d.trucksDown} down</span> : null}</dd></div>
          <div className="flex justify-between gap-1"><dt>Drivers</dt><dd className="whitespace-nowrap tabular text-ink">{d.driversAvailable}{d.driversOff ? <span className="text-muted"> · {d.driversOff} off</span> : null}</dd></div>
          {d.conflicts > 0 && <div className="flex justify-between gap-1 font-semibold text-critical"><dt>Conflicts</dt><dd className="tabular">{d.conflicts}</dd></div>}
          {!shopChecked && <div className="text-[11px]">Shop dates not checked</div>}
        </dl>
      </Link>
    </li>
  );
}
