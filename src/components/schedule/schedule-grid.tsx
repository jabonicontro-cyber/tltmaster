"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { clearScheduleDay, endSchedulePattern, setScheduleDay, setSchedulePattern } from "@/app/(app)/schedule/actions";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/cn";
import { addDays, formatDate } from "@/lib/dates";
import type { CurrentPattern, ScheduleDay, SchedulePerson } from "@/server/data/schedules";

// The week's schedule: one row per person, one cell per day. People who manage schedules open a day to change it
// (a shift, a day off, or back to the regular schedule) or a person's repeating pattern (weekly or a rotation).

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "06:00" → "6:00a". */
function short(t: string | null) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const suffix = h < 12 ? "a" : "p";
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${suffix}`;
}

export function cellText(d: ScheduleDay) {
  if (d.status === "shift") return `${short(d.start)}–${short(d.end)}`;
  if (d.status === "off") return "Off";
  return "—";
}

function useRun(onDone?: () => void) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (p: () => Promise<ActionResult>) =>
    start(async () => {
      setError(null);
      const r = await p();
      if (r.ok) {
        toast.success(r.message ?? "Saved.");
        onDone?.();
        router.refresh();
      } else setError(r.error);
    });
  return { pending, error, run };
}

export function ScheduleGrid({ people, from, canManage, patterns }: { people: SchedulePerson[]; from: string; canManage: boolean; patterns: Record<string, CurrentPattern> }) {
  const [day, setDay] = useState<{ person: SchedulePerson; d: ScheduleDay } | null>(null);
  const [pattern, setPattern] = useState<SchedulePerson | null>(null);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return (
    <>
      <div className="overflow-x-auto rounded-panel border border-line/70 bg-card shadow-card">
        <table className="w-full min-w-[760px] text-sm">
          <caption className="sr-only">Schedule for the week of {formatDate(from)}</caption>
          <thead className="bg-surface text-left text-xs font-semibold text-muted">
            <tr>
              <th scope="col" className="px-3 py-2">Person</th>
              {dates.map((d, i) => <th key={d} scope="col" className="px-2 py-2 text-center">{WEEKDAYS[i]} <span className="font-normal">{d.slice(5).replace("-", "/")}</span></th>)}
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.employeeId} className="border-t border-line">
                <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                  <div>{p.name}</div>
                  <div className="text-xs font-normal text-muted">
                    {patterns[p.employeeId] ? (patterns[p.employeeId].kind === "weekly" ? "Weekly" : `${patterns[p.employeeId].cycleDays}-day rotation`) : "No repeating schedule"}
                    {canManage && <> · <button type="button" className="underline hover:text-ink" onClick={() => setPattern(p)}>{patterns[p.employeeId] ? "Change" : "Set"}<span className="sr-only"> {p.name}&apos;s schedule</span></button></>}
                  </div>
                </th>
                {p.days.map((d) => {
                  const label = `${p.name}, ${formatDate(d.date)}: ${d.status === "shift" ? `${cellText(d)}${d.overnight ? " (overnight)" : ""}` : d.status === "off" ? "day off" : "no schedule"}${d.source === "change" ? ", changed for this day" : ""}`;
                  const body = (
                    <span className={cn("inline-flex min-h-9 w-full items-center justify-center rounded px-1 text-xs font-semibold tabular",
                      d.status === "shift" ? "bg-surface text-ink" : d.status === "off" ? "text-muted" : "text-muted/70",
                      d.source === "change" && "ring-1 ring-strong")}>
                      {cellText(d)}{d.overnight && <span aria-hidden className="ml-0.5">☾</span>}
                    </span>
                  );
                  return (
                    <td key={d.date} className="px-1 py-1 text-center" title={d.reason || undefined}>
                      {canManage ? (
                        <button type="button" aria-label={`${label}. Change`} className="w-full rounded hover:bg-surface" onClick={() => setDay({ person: p, d })}>{body}</button>
                      ) : <span aria-label={label}>{body}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">☾ ends the next morning (overnight). A framed day was changed for that date only. — means no schedule: dispatch does not check that person.</p>
      {day && <DayDialog person={day.person} day={day.d} onClose={() => setDay(null)} />}
      {pattern && <PatternDialog person={pattern} current={patterns[pattern.employeeId] ?? null} weekStart={from} onClose={() => setPattern(null)} />}
    </>
  );
}

function DayDialog({ person, day, onClose }: { person: SchedulePerson; day: ScheduleDay; onClose: () => void }) {
  const [kind, setKind] = useState<"shift" | "off">(day.status === "off" ? "off" : "shift");
  const [start, setStart] = useState(day.start ?? "06:00");
  const [end, setEnd] = useState(day.end ?? "16:30");
  const [breakMinutes, setBreak] = useState(String(day.breakMinutes ?? 0));
  const [reason, setReason] = useState(day.source === "change" ? day.reason : "");
  const { pending, error, run } = useRun(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title={`${person.name} · ${formatDate(day.date)}`}
      description="Changes this date only; the repeating schedule stays as it is."
      footer={
        <>
          {day.source === "change" && <Button variant="ghost" disabled={pending} onClick={() => run(() => clearScheduleDay({ employeeId: person.employeeId, date: day.date }))}>Use regular schedule</Button>}
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button loading={pending} onClick={() => run(() => setScheduleDay({ employeeId: person.employeeId, date: day.date, kind, start, end, breakMinutes: Number(breakMinutes) || 0, reason }))}>Save</Button>
        </>
      }>
      <div className="space-y-3">
        <FormError message={error} />
        <fieldset className="flex gap-4">
          <legend className="sr-only">This day</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="day-kind" checked={kind === "shift"} onChange={() => setKind("shift")} /> Works</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="day-kind" checked={kind === "off"} onChange={() => setKind("off")} /> Day off</label>
        </fieldset>
        {kind === "shift" && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Starts" htmlFor="day-start"><Input id="day-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="Ends" htmlFor="day-end" hint={end <= start ? "Next day" : undefined}><Input id="day-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            <Field label="Break (min)" htmlFor="day-break"><Input id="day-break" inputMode="numeric" value={breakMinutes} onChange={(e) => setBreak(e.target.value)} /></Field>
          </div>
        )}
        <Field label="Reason (optional)" htmlFor="day-reason"><Input id="day-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Covering for Dan, plant open Saturday" /></Field>
      </div>
    </Dialog>
  );
}

type Row = { on: boolean; start: string; end: string; breakMinutes: string };

function PatternDialog({ person, current, weekStart, onClose }: { person: SchedulePerson; current: CurrentPattern | null; weekStart: string; onClose: () => void }) {
  const [kind, setKind] = useState<"weekly" | "rotation">(current?.kind ?? "weekly");
  const [cycle, setCycle] = useState(String(current?.kind === "rotation" ? current.cycleDays : 8));
  const [anchor, setAnchor] = useState(current?.kind === "rotation" ? current.anchor : weekStart);
  const [from, setFrom] = useState(weekStart);
  const [note, setNote] = useState(current?.note ?? "");
  const size = kind === "weekly" ? 7 : Math.min(56, Math.max(1, Number(cycle) || 1));
  const initial = (n: number): Row[] => Array.from({ length: n }, (_, i) => {
    const d = current?.days.find((x) => x.day === i);
    return d ? { on: true, start: d.start, end: d.end, breakMinutes: String(d.breakMinutes) } : { on: !current && (kind === "weekly" ? i < 5 : i < 4), start: "06:00", end: "16:30", breakMinutes: "30" };
  });
  const [rows, setRows] = useState<Row[]>(() => initial(56));
  const set = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const { pending, error, run } = useRun(onClose);
  const save = () => run(() => setSchedulePattern({
    employeeId: person.employeeId, kind, cycleDays: size, anchor: kind === "rotation" ? anchor : undefined, from, note,
    days: rows.slice(0, size).map((r, day) => ({ ...r, day })).filter((r) => r.on).map((r) => ({ day: r.day, start: r.start, end: r.end, breakMinutes: Number(r.breakMinutes) || 0 })),
  }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={`${person.name} · repeating schedule`}
      description="Applies from the start date; the previous schedule is kept for the days before it."
      footer={
        <>
          {current && <Button variant="ghost" disabled={pending} onClick={() => run(() => endSchedulePattern({ employeeId: person.employeeId, lastDay: addDays(from, -1) }))}>End before {formatDate(from)}</Button>}
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button loading={pending} onClick={save}>Save schedule</Button>
        </>
      }>
      <div className="space-y-4">
        <FormError message={error} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Repeats" htmlFor="pattern-kind">
            <Select id="pattern-kind" value={kind} onChange={(e) => setKind(e.target.value as "weekly" | "rotation")}>
              <option value="weekly">Every week</option>
              <option value="rotation">Rotation (e.g. 4 on, 4 off)</option>
            </Select>
          </Field>
          <Field label="Starts on" htmlFor="pattern-from"><DateInput id="pattern-from" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Note (optional)" htmlFor="pattern-note"><Input id="pattern-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Day crew" /></Field>
        </div>
        {kind === "rotation" && (
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <Field label="Cycle length (days)" htmlFor="pattern-cycle" hint="4 on, 4 off = 8"><Input id="pattern-cycle" inputMode="numeric" value={cycle} onChange={(e) => setCycle(e.target.value)} /></Field>
            <Field label="Day 1 of the cycle" htmlFor="pattern-anchor"><DateInput id="pattern-anchor" value={anchor} onChange={(e) => setAnchor(e.target.value)} /></Field>
          </div>
        )}
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-ink">Shifts</legend>
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {rows.slice(0, size).map((r, i) => {
              const label = kind === "weekly" ? WEEKDAYS[i] : `Day ${i + 1}`;
              return (
                <div key={i} className="grid grid-cols-[6rem_1fr_1fr_6rem] items-center gap-2">
                  <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} /> {label}</label>
                  {r.on ? (
                    <>
                      <Input aria-label={`${label} starts`} type="time" value={r.start} onChange={(e) => set(i, { start: e.target.value })} />
                      <Input aria-label={`${label} ends`} type="time" value={r.end} onChange={(e) => set(i, { end: e.target.value })} />
                      <Input aria-label={`${label} break minutes`} inputMode="numeric" value={r.breakMinutes} onChange={(e) => set(i, { breakMinutes: e.target.value })} />
                    </>
                  ) : <span className="col-span-3 text-sm text-muted">Off</span>}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">Columns: starts, ends, break minutes. An end at or before the start runs overnight.</p>
        </fieldset>
      </div>
    </Dialog>
  );
}
