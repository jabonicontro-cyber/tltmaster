import { z } from "zod";
import { isOperationalDate, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";

// Mechanics & Maintenance: labels, validation and the rule-based shop priority.
// The lifecycle itself is enforced by the database (maintenance_set_status);
// NEXT_STATUSES only decides which buttons to show.

export const WO_STATUSES = {
  reported: "Reported",
  triaged: "Triaged",
  scheduled: "Scheduled",
  in_progress: "In progress",
  awaiting_parts: "Awaiting parts",
  awaiting_inspection: "Awaiting inspection",
  completed: "Completed",
  closed: "Closed",
  canceled: "Canceled",
} as const;
export type WoStatus = keyof typeof WO_STATUSES;

export const WO_CATEGORIES = {
  repair: "Repair",
  preventive: "Preventive maintenance",
  inspection: "Inspection",
  brakes: "Brakes",
  tires: "Tires",
  engine: "Engine",
  electrical: "Electrical",
  hydraulics: "Hydraulics",
  body: "Body / bed",
  other: "Other",
} as const;
export type WoCategory = keyof typeof WO_CATEGORIES;

export const WO_URGENCIES = { immediate: "Immediate", high: "High", normal: "Normal", low: "Low" } as const;
export type WoUrgency = keyof typeof WO_URGENCIES;

export const CLEARANCE_STATUSES = {
  awaiting: "Awaiting inspection",
  in_progress: "Inspection in progress",
  failed: "Failed inspection",
  cleared: "Cleared for service",
} as const;
export type ClearanceStatus = keyof typeof CLEARANCE_STATUSES;

export const COST_KINDS = { part: "Part", labor: "Labor", vendor: "Outside vendor", other: "Other" } as const;
export type CostKind = keyof typeof COST_KINDS;

export const OPEN_STATUSES: WoStatus[] = ["reported", "triaged", "scheduled", "in_progress", "awaiting_parts", "awaiting_inspection"];

/** Mirrors private.wo_transition_ok (the database decides; this only picks buttons). */
export const NEXT_STATUSES: Record<WoStatus, WoStatus[]> = {
  reported: ["triaged", "scheduled", "in_progress", "canceled"],
  triaged: ["scheduled", "in_progress", "canceled"],
  scheduled: ["in_progress", "triaged", "canceled"],
  in_progress: ["awaiting_parts", "awaiting_inspection", "completed", "scheduled", "canceled"],
  awaiting_parts: ["in_progress", "scheduled", "canceled"],
  awaiting_inspection: [],
  completed: ["closed", "in_progress"],
  closed: [],
  canceled: [],
};

/** Which next statuses this work order may take, with the safety rule applied. */
export function nextStatuses(status: WoStatus, safetyCritical: boolean): WoStatus[] {
  return NEXT_STATUSES[status].filter((s) => !(safetyCritical && s === "completed"));
}

export const STATUS_ACTION_LABELS: Partial<Record<WoStatus, string>> = {
  triaged: "Mark triaged",
  scheduled: "Mark scheduled",
  in_progress: "Start work",
  awaiting_parts: "Waiting for parts",
  awaiting_inspection: "Send for inspection",
  completed: "Mark completed",
  closed: "Close",
  canceled: "Cancel work order",
};

export const STATUS_TONE: Record<WoStatus, "gray" | "blue" | "green" | "amber" | "red" | "dark"> = {
  reported: "amber",
  triaged: "blue",
  scheduled: "blue",
  in_progress: "dark",
  awaiting_parts: "amber",
  awaiting_inspection: "amber",
  completed: "green",
  closed: "gray",
  canceled: "gray",
};

export const PM_STATES = { overdue: "Overdue", due_soon: "Due soon", ok: "OK", unknown: "Not enough data" } as const;
export type PmState = keyof typeof PM_STATES;

const keys = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
// Optional form fields: missing or empty → null.
const optionalUuid = z.string().optional().transform((v) => v?.trim() || null).pipe(z.uuid("Invalid selection.").nullable());
const optionalDate = z.string().optional().transform((v) => v?.trim() || null)
  .refine((v) => v === null || isOperationalDate(v), OPERATIONAL_DATE_MESSAGE);
const optionalNumber = (max: number, label: string) =>
  z.string().optional().transform((v, ctx) => {
    const clean = (v ?? "").replace(/[,\s]/g, "");
    if (!clean) return null;
    const n = Number(clean);
    if (!Number.isFinite(n) || n < 0 || n > max) {
      ctx.addIssue({ code: "custom", message: `Enter ${label} between 0 and ${max.toLocaleString("en-US")}.` });
      return z.NEVER;
    }
    return n;
  });

const workOrderFields = z.object({
  // Exactly one: a work order belongs to one truck or one trailer.
  truck_id: optionalUuid,
  trailer_id: optionalUuid,
  title: z.string().trim().min(3, "Describe the job in a few words.").max(120, "Use at most 120 characters."),
  description: z.string().trim().max(4000, "Use at most 4000 characters.").default(""),
  category: z.enum(keys(WO_CATEGORIES)),
  urgency: z.enum(keys(WO_URGENCIES)),
  safety_critical: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
  driver_id: optionalUuid,
  assigned_to: optionalUuid,
  scheduled_for: optionalDate,
  due_on: optionalDate,
  field_report_id: optionalUuid,
  submission_key: z.uuid().optional(),
});
export const workOrderSchema = workOrderFields.superRefine((v, ctx) => {
  if (v.truck_id && v.trailer_id) ctx.addIssue({ code: "custom", path: ["trailer_id"], message: "Choose either a truck or a trailer, not both." });
  else if (!v.truck_id && !v.trailer_id) ctx.addIssue({ code: "custom", path: ["unit"], message: "Choose a truck or a trailer." });
});
export type WorkOrderInput = z.infer<typeof workOrderSchema>;

export const workOrderEditSchema = workOrderFields.omit({ truck_id: true, trailer_id: true, field_report_id: true, submission_key: true }).extend({
  findings: z.string().trim().max(4000, "Use at most 4000 characters.").default(""),
  labor_hours: optionalNumber(10000, "hours"),
  odometer_at_service: optionalNumber(9999999, "miles"),
  engine_hours_at_service: optionalNumber(999999, "hours"),
  edit_seq: z.coerce.number().int(),
});

export const scheduleSchema = z
  .object({
    id: optionalUuid,
    truck_id: z.uuid("Choose a truck."),
    name: z.string().trim().min(1, "Name the service, for example \"Oil and filter\".").max(80, "Use at most 80 characters."),
    interval_days: optionalNumber(3650, "days"),
    interval_miles: optionalNumber(1000000, "miles"),
    interval_hours: optionalNumber(100000, "hours"),
    warn_days: optionalNumber(365, "days"),
    warn_miles: optionalNumber(100000, "miles"),
    warn_hours: optionalNumber(10000, "hours"),
    last_done_on: optionalDate,
    last_done_miles: optionalNumber(9999999, "miles"),
    last_done_hours: optionalNumber(999999, "hours"),
    notes: z.string().trim().max(1000, "Use at most 1000 characters.").default(""),
  })
  .superRefine((v, ctx) => {
    if (v.interval_days === null && v.interval_miles === null && v.interval_hours === null)
      ctx.addIssue({ code: "custom", path: ["interval_days"], message: "Enter at least one interval: days, miles or engine hours." });
    if (v.interval_days !== null && !Number.isInteger(v.interval_days))
      ctx.addIssue({ code: "custom", path: ["interval_days"], message: "Enter whole days." });
  });

export const readingSchema = z
  .object({
    truck_id: z.uuid("Choose a truck."),
    odometer_miles: optionalNumber(9999999, "miles"),
    engine_hours: optionalNumber(999999, "hours"),
    note: z.string().trim().max(300, "Use at most 300 characters.").default(""),
  })
  .refine((v) => v.odometer_miles !== null || v.engine_hours !== null, { path: ["odometer_miles"], message: "Enter the odometer, the engine hours, or both." });

export const costSchema = z.object({
  kind: z.enum(keys(COST_KINDS)),
  description: z.string().trim().min(1, "Describe the part or work.").max(200, "Use at most 200 characters."),
  part_number: z.string().trim().max(60, "Use at most 60 characters.").default(""),
  vendor_name: z.string().trim().max(120, "Use at most 120 characters.").default(""),
  quantity: z.string().trim().transform((v, ctx) => {
    const n = Number(v.replace(/[,\s]/g, "") || "1");
    if (!Number.isFinite(n) || n <= 0 || n > 100000) {
      ctx.addIssue({ code: "custom", message: "Enter a quantity greater than 0." });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  }),
  unit_cost: z.string().trim().transform((v, ctx) => {
    const clean = v.replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(clean)) {
      ctx.addIssue({ code: "custom", message: "Enter an amount like 41.50." });
      return z.NEVER;
    }
    return Math.round(Number(clean) * 100);
  }),
});

// -----------------------------------------------------------------------------
// Shop priority: plain, explainable rules (not AI). Suggests an order; it never
// assigns, schedules or changes anything.
// -----------------------------------------------------------------------------
export interface PriorityInput {
  id: string;
  status: WoStatus;
  urgency: WoUrgency;
  safety_critical: boolean;
  due_on: string | null;
  scheduled_for: string | null;
  created_at: string;
  truck_out_of_service: boolean;
  /** The truck is someone's primary truck (a driver is waiting on it). */
  truck_has_driver: boolean;
}

export interface Ranked<T> {
  item: T;
  score: number;
  reasons: string[];
}

const URGENCY_POINTS: Record<WoUrgency, number> = { immediate: 60, high: 30, normal: 10, low: 0 };

export function rankWorkOrders<T extends PriorityInput>(items: T[], today: string): Ranked<T>[] {
  return items
    .filter((w) => OPEN_STATUSES.includes(w.status))
    .map((w) => {
      let score = URGENCY_POINTS[w.urgency];
      const reasons: string[] = [`${WO_URGENCIES[w.urgency]} urgency`];
      if (w.safety_critical) {
        score += 100;
        reasons.unshift("Safety-critical defect: truck restricted until cleared");
      }
      if (w.status === "awaiting_inspection") {
        score += 20;
        reasons.push("Repair done; waiting for an inspector");
      }
      if (w.truck_out_of_service) {
        score += 15;
        reasons.push("Truck is out of service (downtime)");
      }
      if (w.truck_has_driver) {
        score += 5;
        reasons.push("A driver's primary truck");
      }
      if (w.due_on && w.due_on < today) {
        score += 25;
        reasons.push(`Past its due date (${w.due_on})`);
      } else if (w.due_on && w.due_on === today) {
        score += 15;
        reasons.push("Due today");
      }
      if (w.status === "awaiting_parts") {
        score -= 20;
        reasons.push("Blocked: waiting for parts");
      }
      return { item: w, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.item.created_at.localeCompare(b.item.created_at));
}

/** "Truck 12" or "Trailer T-4" for a work order; "—" when the unit is not visible. */
export function workOrderUnit(
  w: { truck_id: string | null; trailer_id?: string | null },
  trucks: Map<string, string>,
  trailers: Map<string, string>,
): string {
  if (w.trailer_id) return `Trailer ${trailers.get(w.trailer_id) ?? "–"}`;
  return `Truck ${(w.truck_id && trucks.get(w.truck_id)) ?? "–"}`;
}

/** A mechanic's job as the card and the next-step line see it. */
export interface MechanicJobState {
  status: string;
  tasksDone: number;
  tasksTotal: number;
  /** Lead, or the only mechanic on the job: they finish it (say what was fixed, then inspection or completed). */
  finisher?: boolean;
  /** The person's own crew status on the job. */
  myStatus?: string;
  safetyCritical?: boolean;
  /** The part the job is waiting for, when someone said which. */
  missingPart?: string | null;
  /** Who finishes the job when the person is a helper. */
  leadName?: string | null;
}

/** Whether this person finishes the job: the lead, the only mechanic on it, or anyone on a crew without a lead. */
export function finishesJob(myRole: "lead" | "assist", crewSize: number, crewHasLead = true): boolean {
  return myRole === "lead" || crewSize <= 1 || !crewHasLead;
}

/**
 * Where a finished job goes next: a safety-critical job always waits for an authorized inspection (the database
 * refuses to complete it directly); any other job is completed.
 */
export function finishTarget(safetyCritical: boolean): "awaiting_inspection" | "completed" {
  return safetyCritical ? "awaiting_inspection" : "completed";
}

/**
 * The next step on a mechanic's job card, in plain words (UX14, owner walkthrough 2026-11-04; first-day review
 * 2026-11-09). It follows the real state: a running timer, the checklist, who finishes the job and what is missing.
 * Matches the buttons the card shows for the same state.
 */
export function mechanicNextStep(job: MechanicJobState, timer: "here" | "elsewhere" | "none"): string {
  const left = Math.max(job.tasksTotal - job.tasksDone, 0);
  const named = job.leadName?.trim();
  const lead = named || "The lead mechanic";
  const leadMid = named || "the lead mechanic";
  if (job.status === "awaiting_parts") {
    const part = job.missingPart?.trim();
    return part ? `Waiting for parts: ${part}. Start the job again when it is in.` : "Waiting for parts. Start the job again when they are in.";
  }
  if (job.status === "awaiting_inspection") return "Waiting for an authorized inspection before the job can be completed.";
  if (job.status !== "in_progress") return "Next: tap Start this job when you begin work. Your timer starts with it.";
  if (timer === "here") {
    return left > 0
      ? `Your timer is running. Work through the checklist (${left} left). Stop the timer when you take a break.`
      : job.finisher
        ? "Your timer is running. When the repair is done, tap Finish the job and say what you fixed."
        : "Your timer is running. Stop the timer when you take a break or your part is done.";
  }
  if (timer === "elsewhere") return "Your timer is running on another job. Stop it there before you work on this one.";
  if (!job.finisher && job.myStatus === "done") return `Your part is done. ${lead} finishes the job.`;
  if (left > 0) return `Next: start your timer and work through the checklist (${left} left).`;
  if (job.finisher) {
    return job.tasksTotal > 0
      ? `Finish the job: say what you fixed.${job.safetyCritical ? " It then waits for an authorized inspection." : ""}`
      : `Start your timer while you work. When the repair is done, finish the job: say what you fixed.${job.safetyCritical ? " It then waits for an authorized inspection." : ""}`;
  }
  return job.tasksTotal > 0
    ? `Checklist done. Tap My part is done; ${leadMid} finishes the job.`
    : `Start your timer while you work. When your part is finished, tap My part is done; ${leadMid} finishes the job.`;
}

/**
 * What the finisher wrote ("What did you fix?") added to the work order's Findings, keeping what was already there.
 * Null when the text is already in the findings (a retry after a lost response adds nothing twice).
 */
export function appendFindings(existing: string | null | undefined, added: string, max = 4000): string | null {
  const add = added.trim();
  const before = (existing ?? "").trim();
  if (!add || before.includes(add)) return null;
  return (before ? `${before}\n${add}` : add).slice(0, max);
}

/** "Only 2 kit on hand." from the database (part_use): the amount and unit, so the form can offer the next step. */
export function shortStock(message: string | null | undefined): { onHand: number; unit: string } | null {
  const m = /^Only ([\d.]+) (.*?) on hand\.?$/.exec((message ?? "").trim());
  return m ? { onHand: Number(m[1]), unit: m[2] } : null;
}

/**
 * What "Start this job" / "Start work" says afterwards (one start rule, I1): the job is in progress, whether the person
 * became the lead (a job nobody led), and whether their timer runs. The job is started even when the timer cannot be.
 */
export function startJobMessage({ lead, timerError }: { lead: "set" | "failed" | "kept"; timerError: string | null }): string {
  const parts = ["Job started."];
  if (lead === "set") parts.push("You are the lead mechanic.");
  if (lead === "failed") parts.push("Nobody leads it yet: assign a lead on the Labor tab.");
  parts.push(timerError ? `Your timer did not start: ${timerError}` : "Your timer is running.");
  return parts.join(" ");
}

const URGENCY_ORDER: Record<string, number> = { immediate: 0, high: 1, normal: 2, low: 3 };

/**
 * The order a mechanic sees jobs in (B2): safety-critical first, then urgency (Immediate, High, Normal, Low), then the
 * oldest first so nothing reported waits forever; the work order number breaks ties.
 */
export function compareMechanicJobs(
  a: { safetyCritical: boolean; urgency: string; createdAt: string; number: string },
  b: { safetyCritical: boolean; urgency: string; createdAt: string; number: string },
): number {
  return (Number(b.safetyCritical) - Number(a.safetyCritical))
    || ((URGENCY_ORDER[a.urgency] ?? 4) - (URGENCY_ORDER[b.urgency] ?? 4))
    || a.createdAt.localeCompare(b.createdAt)
    || a.number.localeCompare(b.number);
}

/**
 * "What did you fix?" starts from what the person already wrote beside their timer on this job (I8, no double entry):
 * each note once, oldest first, one per line. They still read it and change it before finishing.
 */
export function fixedFromNotes(notes: ReadonlyArray<string | null | undefined>, max = 2000): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of notes) {
    const t = (n ?? "").trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.join("\n").slice(0, max);
}

/** Completed and Closed side by side, in plain words (I8). */
export const COMPLETED_VS_CLOSED = "Completed means the repair is done. Closed means the office has checked the time, parts and costs: a closed work order can no longer be changed.";

/**
 * The reason a truck or trailer is out of service, as it stands now (I3). The stored reason names the work order that
 * took the unit out of service and is not rewritten when that one is cleared while another safety-critical work order
 * still holds the unit. When the stored reason names a work order that is no longer open, the open safety-critical
 * work orders on the unit are named instead. A reason typed by a person (no work order in it) is shown as it is.
 */
export function currentRestrictionReason(stored: string, openSafety: ReadonlyArray<{ number: string; title: string }>): string {
  const named = [...stored.matchAll(/work orders? ([A-Z]{1,5}-\d+)/gi)].map((m) => m[1]);
  if (!named.length || !openSafety.length) return stored;
  const open = new Set(openSafety.map((w) => w.number));
  if (named.every((n) => open.has(n)) && named.length === openSafety.length) return stored;
  return openSafety.length === 1
    ? `Safety-critical defect, work order ${openSafety[0].number}: ${openSafety[0].title}`
    : `Safety-critical defects, work orders ${openSafety.map((w) => w.number).join(", ")}`;
}
