"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Check, ChevronRight, Hand, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { setWorkOrderStatus } from "@/app/(app)/maintenance/actions";
import { addMechanic, setMyStatus, startTimer, stopTimer } from "@/app/(app)/maintenance/crew-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { formatDate } from "@/lib/dates";
import { STATUS_TONE, WO_STATUSES, WO_URGENCIES, type WoStatus } from "@/lib/maintenance";
import type { MyJob, OpenJob } from "@/server/data/maintenance-crew";

// The mechanic's phone workspace (docs/COMPANION_APP.md): large targets, one primary action per job. Every action is
// the same server action and database function as the work order page; nothing here bypasses the work order rules.

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (p: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await p();
      if (r.ok) {
        toast.success(r.message ?? "Saved.");
        router.refresh();
      } else toast.error(r.error);
    });
  return { pending, run };
}

const minutesSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
const clock = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;

/** The running timer, pinned to the top so it is never forgotten. */
export function RunningTimer({ timer }: { timer: { workOrderId: string; number: string; startedAt: string } }) {
  const { pending, run } = useRun();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  return (
    <section aria-label="Your running timer" className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-strong bg-card p-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">Working on <Link href={`/maintenance/work-orders/${timer.workOrderId}`} className="underline">{timer.number}</Link></p>
        <p className="text-sm text-muted">Timer running · <span className="tabular">{clock(minutesSince(timer.startedAt, now))}</span></p>
      </div>
      <Button size="lg" variant="dark" className="min-h-12" disabled={pending} onClick={() => run(() => stopTimer())} icon={<Square className="size-4" aria-hidden />}>Stop timer</Button>
    </section>
  );
}

function JobHeader({ job }: { job: OpenJob }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold text-muted">{job.number} · {job.unit}</p>
      <p className="mt-0.5 font-semibold text-ink">{job.title}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge tone={STATUS_TONE[job.status as WoStatus] ?? "gray"}>{WO_STATUSES[job.status as WoStatus] ?? job.status}</Badge>
        {job.safetyCritical && <Badge tone="red">Safety-critical</Badge>}
        {(job.urgency === "immediate" || job.urgency === "high") && <Badge tone={job.urgency === "immediate" ? "red" : "amber"}>{WO_URGENCIES[job.urgency as keyof typeof WO_URGENCIES]}</Badge>}
      </div>
    </div>
  );
}

/** One of my jobs: the next step that fits its state, and a way into the full work order. */
export function MyJobCard({ job, timerHere, timerElsewhere }: { job: MyJob; timerHere: boolean; timerElsewhere: boolean }) {
  const { pending, run } = useRun();
  const canStart = ["reported", "triaged", "scheduled", "awaiting_parts"].includes(job.status);
  return (
    <li className="rounded-panel border border-line/70 bg-card shadow-card p-4">
      <div className="flex items-start justify-between gap-3">
        <JobHeader job={job} />
        <Link href={`/maintenance/work-orders/${job.id}`} aria-label={`Open ${job.number}`} className="-m-2 flex min-h-11 min-w-11 items-center justify-center rounded text-muted hover:text-ink">
          <ChevronRight className="size-5" aria-hidden />
        </Link>
      </div>
      <p className="mt-2 text-sm text-muted">
        {job.myRole === "lead" ? "You lead this job" : "You are helping"}
        {job.tasksTotal > 0 && <> · Checklist {job.tasksDone} of {job.tasksTotal}</>}
        {job.scheduledFor && <> · Scheduled {formatDate(job.scheduledFor)}</>}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {job.status === "in_progress" && !timerHere && (
          <Button size="lg" className="min-h-12" disabled={pending || timerElsewhere} onClick={() => run(() => startTimer({ workOrderId: job.id }))} icon={<Play className="size-4" aria-hidden />}>Start timer</Button>
        )}
        {timerHere && <Button size="lg" variant="dark" className="min-h-12" disabled={pending} onClick={() => run(() => stopTimer())} icon={<Square className="size-4" aria-hidden />}>Stop timer</Button>}
        {canStart && (
          <Button size="lg" className="min-h-12" disabled={pending} onClick={() => run(() => setWorkOrderStatus({ id: job.id, status: "in_progress", note: "", editSeq: job.editSeq }))} icon={<Play className="size-4" aria-hidden />}>Start this job</Button>
        )}
        {!timerHere && job.myStatus !== "done" && (job.status === "in_progress" || job.status === "awaiting_parts") && (
          <Button size="lg" variant="secondary" className="min-h-12" disabled={pending} onClick={() => run(() => setMyStatus({ workOrderId: job.id, status: "done" }))} icon={<Check className="size-4" aria-hidden />}>My part is done</Button>
        )}
      </div>
      {timerElsewhere && job.status === "in_progress" && <p className="mt-2 text-xs text-muted">Stop your other timer first.</p>}
    </li>
  );
}

/** An open job nobody leads yet: take it (you become the lead, the same as assigning it on the work order). */
export function OpenJobCard({ job, me }: { job: OpenJob; me: string }) {
  const { pending, run } = useRun();
  return (
    <li className="rounded-panel border border-line/70 bg-card shadow-card p-4">
      <div className="flex items-start justify-between gap-3">
        <JobHeader job={job} />
        <Link href={`/maintenance/work-orders/${job.id}`} aria-label={`Open ${job.number}`} className="-m-2 flex min-h-11 min-w-11 items-center justify-center rounded text-muted hover:text-ink">
          <ChevronRight className="size-5" aria-hidden />
        </Link>
      </div>
      <div className="mt-3">
        <Button size="lg" variant="secondary" className="min-h-12" disabled={pending} onClick={() => run(() => addMechanic({ workOrderId: job.id, userId: me, lead: true }))} icon={<Hand className="size-4" aria-hidden />}>Take this job</Button>
      </div>
    </li>
  );
}
