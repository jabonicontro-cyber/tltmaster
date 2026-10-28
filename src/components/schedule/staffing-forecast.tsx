import Link from "next/link";
import { cn } from "@/lib/cn";
import { InfoTip } from "@/components/ui/info-tip";
import type { StaffingDay } from "@/lib/schedule/shifts";

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

/**
 * Staffing forecast (SCH-1): drivers on shift each day of the week against the planned loads. Counts only — how many
 * loads a driver can haul is the company's own call, so the only warning is loads on a day with no driver scheduled.
 */
export function StaffingForecast({ days, today }: { days: StaffingDay[]; today: string }) {
  const most = Math.max(1, ...days.map((d) => Math.max(d.drivers, d.loads ?? 0)));
  return (
    <section aria-label="Staffing forecast" className="mb-5 rounded-panel bg-card p-4 shadow-card ring-1 ring-line/60 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-base font-semibold text-ink">Staffing forecast</h2>
        <InfoTip label="Staffing forecast">Drivers on shift each day (people with a driver record) next to the loads planned for that day. Days without a schedule are counted separately; a planned load still needs a driver at dispatch.</InfoTip>
        <span className="ml-auto flex items-center gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-brand" aria-hidden />Drivers</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-ink/25" aria-hidden />Loads</span>
        </span>
      </div>
      <ol className="grid grid-cols-7 gap-1.5 sm:gap-3">
        {days.map((d) => {
          const short = d.loads !== null && d.loads > 0 && d.drivers === 0;
          const label = `${WEEKDAY.format(new Date(`${d.date}T12:00:00Z`))}: ${d.drivers} driver${d.drivers === 1 ? "" : "s"} on shift${d.loads === null ? "" : `, ${d.loads} load${d.loads === 1 ? "" : "s"} planned`}${d.unknown ? `, ${d.unknown} without a schedule` : ""}`;
          return (
            <li key={d.date} aria-label={label} className={cn("flex min-w-0 flex-col items-center rounded-xl px-1 py-2", d.date === today && "bg-brand-light/60")}>
              <div className="flex h-20 items-end gap-1" aria-hidden>
                <span className="w-2.5 rounded-full bg-brand sm:w-3.5" style={{ height: `${Math.max(4, (d.drivers / most) * 80)}px` }} />
                {d.loads !== null && <span className="w-2.5 rounded-full bg-ink/20 sm:w-3.5" style={{ height: `${Math.max(4, (d.loads / most) * 80)}px` }} />}
              </div>
              <span className="mt-2 text-xs font-medium text-muted" aria-hidden>{WEEKDAY.format(new Date(`${d.date}T12:00:00Z`))}</span>
              <span className="text-sm font-semibold tabular text-ink" aria-hidden>{d.drivers}<span className="font-normal text-muted">/{d.loads ?? "—"}</span></span>
              {short ? (
                <Link href={`/dispatch?date=${d.date}`} className="mt-0.5 text-[11px] font-semibold text-critical hover:underline">No driver</Link>
              ) : d.unknown ? (
                <span className="mt-0.5 text-[11px] text-muted" aria-hidden>{d.unknown} unset</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
