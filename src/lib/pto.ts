import { z } from "zod";
import { isOperationalDate, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";
import { TIME_OFF_CATEGORIES, type TimeOffCategory } from "@/lib/time-off";

// PTO banks and balances (migration 20261112000100). Every rule — eligibility, waiting periods, available balance,
// append-only history, permissions — is enforced by the database; these schemas validate input for the forms.

export const EMPLOYMENT_TYPES = { full_time: "Full-time", part_time: "Part-time", seasonal: "Seasonal", contractor: "Contractor" } as const;
export type EmploymentType = keyof typeof EMPLOYMENT_TYPES;

export const LEDGER_KINDS = { grant: "Grant", adjustment: "Adjustment", usage: "Used", usage_reversal: "Returned (canceled)", accrual: "Accrued", forfeiture: "Forfeited (plan year)" } as const;
export type LedgerKind = keyof typeof LEDGER_KINDS;

export interface PtoBank {
  id: string;
  name: string;
  categories: TimeOffCategory[];
  employment_types: EmploymentType[];
  waiting_days: number;
  active: boolean;
}

export interface PtoBalance {
  bank_id: string;
  name: string;
  categories: TimeOffCategory[];
  balance: number;
  pending: number;
  available: number;
  eligible: boolean;
  usable_from: string | null;
  waiting_days: number;
  hire_date_missing: boolean;
}

/** Hours with at most two decimals, without trailing zeros ("8", "7.5"). */
export const formatHours = (h: number) => `${Number(h.toFixed(2))} h`;

/** Which bank (if any) a category draws from. */
export function bankForCategory(banks: PtoBank[], category: string): PtoBank | null {
  return banks.find((b) => b.active && (b.categories as string[]).includes(category)) ?? null;
}

const categoryKeys = Object.keys(TIME_OFF_CATEGORIES) as [TimeOffCategory, ...TimeOffCategory[]];
const typeKeys = Object.keys(EMPLOYMENT_TYPES) as [EmploymentType, ...EmploymentType[]];

export const bankSchema = z.object({
  id: z.string().optional().transform((v) => v?.trim() || undefined).pipe(z.uuid().optional()),
  name: z.string().trim().min(1, "Enter a bank name.").max(60, "Use at most 60 characters."),
  categories: z.array(z.enum(categoryKeys)).min(1, "Choose at least one kind of time off."),
  employment_types: z.array(z.enum(typeKeys)).min(1, "Choose who can use this bank."),
  waiting_days: z.coerce.number({ message: "Enter a number of days." }).int("Whole days only.").min(0, "0 or more days.").max(730, "At most 730 days."),
  active: z.boolean().default(true),
});

const hours = z
  .string()
  .trim()
  .regex(/^-?\d{1,5}(\.\d{1,2})?$/, "Enter hours like 8 or 7.5.")
  .transform(Number)
  .refine((n) => n !== 0, "Enter hours other than zero.");

export const adjustSchema = z
  .object({
    employee_id: z.uuid("Choose an employee."),
    bank_id: z.uuid("Choose a bank."),
    kind: z.enum(["grant", "adjustment"], "Choose a grant or an adjustment."),
    hours,
    effective_on: z.string().trim().refine((v) => !v || isOperationalDate(v), OPERATIONAL_DATE_MESSAGE).default(""),
    note: z.string().trim().max(500, "Use at most 500 characters.").default(""),
    submission_key: z.uuid().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "grant" && v.hours < 0) ctx.addIssue({ code: "custom", path: ["hours"], message: "A grant adds hours; use an adjustment to remove hours." });
    if (v.kind === "adjustment" && v.note.length < 3) ctx.addIssue({ code: "custom", path: ["note"], message: "Say why the balance is adjusted." });
  })
  .transform((v) => ({ ...v, effective_on: v.effective_on || null }));

export const ACCRUAL_METHODS = { annual_grant: "Annual grant", hours_worked: "Per hours worked", per_pay_period: "Per pay period" } as const;
export type AccrualMethod = keyof typeof ACCRUAL_METHODS;
export const PAY_PERIODS = { weekly: "Weekly", biweekly: "Every two weeks", semimonthly: "Twice a month (1st and 16th)", monthly: "Monthly" } as const;

export interface PtoPolicy {
  id: string;
  bank_id: string;
  employment_type: EmploymentType;
  method: AccrualMethod;
  amount: number;
  per_hours: number | null;
  grant_month: number | null;
  grant_day: number | null;
  pay_period: keyof typeof PAY_PERIODS | null;
  anchor_date: string | null;
  max_balance: number | null;
  plan_year_month: number;
  plan_year_day: number;
  carryover_cap: number | null;
  forfeiture_reviewed: boolean;
  effective_from: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** One line describing how a policy earns hours, from its stored values only. */
export function describePolicy(p: PtoPolicy): string {
  const h = (n: number) => `${Number(n.toFixed(2))} h`;
  const how = p.method === "annual_grant"
    ? `${h(p.amount)} each year on ${MONTHS[(p.grant_month ?? 1) - 1]} ${p.grant_day}`
    : p.method === "hours_worked"
      ? `${h(p.amount)} per ${h(p.per_hours ?? 0)} worked`
      : `${h(p.amount)} per ${PAY_PERIODS[p.pay_period ?? "weekly"].toLowerCase()} pay period`;
  const cap = p.max_balance !== null ? `; balance capped at ${h(p.max_balance)}` : "";
  const carry = p.carryover_cap === null ? "; unlimited carryover" : p.carryover_cap === 0 ? "; use it or lose it at the plan-year start" : `; carryover capped at ${h(p.carryover_cap)}`;
  return how + cap + carry;
}

const optNum = (max: number) => z.string().optional().transform((v) => v?.trim() || "").refine((v) => v === "" || (/^\d{1,4}(\.\d{1,2})?$/.test(v) && Number(v) <= max), "Enter a number like 8 or 7.5.");

export const policySchema = z
  .object({
    bank_id: z.uuid("Choose a bank."),
    employment_type: z.enum(Object.keys(EMPLOYMENT_TYPES) as [EmploymentType, ...EmploymentType[]], "Choose an employment type."),
    method: z.enum(Object.keys(ACCRUAL_METHODS) as [AccrualMethod, ...AccrualMethod[]], "Choose how hours are earned."),
    amount: z.string().trim().regex(/^\d{1,4}(\.\d{1,2})?$/, "Enter hours like 8 or 3.08.").refine((v) => Number(v) > 0 && Number(v) <= 2000, "Enter more than 0 hours."),
    per_hours: optNum(2000),
    grant_month: z.string().optional().default(""),
    grant_day: z.string().optional().default(""),
    pay_period: z.string().optional().default(""),
    anchor_date: z.string().trim().optional().default("").refine((v) => !v || isOperationalDate(v), OPERATIONAL_DATE_MESSAGE),
    max_balance: optNum(10000),
    plan_year_month: z.string().optional().default("1"),
    plan_year_day: z.string().optional().default("1"),
    carryover: z.enum(["unlimited", "capped"]).default("unlimited"),
    carryover_cap: optNum(10000),
    forfeiture_reviewed: z.string().optional().transform((v) => v === "on" || v === "true"),
    effective_from: z.string().trim().optional().default("").refine((v) => !v || isOperationalDate(v), OPERATIONAL_DATE_MESSAGE),
  })
  .superRefine((v, ctx) => {
    if (v.method === "hours_worked" && !v.per_hours) ctx.addIssue({ code: "custom", path: ["per_hours"], message: "Enter the hours worked that earn the amount." });
    if (v.method === "annual_grant" && (!v.grant_month || !v.grant_day)) ctx.addIssue({ code: "custom", path: ["grant_month"], message: "Choose the grant date." });
    if (v.method === "per_pay_period" && (!v.pay_period || !v.anchor_date)) ctx.addIssue({ code: "custom", path: ["anchor_date"], message: "Choose the pay period and the first day of a period." });
    if (v.carryover === "capped" && v.carryover_cap === "") ctx.addIssue({ code: "custom", path: ["carryover_cap"], message: "Enter the hours that carry over (0 = use it or lose it)." });
    if (v.carryover === "capped" && !v.forfeiture_reviewed) ctx.addIssue({ code: "custom", path: ["forfeiture_reviewed"], message: "Confirm the rule was reviewed for where your employees work." });
  })
  .transform((v) => ({
    ...v,
    carryover_cap: v.carryover === "capped" ? v.carryover_cap : "",
    forfeiture_reviewed: v.carryover === "capped" && v.forfeiture_reviewed,
  }));

export const hoursSchema = z.object({
  employee_id: z.uuid("Choose an employee."),
  period_start: z.string().trim().refine(isOperationalDate, OPERATIONAL_DATE_MESSAGE),
  period_end: z.string().trim().refine(isOperationalDate, OPERATIONAL_DATE_MESSAGE),
  hours: z.string().trim().regex(/^\d{1,4}(\.\d{1,2})?$/, "Enter hours like 40 or 37.5."),
  note: z.string().trim().max(300, "Use at most 300 characters.").default(""),
  submission_key: z.uuid().optional(),
});
