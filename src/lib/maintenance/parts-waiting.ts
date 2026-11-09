import { z } from "zod";
import { formatDate, isOperationalDate, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";
import { parseMoneyToCents } from "@/lib/money";

// Parts on order for a work order (20261120012300): the form's rules and the dashboard line. The database checks
// the permission, the company, the work order and the dates again.

const optionalDate = z.string().optional().transform((v) => v?.trim() || null)
  .refine((v) => v === null || isOperationalDate(v), OPERATIONAL_DATE_MESSAGE);

export const partWaitSchema = z.object({
  description: z.string().trim().max(160, "Use at most 160 characters.").default(""),
  part_id: z.string().optional().transform((v) => v?.trim() || null).pipe(z.uuid("Choose a part from the list.").nullable()),
  part_number: z.string().trim().max(60, "Use at most 60 characters.").default(""),
  quantity: z.string().optional().transform((v, ctx) => {
    const clean = (v ?? "").replace(/[,\s]/g, "");
    if (!clean) return 1;
    const n = Number(clean);
    if (!Number.isFinite(n) || n <= 0 || n > 1000000) {
      ctx.addIssue({ code: "custom", message: "Enter how many are on order." });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  }),
  vendor_name: z.string().trim().max(120, "Use at most 120 characters.").default(""),
  po_number: z.string().trim().max(60, "Use at most 60 characters.").default(""),
  expected_on: optionalDate,
  unit_cost: z.string().optional().transform((v, ctx) => {
    const clean = (v ?? "").trim();
    if (!clean) return null;
    const cents = parseMoneyToCents(clean);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: "Enter an amount like 41.50." });
      return z.NEVER;
    }
    return cents;
  }),
}).superRefine((v, ctx) => {
  if (!v.part_id && v.description.length < 2) ctx.addIssue({ code: "custom", path: ["description"], message: "Say which part is on order." });
});
export type PartWaitInput = z.infer<typeof partWaitSchema>;

export interface WaitingPart { work_order_id: string; expected_on: string | null; status: string }

export interface PartsWaitingSummary {
  /** Jobs waiting for parts: in the "Waiting for parts" status, or with at least one part still on order. */
  jobs: number;
  /** Parts still on order. */
  parts: number;
  /** The earliest expected date from today on; null when none is set. */
  next: string | null;
  /** Parts whose expected date has passed. */
  late: number;
}

/**
 * What the Maintenance dashboard says about parts on order (only parts still waiting count). `awaitingJobIds`: jobs in
 * the "Waiting for parts" status, counted even when nobody listed the part (before 20261120012300, or from a phone).
 */
export function summarizePartsWaiting(rows: ReadonlyArray<WaitingPart>, today: string, awaitingJobIds: ReadonlyArray<string> = []): PartsWaitingSummary {
  const waiting = rows.filter((r) => r.status === "waiting");
  const dates = waiting.map((r) => r.expected_on).filter((d): d is string => Boolean(d));
  const upcoming = dates.filter((d) => d >= today).sort();
  return {
    jobs: new Set([...waiting.map((r) => r.work_order_id), ...awaitingJobIds]).size,
    parts: waiting.length,
    next: upcoming[0] ?? null,
    late: dates.filter((d) => d < today).length,
  };
}

/** "Waiting for parts: 2, next expected Nov 12, 2026" in plain words; null when nothing is on order. */
export function partsWaitingText(s: PartsWaitingSummary): string | null {
  if (s.jobs === 0) return null;
  const parts = [`Waiting for parts: ${s.jobs}`];
  if (s.next) parts.push(`next expected ${formatDate(s.next)}`);
  else if (!s.late) parts.push("no expected date yet");
  if (s.late) parts.push(`${s.late} ${s.late === 1 ? "is" : "are"} past the expected date`);
  return parts.join(", ");
}

/** One part's expected date in words: "Expected Nov 12, 2026", "Late: expected Nov 5, 2026" or "No expected date". */
export function expectedText(expectedOn: string | null, today: string): { text: string; late: boolean } {
  if (!expectedOn) return { text: "No expected date", late: false };
  if (expectedOn < today) return { text: `Late: expected ${formatDate(expectedOn)}`, late: true };
  return { text: expectedOn === today ? "Expected today" : `Expected ${formatDate(expectedOn)}`, late: false };
}
