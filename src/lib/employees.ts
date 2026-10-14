import { z } from "zod";
import { optionalEmail, optionalPhone } from "@/lib/schemas/common";
import { isAvatarKey } from "@/lib/people/avatars";

export const DEPARTMENTS = { operations: "Operations", dispatch: "Dispatch", office: "Office", shop: "Shop / maintenance", sales: "Sales", management: "Management", other: "Other" } as const;
export const EMPLOYMENT_TYPES = { full_time: "Full-time", part_time: "Part-time", seasonal: "Seasonal", contractor: "Contractor" } as const;
export const EMPLOYEE_STATUSES = { active: "Active", on_leave: "On leave", inactive: "Inactive", terminated: "Terminated" } as const;
export const PAY_TYPES = { hourly: "Hourly", salary: "Salary (yearly)", per_load: "Per load", percentage: "Percentage of revenue", other: "Other" } as const;

export type Department = keyof typeof DEPARTMENTS;
export type EmploymentType = keyof typeof EMPLOYMENT_TYPES;
export type EmployeeStatus = keyof typeof EMPLOYEE_STATUSES;
export type PayType = keyof typeof PAY_TYPES;

const keys = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
const optionalDate = z.string().trim().regex(/^(\d{4}-\d{2}-\d{2})?$/, "Enter a valid date.").transform((v) => v || null);

export const employeeSchema = z
  .object({
    full_name: z.string().trim().min(1, "Enter the person's name.").max(120, "Use at most 120 characters."),
    job_title: z.string().trim().max(80, "Use at most 80 characters."),
    department: z.enum(keys(DEPARTMENTS)),
    employment_type: z.enum(keys(EMPLOYMENT_TYPES)),
    status: z.enum(keys(EMPLOYEE_STATUSES)),
    hire_date: optionalDate,
    end_date: optionalDate,
    work_email: optionalEmail,
    work_phone: optionalPhone,
    emergency_contact_name: z.string().trim().max(120, "Use at most 120 characters."),
    emergency_contact_phone: optionalPhone,
    notes: z.string().trim().max(4000, "Use at most 4000 characters."),
    avatar_key: z.string().trim().default("").refine((v) => v === "" || isAvatarKey(v), "Choose one of the avatars."),
  })
  .superRefine((v, ctx) => {
    if (v.status === "terminated" && !v.end_date) ctx.addIssue({ code: "custom", path: ["end_date"], message: "Enter the last day of employment." });
    if (v.end_date && v.hire_date && v.end_date < v.hire_date) ctx.addIssue({ code: "custom", path: ["end_date"], message: "The end date is before the hire date." });
  });

export type EmployeeInput = z.infer<typeof employeeSchema>;

/** Money as entered ("28.75", "$1,250") → cents; null when empty. */
const money = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const clean = v.replace(/[$,\s]/g, "");
    if (!clean) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(clean)) {
      ctx.addIssue({ code: "custom", message: "Enter an amount like 28.75." });
      return z.NEVER;
    }
    return Math.round(Number(clean) * 100);
  });

export const compensationSchema = z
  .object({
    pay_type: z.enum(keys(PAY_TYPES)),
    rate: money,
    rate_percent: z.string().trim().transform((v, ctx) => {
      if (!v) return null;
      const n = Number(v.replace("%", ""));
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        ctx.addIssue({ code: "custom", message: "Enter a percentage between 0 and 100." });
        return z.NEVER;
      }
      return n;
    }),
    effective_date: optionalDate,
    notes: z.string().trim().max(2000, "Use at most 2000 characters."),
  })
  .superRefine((v, ctx) => {
    if (v.pay_type === "percentage" && v.rate_percent === null) ctx.addIssue({ code: "custom", path: ["rate_percent"], message: "Enter the percentage." });
    if (v.pay_type !== "percentage" && v.rate === null) ctx.addIssue({ code: "custom", path: ["rate"], message: "Enter the rate." });
  });

/** Display a rate for people allowed to see it. */
export function formatPay(c: { pay_type: PayType; rate_cents: number | null; rate_percent: number | null }): string {
  if (c.pay_type === "percentage") return `${c.rate_percent ?? "—"}% of revenue`;
  const amount = c.rate_cents === null ? "—" : (c.rate_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const unit = { hourly: " / hour", salary: " / year", per_load: " / load", other: "" }[c.pay_type];
  return `${amount}${unit}`;
}

/** Weekly work schedule: hours per weekday (0–24, quarter hours). Used for full-day time off. */
export const WEEKDAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]] as const;
const dayHours = z.string().trim().transform((v, ctx) => {
  if (v === "") return 0;
  const n = Number(v);
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(v) || n < 0 || n > 24) {
    ctx.addIssue({ code: "custom", message: "0–24 hours." });
    return z.NEVER;
  }
  return n;
});
export const workScheduleSchema = z.object(Object.fromEntries(WEEKDAYS.map(([d]) => [`${d}_hours`, dayHours])) as Record<`${(typeof WEEKDAYS)[number][0]}_hours`, typeof dayHours>);
