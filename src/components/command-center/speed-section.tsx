import { Gauge, Receipt, ClipboardList } from "lucide-react";
import type { ReactNode } from "react";
import { InfoTip } from "@/components/ui/info-tip";
import { formatTime } from "@/lib/orders/schedule";
import type { SpeedMetrics } from "@/server/data/speed";
import { SPEED_DAYS } from "@/server/data/speed";

/** B86: three speed figures measured from the last 30 days of recorded actions. Never estimated. */
export function SpeedSection({ speed }: { speed: SpeedMetrics }) {
  const { planning, billingReady, pace } = speed;
  return (
    <div>
      <ul className="divide-y divide-line/70 overflow-hidden rounded-panel bg-card shadow-card ring-1 ring-line/60" aria-label="Speed">
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
      <p className="mt-2 px-1 text-xs text-muted">Measured from what was recorded in the last {SPEED_DAYS} days. Nothing here is estimated.</p>
    </div>
  );
}

function Figure({ icon, label, value, unit, sub, how }: { icon: ReactNode; label: string; value: string | null; unit?: string; sub: string; how: string }) {
  return (
    <li aria-label={label} className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface text-ink">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm font-medium text-ink">{label}<InfoTip label={`How ${label.toLowerCase()} is measured`}>{how}</InfoTip></span>
        <span className="block text-xs text-muted">{sub}</span>
      </span>
      {value === null ? (
        <span className="max-w-24 shrink-0 text-right text-xs font-medium text-muted">Not enough measured yet</span>
      ) : (
        <span className="shrink-0 text-right text-xl leading-tight font-semibold tracking-[-0.02em] text-ink tabular">
          {value}
          {unit && <span className="block text-xs font-medium tracking-normal text-muted">{unit}</span>}
        </span>
      )}
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
