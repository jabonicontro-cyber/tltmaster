import { z } from "zod";
import { isOperationalDate, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";

export const TIME_OFF_CATEGORIES = {
  vacation: "Vacation",
  sick: "Sick",
  personal: "Personal",
  bereavement: "Bereavement",
  jury_duty: "Jury duty",
  unpaid: "Unpaid leave",
  other: "Other",
} as const;
export type TimeOffCategory = keyof typeof TIME_OFF_CATEGORIES;

export const TIME_OFF_STATUSES = { pending: "Pending", approved: "Approved", denied: "Denied", canceled: "Canceled" } as const;
export type TimeOffStatus = keyof typeof TIME_OFF_STATUSES;

export const STATUS_TONE: Record<TimeOffStatus, "amber" | "green" | "red" | "gray"> = { pending: "amber", approved: "green", denied: "red", canceled: "gray" };

const date = z.string().trim().refine(isOperationalDate, OPERATIONAL_DATE_MESSAGE);
const time = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time like 08:00.");

export const timeOffSchema = z
  .object({
    employee_id: z.string().optional().transform((v) => v?.trim() || null).pipe(z.uuid("Choose an employee.").nullable()),
    category: z.enum(Object.keys(TIME_OFF_CATEGORIES) as [TimeOffCategory, ...TimeOffCategory[]], "Choose a category."),
    start_date: date,
    end_date: z.string().optional().transform((v) => v?.trim() || ""),
    day_kind: z.enum(["full", "partial"]).default("full"),
    start_time: z.string().optional().transform((v) => v?.trim() || ""),
    end_time: z.string().optional().transform((v) => v?.trim() || ""),
    reason: z.string().trim().max(1000, "Use at most 1000 characters.").default(""),
    // Hours a full-day request uses from a PTO bank (partial days derive them from the times). Optional here: the
    // database requires them only when the category draws from a bank.
    hours: z.string().optional().transform((v) => v?.trim() || ""),
    submission_key: z.uuid().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.day_kind === "full") {
      if (v.hours && (!/^\d{1,4}(\.\d{1,2})?$/.test(v.hours) || Number(v.hours) <= 0)) ctx.addIssue({ code: "custom", path: ["hours"], message: "Enter hours like 8 or 7.5." });
      if (v.end_date && !isOperationalDate(v.end_date)) ctx.addIssue({ code: "custom", path: ["end_date"], message: OPERATIONAL_DATE_MESSAGE });
      else if (v.end_date && v.end_date < v.start_date) ctx.addIssue({ code: "custom", path: ["end_date"], message: "The last day is before the first day." });
    } else {
      if (!time.safeParse(v.start_time).success) ctx.addIssue({ code: "custom", path: ["start_time"], message: "Enter the start time." });
      if (!time.safeParse(v.end_time).success) ctx.addIssue({ code: "custom", path: ["end_time"], message: "Enter the end time." });
      else if (v.start_time && v.end_time <= v.start_time) ctx.addIssue({ code: "custom", path: ["end_time"], message: "The end time must be after the start time." });
    }
  })
  .transform((v) => ({
    employee_id: v.employee_id,
    category: v.category,
    start_date: v.start_date,
    end_date: v.day_kind === "full" ? v.end_date || v.start_date : v.start_date,
    full_day: v.day_kind === "full",
    start_time: v.day_kind === "partial" ? v.start_time : null,
    end_time: v.day_kind === "partial" ? v.end_time : null,
    reason: v.reason,
    hours: v.day_kind === "full" && v.hours ? Number(v.hours) : null,
    submission_key: v.submission_key,
  }));

/** Calendar days in a full-day request (no work schedules exist, so not working days). */
export function calendarDays(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86400_000) + 1;
}
