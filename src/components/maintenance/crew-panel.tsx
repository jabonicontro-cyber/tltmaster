"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Check, Clock, Play, Plus, Square, X } from "lucide-react";
import { toast } from "sonner";
import { addMechanic, addTask, addTime, removeMechanic, setMyStatus, setTask, startTimer, stopTimer, voidTime } from "@/app/(app)/maintenance/crew-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action-result";
import type { WorkOrderCrew } from "@/server/data/maintenance-crew";

const STATUS_TONE = { assigned: "gray", working: "green", paused: "amber", done: "blue" } as const;
const STATUS_LABEL = { assigned: "Assigned", working: "Working", paused: "Paused", done: "Done" } as const;

export const hoursText = (minutes: number) => `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (p: () => Promise<ActionResult>, after?: () => void) =>
    start(async () => {
      const r = await p();
      if (r.ok) {
        toast.success(r.message ?? "Saved.");
        after?.();
        router.refresh();
      } else toast.error(r.error);
    });
  return { pending, run };
}

/** Elapsed time on a running timer, updated each minute. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular">{hoursText(Math.max(0, Math.floor((now - Date.parse(since)) / 60000)))}</span>;
}

/** Crew and labor time on one work order. */
export function CrewPanel({ workOrderId, status, data, me, canManage, today, timeZone }: {
  workOrderId: string; status: string; data: WorkOrderCrew; me: string; canManage: boolean; today: string; timeZone: string;
}) {
  const { pending, run } = useRun();
  const [adding, setAdding] = useState("");
  const [log, setLog] = useState<{ userId: string; date: string; start: string; end: string; note: string } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null);
  const [reason, setReason] = useState("");
  const router = useRouter();
  const open = !["closed", "canceled"].includes(status);
  const mine = data.crew.find((c) => c.userId === me);
  const myTimerHere = data.myTimer?.workOrderId === workOrderId;
  const candidates = data.options.filter((o) => !data.crew.some((c) => c.userId === o.userId));
  const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

  return (
    <div className="space-y-5">
      {canManage && open && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface p-3">
          {myTimerHere ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink"><Clock className="size-4" aria-hidden /> Working · <Elapsed since={data.myTimer!.startedAt} /></span>
              <Button size="sm" disabled={pending} onClick={() => run(() => stopTimer())} icon={<Square className="size-4" aria-hidden />}>Stop</Button>
            </>
          ) : data.myTimer ? (
            <span className="text-sm text-muted">Your timer is running on {data.myTimer.number}. Stop it there before starting here.</span>
          ) : status === "in_progress" ? (
            <Button size="sm" disabled={pending} onClick={() => run(() => startTimer({ workOrderId }))} icon={<Play className="size-4" aria-hidden />}>Start work</Button>
          ) : (
            <span className="text-sm text-muted">Timers start once the work order is In progress.</span>
          )}
          {mine && !myTimerHere && mine.status !== "done" && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setMyStatus({ workOrderId, status: "done" }))}>Mark my part done</Button>
          )}
        </div>
      )}

      <section aria-label="Crew">
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {data.crew.length === 0 && <li className="px-3 py-2.5 text-sm text-muted">No mechanic assigned yet.</li>}
          {data.crew.map((c) => (
            <li key={c.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="text-sm text-ink">
                <span className="font-medium">{c.name}</span>
                {c.role === "lead" && <Badge tone="blue" className="ml-2">Lead</Badge>}
                <Badge tone={STATUS_TONE[c.status]} className="ml-2">{STATUS_LABEL[c.status]}</Badge>
              </span>
              {canManage && open && (
                <span className="flex gap-1">
                  {c.role !== "lead" && <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => addMechanic({ workOrderId, userId: c.userId, lead: true }))}>Make lead</Button>}
                  <Button size="sm" variant="ghost" disabled={pending} aria-label={`Remove ${c.name}`} onClick={() => run(() => removeMechanic({ workOrderId, userId: c.userId }))}><X className="size-4" aria-hidden /></Button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {canManage && open && candidates.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            <Select aria-label="Add a mechanic" value={adding} onChange={(e) => setAdding(e.target.value)} className="h-9 w-56">
              <option value="">Add a mechanic…</option>
              {candidates.map((o) => <option key={o.userId} value={o.userId}>{o.name}</option>)}
            </Select>
            <Button size="sm" variant="secondary" disabled={!adding || pending} onClick={() => run(() => addMechanic({ workOrderId, userId: adding, lead: data.crew.length === 0 }), () => setAdding(""))}>
              {data.crew.length === 0 ? "Assign as lead" : "Add to crew"}
            </Button>
          </div>
        )}
      </section>

      <section aria-label="Labor time" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Labor · {hoursText(data.totalMinutes)}</h3>
          {canManage && open && data.crew.length > 0 && !log && (
            <Button size="sm" variant="ghost" icon={<Plus className="size-4" aria-hidden />} onClick={() => setLog({ userId: data.crew.find((c) => c.userId === me)?.userId ?? data.crew[0].userId, date: today, start: "", end: "", note: "" })}>Log time</Button>
          )}
        </div>
        {log && (
          <form
            aria-label="Log time"
            className="flex flex-wrap gap-2 rounded-panel border border-line/70 bg-card shadow-card p-3"
            onSubmit={(e) => { e.preventDefault(); run(() => addTime({ workOrderId, ...log }), () => setLog(null)); }}
          >
            <Select aria-label="Mechanic" value={log.userId} onChange={(e) => setLog({ ...log, userId: e.target.value })} className="min-w-0 basis-full">
              {data.crew.map((c) => <option key={c.userId} value={c.userId}>{c.name}</option>)}
            </Select>
            <DateInput aria-label="Date" value={log.date} max={today} onChange={(e) => setLog({ ...log, date: e.target.value })} className="w-40" />
            <Input aria-label="Start time" type="time" value={log.start} onChange={(e) => setLog({ ...log, start: e.target.value })} className="w-32" />
            <Input aria-label="End time" type="time" value={log.end} onChange={(e) => setLog({ ...log, end: e.target.value })} className="w-32" />
            <Input aria-label="Note" placeholder="What was done (optional)" value={log.note} maxLength={500} onChange={(e) => setLog({ ...log, note: e.target.value })} className="min-w-0 basis-full" />
            <div className="flex basis-full gap-2">
              <Button type="submit" size="sm" disabled={pending || !log.start || !log.end}>Save time</Button>
              <Button size="sm" variant="ghost" onClick={() => setLog(null)}>Cancel</Button>
            </div>
          </form>
        )}
        {data.time.length > 0 ? (
          <ul className="divide-y divide-line rounded-2xl border border-line text-sm">
            {data.time.map((t) => (
              <li key={t.id} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 ${t.voided ? "text-muted" : "text-ink"}`}>
                <span>
                  <span className={`font-medium ${t.voided ? "line-through" : ""}`}>{t.name}</span> · {fmt(t.startedAt)} – {t.endedAt ? fmt(t.endedAt) : "running"}
                  {t.minutes !== null && <span className="tabular"> · {hoursText(t.minutes)}</span>}
                  {t.source === "manual" && <span className="text-muted"> · logged later</span>}
                  {t.note && <span className="text-muted"> · {t.note}</span>}
                  {t.voided && <span> · removed: {t.voidReason}</span>}
                </span>
                {canManage && open && !t.voided && t.endedAt && (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setReason(""); setRemoving({ id: t.id, label: `${t.name}, ${fmt(t.startedAt)}` }); }}>Remove</Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No time logged yet. Labor hours come from the time logged here.</p>
        )}
      </section>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove this time"
        description={`${removing?.label ?? ""}. It stops counting toward labor but stays in the history.`}
        confirmLabel="Remove time"
        tone="danger"
        onConfirm={async () => {
          if (!removing) return;
          if (reason.trim().length < 3) return "Say why this time is being removed.";
          const r = await voidTime({ workOrderId, entryId: removing.id, reason });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Removed.");
          router.refresh();
        }}
      >
        <Field label="Reason" htmlFor="void-reason">
          <Input id="void-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Logged on the wrong work order" />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

/** The work order's checklist. */
export function TaskChecklist({ workOrderId, status, tasks, canManage }: { workOrderId: string; status: string; tasks: WorkOrderCrew["tasks"]; canManage: boolean }) {
  const { pending, run } = useRun();
  const [title, setTitle] = useState("");
  const open = !["closed", "canceled"].includes(status);
  const done = tasks.filter((t) => t.status !== "open").length;
  return (
    <div className="space-y-3">
      {tasks.length > 0 && <p className="text-sm text-muted">{done} of {tasks.length} done</p>}
      <ul className="space-y-1.5" aria-label="Checklist">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-2">
            <button
              type="button"
              disabled={!canManage || !open || pending}
              aria-label={t.status === "open" ? `Mark "${t.title}" done` : `Reopen "${t.title}"`}
              aria-pressed={t.status === "done"}
              onClick={() => run(() => setTask({ workOrderId, taskId: t.id, status: t.status === "open" ? "done" : "open" }))}
              className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded border ${t.status === "done" ? "border-strong bg-strong text-white" : "border-line bg-card"} disabled:opacity-60`}
            >
              {t.status === "done" && <Check className="size-3.5" aria-hidden />}
            </button>
            <span className="text-sm">
              <span className={t.status === "open" ? "text-ink" : "text-muted line-through"}>{t.title}</span>
              {t.status === "skipped" && <span className="text-muted"> (skipped)</span>}
              {t.doneBy && <span className="ml-1 text-xs text-muted">· {t.doneBy}</span>}
            </span>
          </li>
        ))}
      </ul>
      {tasks.length === 0 && <p className="text-sm text-muted">No checklist yet.</p>}
      {canManage && open && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(() => addTask({ workOrderId, title }), () => setTitle("")); }}>
          <Input aria-label="New task" placeholder="Add a step, e.g. Torque wheel nuts" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} className="h-9 min-w-0 flex-1" />
          <Button type="submit" size="sm" variant="secondary" disabled={pending || title.trim().length < 2}>Add</Button>
        </form>
      )}
    </div>
  );
}
