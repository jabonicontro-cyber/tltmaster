import { z } from "zod";
import { isOperationalDate, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";
import { TIME_OFF_CATEGORIES, type TimeOffCategory } from "@/lib/time-off";

// PTO banks and balances (migration 20261112000100). Every rule — eligibility, waiting periods, available balance,
// append-only history, permissions — is enforced by the database; these schemas validate input for the forms.

export const EMPLOYMENT_TYPES = { full_time: "Full-time", part_time: "Part-time", seasonal: "Seasonal", contractor: "Contractor" } as const;
export type EmploymentType = keyof typeof EMPLOYMENT_TYPES;

export const LEDGER_KINDS = { grant: "Grant", adjustment: "Adjustment", usage: "Used", usage_reversal: "Returned (canceled)" } as const;
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
