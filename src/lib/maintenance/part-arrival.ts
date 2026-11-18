// A shop job scheduled before its ordered part arrives (owner decision 2026-11-16/17, WK3: warn and offer to move it;
// the person decides, nothing moves on its own). Pure: shared by the work order page, the Maintenance overview, Shop
// capacity, My jobs and the move action, which checks the same rule again on the server right before it moves the job.
import { formatDate } from "@/lib/dates";

export interface ArrivalJob {
  id: string;
  status: string;
  scheduled_for: string | null;
}

export interface ArrivalPart {
  work_order_id: string;
  description: string;
  expected_on: string | null;
  status: string;
}

export interface PartArrivalConflict {
  workOrderId: string;
  scheduledFor: string;
  /** The day the last part still on order is expected (null when a part has no expected date). */
  arrivesOn: string | null;
  /** Parts expected after the scheduled day, or without an expected date. */
  parts: string[];
  /** The date to offer: the arrival day, never before today (the database refuses a past date). */
  moveTo: string | null;
}

/** Jobs that have not started yet: a date still matters for them. */
const NOT_STARTED = new Set(["reported", "triaged", "scheduled", "awaiting_parts"]);

/**
 * Whether the job is scheduled before a part it waits for is expected. Only parts still on order count. A part with a
 * later expected date gives a move offer to that date; a part with no expected date only gives a warning to check it.
 */
export function partArrivalConflict(job: ArrivalJob, parts: ReadonlyArray<ArrivalPart>, today: string): PartArrivalConflict | null {
  if (!job.scheduled_for || !NOT_STARTED.has(job.status)) return null;
  const waiting = parts.filter((p) => p.work_order_id === job.id && p.status === "waiting");
  if (!waiting.length) return null;
  const late = waiting.filter((p) => p.expected_on && p.expected_on > job.scheduled_for!);
  if (late.length) {
    const arrivesOn = late.map((p) => p.expected_on!).sort().at(-1)!;
    return { workOrderId: job.id, scheduledFor: job.scheduled_for, arrivesOn, parts: late.map((p) => p.description), moveTo: arrivesOn < today ? today : arrivesOn };
  }
  const undated = waiting.filter((p) => !p.expected_on);
  if (undated.length) return { workOrderId: job.id, scheduledFor: job.scheduled_for, arrivesOn: null, parts: undated.map((p) => p.description), moveTo: null };
  return null;
}

/** Every conflict among the jobs, keyed by work order. */
export function partArrivalConflicts(jobs: ReadonlyArray<ArrivalJob>, parts: ReadonlyArray<ArrivalPart>, today: string): Map<string, PartArrivalConflict> {
  const out = new Map<string, PartArrivalConflict>();
  for (const j of jobs) {
    const c = partArrivalConflict(j, parts, today);
    if (c) out.set(j.id, c);
  }
  return out;
}

const partName = (parts: string[]) => (parts.length === 1 ? parts[0] : `${parts.length} parts`);

/** "Scheduled Nov 18, but DEF level sensor is expected Nov 20." / "… but DEF level sensor has no expected date yet." */
export function partArrivalText(c: PartArrivalConflict): string {
  const verb = c.parts.length === 1 ? "is" : "are";
  if (!c.arrivesOn) return `Scheduled ${formatDate(c.scheduledFor)}, but ${partName(c.parts)} on order ${c.parts.length === 1 ? "has" : "have"} no expected date yet. Check it arrives in time.`;
  return `Scheduled ${formatDate(c.scheduledFor)}, but ${partName(c.parts)} ${verb} expected ${formatDate(c.arrivesOn)}.`;
}

/** "Move to Nov 20" */
export function moveLabel(c: PartArrivalConflict): string | null {
  return c.moveTo ? `Move to ${formatDate(c.moveTo)}` : null;
}
