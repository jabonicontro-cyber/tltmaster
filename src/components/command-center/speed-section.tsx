import { Gauge, Receipt, ClipboardList } from "lucide-react";
import type { ReactNode } from "react";
import { formatTime } from "@/lib/orders/schedule";
import type { SpeedMetrics } from "@/server/data/speed";
import { SPEED_DAYS } from "@/server/data/speed";

/** B86: three speed figures measured from the last 30 days of recorded actions. Never estimated. */
export function SpeedSection({ speed }: { speed: SpeedMetrics }) {
  const { planning, billingReady, pace } = speed;
  return (
    <div>
      <ul className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-3" aria-label="Speed">
        {planning !== undefined && (
          <Figure
            icon={<ClipboardList className="size-4" aria-hidden />}
            label="Time to plan tomorrow"
            value={planning ? duration(planning.medianMinutes) : null}
            sub={planning ? `Usually done by ${clock(planning.medianDoneAt)} · ${planning.days} days measured` : "Needs at least 3 days with trucks assigned the day before."}
            how="From the first to the last truck assigned the day before the deliveries (median)."
          />
        )}
        {billingReady !== undefined && (
          <Figure
            icon={<Receipt className="size-4" aria-hidden />}
            label="Delivery to billing-ready"
            value={billingReady ? hours(billingReady.medianHours) : null}
            sub={billingReady ? `${Math.round(billingReady.withinDay * 100)}% within a day · ${billingReady.tickets} tickets` : "Needs at least 5 accepted tickets."}
            how="From the delivery time on the ticket to its acceptance (median)."
          />
        )}
        {pace !== undefined && (
          <Figure
            icon={<Gauge className="size-4" aria-hidden />}
            label="Ticket review pace"
            value={pace ? `${pace.perMinute}` : null}
            unit={pace ? "per minute" : undefined}
            sub={pace ? `${pace.timed} reviews over ${duration(pace.minutes)} of review time` : "Needs at least 5 minutes of reviewing one ticket after another."}
            how="Time between one person's reviews in the same sitting; batch acceptances and a sitting's first review are not timed."
          />
        )}
      </ul>
      <p className="mt-3 text-xs text-muted">Measured from what was recorded in the last {SPEED_DAYS} days. Nothing here is estimated.</p>
    </div>
  );
}

function Figure({ icon, label, value, unit, sub, how }: { icon: ReactNode; label: string; value: string | null; unit?: string; sub: string; how: string }) {
  return (
    <li aria-label={label} className="flex flex-col rounded-panel border border-line/70 bg-card p-4 shadow-card sm:p-5">
      <p className="flex items-center gap-2 text-[13px] font-medium text-muted">
        <span className="grid size-7 place-items-center rounded-full bg-surface text-ink">{icon}</span>
        {label}
      </p>
      {value === null ? (
        <p className="mt-3 text-lg font-semibold text-muted">Not enough measured yet</p>
      ) : (
        <p className="mt-3 text-[2rem] leading-none font-semibold tracking-[-0.03em] text-ink tabular">
          {value}
          {unit && <span className="ml-1.5 text-base font-medium tracking-normal text-muted">{unit}</span>}
        </p>
      )}
      <p className="mt-2 text-sm text-ink">{sub}</p>
      <p className="mt-auto pt-3 text-xs text-muted">{how}</p>
    </li>
  );
}

function duration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function hours(h: number) {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round((h / 24) * 10) / 10} days`;
}

function clock(minutes: number) {
  return formatTime(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
}
