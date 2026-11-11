"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Check, ChevronRight, Hand, PackageX, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { addMechanic, finishJob, startJob, startTimer, stopTimer, waitForPart } from "@/app/(app)/maintenance/crew-actions";
import { returnUnitAfterShop } from "@/app/(app)/fleet/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action-result";
import { formatDate } from "@/lib/dates";
import { STATUS_TONE, WO_STATUSES, WO_URGENCIES, fixedFromNotes, mechanicNextStep, type WoStatus } from "@/lib/maintenance";
import type { MyJob, OpenJob } from "@/server/data/maintenance-crew";

// The mechanic's phone workspace (docs/COMPANION_APP.md): large targets, one primary action per job. Every action is
// the same server action and database function as the work order page; nothing here bypasses the work order rules.

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (p: () => Promise<ActionResult<unknown>>, after?: () => void) =>
    start(async () => {
      const r = await p();
      if (r.ok) {
        toast.success(r.message ?? "Saved.");
        after?.();
        router.refresh();
      } else toast.error(r.error);
    });
  return { pending, run, start, router };
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
    <section aria-label="Your running timer" className="mb-4 flex flex-wrap items-center gap-3 rounded-panel bg-card p-4 shadow-card ring-2 ring-brand/70">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">Working on <Link href={myJobHref(timer.workOrderId)} className="underline">work order {timer.number}</Link></p>
        <p className="text-sm text-muted">Timer running · <span className="tabular">{clock(minutesSince(timer.startedAt, now))}</span></p>
      </div>
      <Button size="lg" variant="dark" className="min-h-12" disabled={pending} onClick={() => run(() => stopTimer())} icon={<Square className="size-4" aria-hidden />}>Stop timer</Button>
    </section>
  );
}

/** Where a job card leads: the job page on its checklist, remembering that it was opened from My jobs. */
export const myJobHref = (id: string) => `/maintenance/work-orders/${id}?tab=tasks&from=my-jobs`;

function JobHeader({ job }: { job: OpenJob }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold text-muted">{job.unit} · Work order {job.number}</p>
      <p className="mt-0.5 font-semibold text-ink">{job.title}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge tone={STATUS_TONE[job.status as WoStatus] ?? "gray"}>{WO_STATUSES[job.status as WoStatus] ?? job.status}</Badge>
        {job.safetyCritical && <Badge tone="critical-soft">Safety-critical</Badge>}
        {(job.urgency === "immediate" || job.urgency === "high") && <Badge tone={job.urgency === "immediate" ? "critical" : "amber"}>{WO_URGENCIES[job.urgency as keyof typeof WO_URGENCIES]}</Badge>}
      </div>
    </div>
  );
}

/**
 * The whole card opens the job (first-day review 2026-11-09): the title is a link stretched over the card, and the
 * buttons and fields sit above it so they keep working.
 */
function CardLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} aria-label={label} className="-m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-muted after:absolute after:inset-0 after:rounded-panel after:content-[''] hover:text-ink focus-visible:outline-2 focus-visible:outline-strong">
      <ChevronRight className="size-5" aria-hidden />
    </Link>
  );
}

/**
 * Done with a job (first-day review 2026-11-09). The lead, or the only mechanic, is asked "What did you fix?" and in the
 * same step the job goes for inspection (safety-critical: the truck stays out of service until someone authorized
 * records a passed inspection) or is completed. A helper marks their own part done and is told who finishes the job.
 */
export function FinishJob({ workOrderId, finisher, safetyCritical, unit = "truck", leadName, size = "lg", onOpenChange, suggested = "", timerNote = "", hasTruck = false, inspection = false }: {
  workOrderId: string; finisher: boolean; safetyCritical: boolean; unit?: "truck" | "trailer"; leadName: string | null;
  size?: "sm" | "lg"; onOpenChange?: (open: boolean) => void;
  /** What the person already wrote beside their timer on this job: it starts "What did you fix?" (I8). */
  suggested?: string;
  /** The note typed beside a timer that is still running: kept with that time entry when the timer stops. */
  timerNote?: string;
  /** A truck job: the odometer and engine hours can be recorded in the same step. */
  hasTruck?: boolean;
  /** An inspection job (category inspection): "What did you inspect or fix?". */
  inspection?: boolean;
}) {
  const { pending, run, start, router } = useRun();
  const [open, setOpen] = useState(false);
  const [fixed, setFixed] = useState("");
  const [odometer, setOdometer] = useState("");
  const [hours, setHours] = useState("");
  const show = (o: boolean) => {
    // No double entry (I8): the notes kept with the timer start the answer; the person reads and changes them.
    if (o && !fixed.trim() && suggested.trim()) setFixed(suggested.trim());
    setOpen(o);
    onOpenChange?.(o);
  };
  // Big enough for gloved hands on a phone (B5); the usual size from a tablet up.
  const big = size === "lg" ? "min-h-12" : "min-h-12 sm:min-h-0";
  if (!finisher) {
    return (
      <div className="flex flex-col gap-1">
        <Button size={size} variant="secondary" className={big} disabled={pending} onClick={() => run(() => finishJob({ workOrderId, timerNote }))} icon={<Check className="size-4" aria-hidden />}>My part is done</Button>
        <p className="text-xs text-muted">{leadName ? `${leadName} (lead) finishes the job.` : "The lead mechanic finishes the job."}</p>
      </div>
    );
  }
  if (!open) {
    return <Button size={size} className={big} disabled={pending} onClick={() => show(true)} icon={<Check className="size-4" aria-hidden />}>Finish the job</Button>;
  }
  const id = `fixed-${workOrderId}`;
  // A unit parked by hand whose last job this was: the toast asks to put it back in service, with the button there.
  const finish = () => start(async () => {
    const r = await finishJob({ workOrderId, findings: fixed, timerNote, odometer, engineHours: hours });
    if (!r.ok) { toast.error(r.error); return; }
    const parked = r.data?.parked;
    if (parked && r.data?.canReturn) {
      toast.success(r.message ?? "Job completed.", {
        duration: 15000,
        action: { label: "Put back in service", onClick: () => { void returnUnitAfterShop({ kind: parked.kind, id: parked.id }).then((x) => { if (x.ok) toast.success(x.message ?? "Back in service."); else toast.error(x.error); router.refresh(); }); } },
      });
    } else toast.success(r.message ?? "Saved.");
    show(false);
    router.refresh();
  });
  return (
    <form
      aria-label="Finish the job"
      className="basis-full space-y-3 rounded-xl bg-surface p-3 ring-1 ring-line/60"
      onSubmit={(e) => { e.preventDefault(); finish(); }}
    >
      <Field label={inspection ? "What did you inspect or fix?" : "What did you fix?"} htmlFor={id} required hint={suggested.trim() && fixed.trim() === suggested.trim() ? "Filled in from your timer notes. Change it if needed. Saved in the work order's Findings." : "Saved in the work order's Findings."}>
        <Textarea id={id} rows={3} maxLength={2000} value={fixed} onChange={(e) => setFixed(e.target.value)} placeholder={inspection ? "e.g. Annual inspection passed: brakes, lights, tires OK; replaced a marker light" : "e.g. Replaced the leaking rear brake chamber, checked for air leaks"} autoFocus />
      </Field>
      {hasTruck && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Odometer now (optional)" htmlFor={`odo-${workOrderId}`} hint="Miles">
            <Input id={`odo-${workOrderId}`} inputMode="numeric" value={odometer} maxLength={12} onChange={(e) => setOdometer(e.target.value)} placeholder="e.g. 184,250" />
          </Field>
          <Field label="Engine hours (optional)" htmlFor={`hrs-${workOrderId}`} hint="Hours">
            <Input id={`hrs-${workOrderId}`} inputMode="decimal" value={hours} maxLength={12} onChange={(e) => setHours(e.target.value)} placeholder="e.g. 6,120" />
          </Field>
        </div>
      )}
      <p className="text-sm text-muted">
        {safetyCritical
          ? `Safety-critical: the job then waits for an authorized inspection, and the ${unit} stays out of service until someone authorized records a passed inspection.`
          : "The job is then marked completed: the repair is done. The office closes it after checking the time, parts and costs."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size={size} className={big} loading={pending} disabled={fixed.trim().length < 3}>{safetyCritical ? "Send for inspection" : "Mark completed"}</Button>
        <Button size={size} variant="ghost" className={big} disabled={pending} onClick={() => show(false)}>Not yet</Button>
      </div>
    </form>
  );
}

/** "Waiting for parts": asks which part is missing; it is kept as the status change's note and shown on the job card. */
export function WaitForPart({ workOrderId, editSeq, size = "lg", initialPart = "", onOpenChange }: {
  workOrderId: string; editSeq: number; size?: "sm" | "lg"; initialPart?: string; onOpenChange?: (open: boolean) => void;
}) {
  const { pending, run } = useRun();
  const [open, setOpen] = useState(false);
  const [part, setPart] = useState(initialPart);
  const show = (o: boolean) => { setOpen(o); onOpenChange?.(o); };
  const big = size === "lg" ? "min-h-12" : undefined;
  if (!open) return <Button size={size} variant="secondary" className={big} disabled={pending} onClick={() => show(true)} icon={<PackageX className="size-4" aria-hidden />}>Waiting for parts</Button>;
  const id = `part-${workOrderId}`;
  return (
    <form
      aria-label="Waiting for parts"
      className="basis-full space-y-2 rounded-xl bg-surface p-3 ring-1 ring-line/60"
      onSubmit={(e) => { e.preventDefault(); run(() => waitForPart({ workOrderId, part, editSeq }), () => show(false)); }}
    >
      <Field label="Which part is missing?" htmlFor={id} required>
        <Input id={id} value={part} maxLength={300} onChange={(e) => setPart(e.target.value)} placeholder="e.g. Rear brake chamber, type 30/30" autoFocus />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size={size} variant="secondary" className={big} loading={pending} disabled={part.trim().length < 2}>Mark waiting for parts</Button>
        <Button size={size} variant="ghost" className={big} disabled={pending} onClick={() => show(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** One of my jobs: the next step that fits its state, and the whole card opens the job. */
export function MyJobCard({ job, timerHere, timerElsewhere, partsText = null }: { job: MyJob; timerHere: boolean; timerElsewhere: boolean; partsText?: string | null }) {
  const { pending, run } = useRun();
  const canStart = ["reported", "triaged", "scheduled", "awaiting_parts"].includes(job.status);
  const working = job.status === "in_progress";
  // A quick note when the timer stops (what was found or done); it is kept with the time entry on the work order.
  const [note, setNote] = useState("");
  // While the finish or parts question is open, the other buttons step aside.
  const [asking, setAsking] = useState<"finish" | "parts" | null>(null);
  const showHelperDone = working && !job.finisher && job.myStatus !== "done";
  return (
    <li className="relative rounded-panel border border-line/70 bg-card shadow-card p-4">
      <div className="flex items-start justify-between gap-3">
        <JobHeader job={job} />
        <CardLink href={myJobHref(job.id)} label={`Open work order ${job.number}: ${job.title}`} />
      </div>
      <p className="mt-2 text-sm text-muted">
        {job.myRole === "lead" ? "You lead this job" : "You are helping"}
        {job.tasksTotal > 0 && <> · Checklist {job.tasksDone} of {job.tasksTotal}</>}
        {job.scheduledFor && <> · Scheduled {formatDate(job.scheduledFor)}</>}
        {partsText && <> · <span data-testid="parts-summary">{partsText}</span></>}
      </p>
      <p className="mt-1 text-sm font-medium text-ink" data-testid="next-step">{mechanicNextStep(job, timerHere ? "here" : timerElsewhere ? "elsewhere" : "none")}</p>
      {timerHere && asking !== "finish" && (
        <label className="relative z-10 mt-3 block text-sm">
          <span className="text-muted">What you found or did (optional, saved with your time)</span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="mt-1" placeholder="e.g. Air leak at the rear brake chamber" />
        </label>
      )}
      <div className="relative z-10 mt-3 flex flex-wrap items-start gap-2">
        {canStart && !asking && (
          <Button size="lg" className="min-h-12" disabled={pending} onClick={() => run(() => startJob({ workOrderId: job.id, editSeq: job.editSeq }))} icon={<Play className="size-4" aria-hidden />}>
            {job.status === "awaiting_parts" ? "Part is in: start again" : "Start this job"}
          </Button>
        )}
        {working && !timerHere && !asking && (
          <Button size="lg" variant={job.tasksDone < job.tasksTotal || job.tasksTotal === 0 ? "primary" : "secondary"} className="min-h-12" disabled={pending || timerElsewhere} onClick={() => run(() => startTimer({ workOrderId: job.id }))} icon={<Play className="size-4" aria-hidden />}>Start timer</Button>
        )}
        {timerHere && !asking && <Button size="lg" variant="dark" className="min-h-12" disabled={pending} onClick={() => run(() => stopTimer({ note }))} icon={<Square className="size-4" aria-hidden />}>Stop timer</Button>}
        {working && job.finisher && asking !== "parts" && (
          <FinishJob workOrderId={job.id} finisher safetyCritical={job.safetyCritical} unit={job.unit.startsWith("Trailer") ? "trailer" : "truck"} leadName={job.leadName} onOpenChange={(o) => setAsking(o ? "finish" : null)}
            suggested={fixedFromNotes([...(job.myNotes ?? []), timerHere ? note : ""])} timerNote={timerHere ? note : ""} hasTruck={job.hasTruck} inspection={job.inspection} />
        )}
        {showHelperDone && !timerHere && !asking && <FinishJob workOrderId={job.id} finisher={false} safetyCritical={job.safetyCritical} leadName={job.leadName} />}
      </div>
      {/* Set apart from the main step: not every job needs it. Hidden while waiting for parts. */}
      {working && asking !== "finish" && (
        <div className="relative z-10 mt-3 flex flex-wrap gap-2 border-t border-line/70 pt-3">
          <WaitForPart workOrderId={job.id} editSeq={job.editSeq} onOpenChange={(o) => setAsking(o ? "parts" : null)} />
        </div>
      )}
    </li>
  );
}

/** An open job nobody leads yet: take it (you become the lead, the same as assigning it on the work order). */
export function OpenJobCard({ job, me }: { job: OpenJob; me: string }) {
  const { pending, run } = useRun();
  return (
    <li className="relative rounded-panel border border-line/70 bg-card shadow-card p-4">
      <div className="flex items-start justify-between gap-3">
        <JobHeader job={job} />
        <CardLink href={myJobHref(job.id)} label={`Open work order ${job.number}: ${job.title}`} />
      </div>
      <div className="relative z-10 mt-3">
        <Button size="lg" variant="secondary" className="min-h-12" disabled={pending} onClick={() => run(() => addMechanic({ workOrderId: job.id, userId: me, lead: true }))} icon={<Hand className="size-4" aria-hidden />}>Take this job</Button>
      </div>
    </li>
  );
}
