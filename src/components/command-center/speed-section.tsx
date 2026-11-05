import { Gauge, Receipt, ClipboardList } from "lucide-react";
import type { ReactNode } from "react";
import { InfoTip } from "@/components/ui/info-tip";
import { formatTime } from "@/lib/orders/schedule";
import type { WeekSpeed } from "@/lib/command-center/speed";
import { formatDate } from "@/lib/dates";
import type { SpeedMetrics } from "@/server/data/speed";
import { SPEED_DAYS } from "@/server/data/speed";

/** B86: three speed figures measured from the last 30 days of recorded actions. Never estimated. */
export function SpeedSection({ speed, say = (t: string) => t }: { speed: SpeedMetrics; /** Freight wording (src/lib/industry.ts adaptWording). */ say?: (text: string) => string }) {
  const { planning, billingReady, pace } = speed;
  return (
    <div>
      <ul className="divide-y divide-line/70 overflow-hidden rounded-panel bg-card shadow-card ring-1 ring-line/60" aria-label="Speed">
        {planning !== undefined && (
          <Figure
            icon={<ClipboardList className="size-4" aria-hidden />}
            label={say("Time to plan tomorrow")}
            value={planning ? duration(planning.medianMinutes) : null}
            sub={say(planning ? `Usually done by ${clock(planning.medianDoneAt)} · ${planning.days} days measured` : "Needs at least 3 days with trucks assigned the day before.")}
            how={say("From the first to the last truck assigned the day before the deliveries (median).")}
          />
        )}
        {billingReady !== undefined && (
          <Figure
            icon={<Receipt className="size-4" aria-hidden />}
            label={say("Delivery to ticket accepted")}
            value={billingReady ? hours(billingReady.medianHours) : null}
            sub={say(billingReady ? `${Math.round(billingReady.withinDay * 100)}% within a day · ${billingReady.tickets} tickets` : "Needs at least 5 accepted tickets.")}
            how={say("From the delivery time on the ticket to its acceptance (median). An accepted ticket is ready for billing; Reports shows delivery to billing for whole orders.")}
          />
        )}
        {pace !== undefined && (
          <Figure
            icon={<Gauge className="size-4" aria-hidden />}
            label={say("Ticket review pace")}
            value={pace ? `${pace.perMinute}` : null}
            unit={pace ? "per minute" : undefined}
            sub={say(pace ? `${pace.timed} reviews over ${duration(pace.minutes)} of review time` : "Needs at least 5 minutes of reviewing one ticket after another.")}
            how={say("Time between one person's reviews in the same sitting; batch acceptances and a sitting's first review are not timed.")}
          />
        )}
      </ul>
      {speed.weeks.length > 0 && (planning !== undefined || billingReady !== undefined) && <WeekByWeek weeks={speed.weeks} plan={planning !== undefined} billing={billingReady !== undefined} say={say} />}
      <p className="mt-2 px-1 text-xs text-muted">Measured from what was recorded in the last {SPEED_DAYS} days. Nothing here is estimated.</p>
    </div>
  );
}

/** The two figures per week, newest first (owner 2026-11-04: watch both week to week). Weeks with too little are marked. */
function WeekByWeek({ weeks: all, plan, billing, say }: { weeks: WeekSpeed[]; plan: boolean; billing: boolean; say: (text: string) => string }) {
  // Weeks older than the first measured one are left out (a new company, or a demo's few weeks of history); this week stays.
  const oldest = all.reduce((n, w, i) => ((plan && w.planning) || (billing && w.billingReady) ? i : n), 0);
  const weeks = all.slice(0, Math.max(oldest + 1, 1));
  const label = (w: string, i: number) => (i === 0 ? "This week" : i === 1 ? "Last week" : `Week of ${formatDate(w)}`);
  return (
    <details className="mt-2 rounded-panel bg-card px-4 py-2 ring-1 ring-line/60">
      <summary className="cursor-pointer py-1 text-sm font-medium text-ink">Week by week</summary>
      <table className="mt-1 w-full text-sm" aria-label="Speed week by week">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="py-1 font-medium">Week</th>
            {plan && <th className="py-1 text-right font-medium">Plan tomorrow</th>}
            {billing && <th className="py-1 text-right font-medium">{say("Ticket accepted")}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {weeks.map((w, i) => (
            <tr key={w.weekStart}>
              <td className="py-1.5">{label(w.weekStart, i)}</td>
              {plan && <td className="py-1.5 text-right tabular">{w.planning ? duration(w.planning.medianMinutes) : <span className="text-xs text-muted">Not enough</span>}</td>}
              {billing && <td className="py-1.5 text-right tabular">{w.billingReady ? hours(w.billingReady.medianHours) : <span className="text-xs text-muted">Not enough</span>}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pb-1 pt-2 text-xs text-muted">Medians, measured the same way as above. Weeks start on Monday; this week is still in progress.</p>
    </details>
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
