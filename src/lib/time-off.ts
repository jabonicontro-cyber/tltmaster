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

// Request form preview (driver view): how many hours a request uses before it is sent. The database computes the real
// figure (time_off_save: the work schedule's hours for full days, the times for part of a day) and checks the balance.

/** An employee's weekly work schedule: hours per weekday (employee_work_schedules). */
export type WeekHours = { mon_hours: number | string; tue_hours: number | string; wed_hours: number | string; thu_hours: number | string; fri_hours: number | string; sat_hours: number | string; sun_hours: number | string };

const WEEKDAYS = [["sun_hours", "Sun"], ["mon_hours", "Mon"], ["tue_hours", "Tue"], ["wed_hours", "Wed"], ["thu_hours", "Thu"], ["fri_hours", "Fri"], ["sat_hours", "Sat"]] as const;

/** The scheduled hours of every day from start to end (inclusive), as the database adds them up; null for bad dates. */
export function scheduledHours(w: WeekHours, start: string, end: string): number | null {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end || start}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a || (b.getTime() - a.getTime()) / 86400_000 > 366) return null;
  let total = 0;
  for (const d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) total += Number(w[WEEKDAYS[d.getUTCDay()][0]]) || 0;
  return total;
}

/** "8 h on Mon, Tue, Wed, Thu, Fri" (or "Mon 8 h, Sat 4 h" when days differ); null when no day has hours. */
export function scheduleSummary(w: WeekHours): string | null {
  const days = [...WEEKDAYS.slice(1), WEEKDAYS[0]].map(([k, label]) => ({ label, h: Number(w[k]) || 0 })).filter((d) => d.h > 0);
  if (!days.length) return null;
  if (days.every((d) => d.h === days[0].h)) return `${hoursShort(days[0].h)} on ${days.map((d) => d.label).join(", ")}`;
  return days.map((d) => `${d.label} ${hoursShort(d.h)}`).join(", ");
}

/** Hours for people: whole or one decimal ("52.3 h", "8 h"), never "52.32 h". A balance rounds down, never up. */
export const hoursShort = (h: number, down = false) => `${down ? Math.floor(h * 10 + 1e-9) / 10 : Number(h.toFixed(1))} h`;

/** Hours between two "HH:MM" times on one day; null unless the end is after the start. */
export function hoursBetween(start: string, end: string): number | null {
  const m = (t: string) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : NaN);
  const d = m(end) - m(start);
  return Number.isFinite(d) && d > 0 ? Math.round((d / 60) * 100) / 100 : null;
}

/** "Uses 8 h of your 52.3 h Paid time off." (or that it is more than is available); null when the hours are not known yet. */
export function usesText(hours: number | null, available: number | null, bank: string): string | null {
  if (hours === null || !(hours > 0)) return null;
  if (available === null) return `Uses ${hoursShort(hours)} of ${bank}.`;
  if (hours > available) return `Uses ${hoursShort(hours)}, but only ${hoursShort(Math.max(available, 0), true)} of your ${bank} are available.`;
  return `Uses ${hoursShort(hours)} of your ${hoursShort(available, true)} ${bank}.`;
}
