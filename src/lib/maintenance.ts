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

export const workOrderSchema = z.object({
  truck_id: z.uuid("Choose a truck."),
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
export type WorkOrderInput = z.infer<typeof workOrderSchema>;

export const workOrderEditSchema = workOrderSchema.omit({ truck_id: true, field_report_id: true, submission_key: true }).extend({
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
        reasons.unshift("Safety-critical defect — truck restricted until cleared");
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
