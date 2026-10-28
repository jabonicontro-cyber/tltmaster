import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";
import { cellText, timelineBar } from "@/lib/schedule/shifts";
import type { Face } from "@/server/data/faces";
import type { SchedulePerson } from "@/server/data/schedules";

const HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const hourLabel = (h: number) => (h === 0 || h === 24 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`);

/**
 * One day as a timeline (SCH-1): each person's shift as a bar across 24 hours, so overlaps and gaps in coverage show
 * at a glance. People on shift first by start time, then days off, then people without a schedule.
 */
export function DayTimeline({ people, date, faces = {} }: { people: SchedulePerson[]; date: string; faces?: Record<string, Face> }) {
  const rows = people
    .map((p) => ({ p, d: p.days.find((x) => x.date === date) }))
    .filter((r): r is { p: SchedulePerson; d: NonNullable<typeof r.d> } => Boolean(r.d))
    .sort((a, b) => {
      const rank = (s: string) => (s === "shift" ? 0 : s === "off" ? 1 : 2);
      return rank(a.d.status) - rank(b.d.status) || (a.d.start ?? "").localeCompare(b.d.start ?? "") || a.p.name.localeCompare(b.p.name);
    });
  return (
    <div className="overflow-hidden rounded-panel bg-card shadow-card ring-1 ring-line/60">
      <div className="grid grid-cols-[minmax(7rem,11rem)_1fr] items-end gap-3 border-b border-line px-4 py-2 text-[11px] text-muted sm:px-5">
        <span>Person</span>
        <div className="relative h-4" aria-hidden>
          {HOURS.map((h) => (
            <span key={h} className={cn("absolute -translate-x-1/2 tabular", h === 0 && "translate-x-0", h === 24 && "-translate-x-full")} style={{ left: `${(h / 24) * 100}%` }}>{hourLabel(h)}</span>
          ))}
        </div>
      </div>
      <ul aria-label="Shifts on this day">
        {rows.map(({ p, d }) => {
          const bar = timelineBar(d);
          const text = d.status === "shift" ? `${cellText(d)}${d.overnight ? " (overnight)" : ""}` : d.status === "off" ? "Day off" : "No schedule";
          return (
            <li key={p.employeeId} className="grid grid-cols-[minmax(7rem,11rem)_1fr] items-center gap-3 border-b border-line/60 px-4 py-2 last:border-0 sm:px-5" aria-label={`${p.name}: ${text}`}>
              <span className="flex min-w-0 items-center gap-2" aria-hidden>
                <Avatar name={p.name} src={faces[p.employeeId]?.src} fallbackSrc={faces[p.employeeId]?.fallbackSrc} size={24} />
                <span className="truncate text-sm font-medium text-ink">{p.name}</span>
              </span>
              <div className="relative h-7 rounded-lg bg-surface" aria-hidden>
                {[6, 12, 18].map((h) => <span key={h} className="absolute inset-y-0 w-px bg-line" style={{ left: `${(h / 24) * 100}%` }} />)}
                {bar ? (
                  <span
                    className={cn("absolute inset-y-1 flex items-center overflow-hidden rounded-md bg-brand px-2 text-[11px] font-semibold whitespace-nowrap text-white", bar.continues && "rounded-r-none")}
                    style={{ left: `${(bar.from / 1440) * 100}%`, width: `${((bar.to - bar.from) / 1440) * 100}%` }}
                  >
                    {cellText(d)}{bar.continues ? " →" : ""}
                  </span>
                ) : (
                  <span className="absolute inset-0 flex items-center px-2 text-xs text-muted">{d.status === "off" ? "Day off" : "No schedule"}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
