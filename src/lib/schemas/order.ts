import { z } from "zod";
import { isIsoDate } from "@/lib/dates";
import { parsePercentToBp } from "@/lib/money";
import { ORDER_STATUSES } from "@/lib/orders/status";
import { isoDate, jobDetailFields, optionalUuid, quoteLineInput, text, toJobDetailPayload, toLinePayload } from "./quote";

const optionalDate = z.preprocess(
  (v) => (v === undefined || v === null ? "" : v),
  z.string().refine((v) => v === "" || isIsoDate(v), "Enter a valid date."),
);
const optionalTime = z.preprocess(
  (v) => (v === undefined || v === null ? "" : v),
  z.string().refine((v) => v === "" || /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v), "Enter a valid time."),
);
const editSeq = z.number().int().nullable().default(null);

/** Direct order (no quote) — create or edit while Draft. */
export const orderDraftInput = z
  .object({
    orderId: optionalUuid,
    expectedEditSeq: editSeq,
    customerId: z.uuid("Choose a customer."),
    ...jobDetailFields,
    orderDate: isoDate,
    requestedDate: optionalDate,
    terms: text(8000),
    taxRate: z.string().default("0"),
    lines: z.array(quoteLineInput).max(200, "An order can have at most 200 lines."),
  })
  .superRefine((o, ctx) => {
    if (o.requestedDate && o.requestedDate < o.orderDate)
      ctx.addIssue({ code: "custom", message: "Cannot be before the order date.", path: ["requestedDate"] });
    const bp = parsePercentToBp(o.taxRate || "0");
    if (bp === null || bp > 2500) ctx.addIssue({ code: "custom", message: "Enter a tax rate between 0 and 25.", path: ["taxRate"] });
    if (o.saveSite && !o.siteId && !o.siteLine1) ctx.addIssue({ code: "custom", message: "Enter the street address to save this job site.", path: ["siteLine1"] });
  });

export type OrderDraftInput = z.input<typeof orderDraftInput>;

export function toOrderDraftPayload(o: z.output<typeof orderDraftInput>) {
  return {
    order_id: o.orderId,
    expected_edit_seq: o.expectedEditSeq,
    customer_id: o.customerId,
    ...toJobDetailPayload(o),
    order_date: o.orderDate,
    requested_date: o.requestedDate || null,
    terms: o.terms,
    tax_rate_bp: parsePercentToBp(o.taxRate || "0") ?? 0,
    lines: o.lines.map(toLinePayload),
  };
}

/** Details of any open order. Never lines, prices, terms or customer. */
export const orderDetailsInput = z
  .object({
    orderId: z.uuid("Invalid order."),
    expectedEditSeq: editSeq,
    ...jobDetailFields,
    requestedDate: optionalDate,
  })
  .superRefine((o, ctx) => {
    if (o.saveSite && !o.siteId && !o.siteLine1) ctx.addIssue({ code: "custom", message: "Enter the street address to save this job site.", path: ["siteLine1"] });
  });

export type OrderDetailsInput = z.input<typeof orderDetailsInput>;

export function toOrderDetailsPayload(o: z.output<typeof orderDetailsInput>) {
  return { ...toJobDetailPayload(o), requested_date: o.requestedDate || null };
}

export const orderScheduleInput = z
  .object({
    orderId: z.uuid("Invalid order."),
    expectedEditSeq: editSeq,
    scheduledStart: optionalDate,
    scheduledEnd: optionalDate,
    windowStart: optionalTime,
    windowEnd: optionalTime,
    schedulingNotes: text(2000),
  })
  .superRefine((s, ctx) => {
    if (s.scheduledEnd && !s.scheduledStart) ctx.addIssue({ code: "custom", message: "Enter a start date first.", path: ["scheduledStart"] });
    if (s.scheduledEnd && s.scheduledStart && s.scheduledEnd < s.scheduledStart)
      ctx.addIssue({ code: "custom", message: "Must be on or after the start date.", path: ["scheduledEnd"] });
    if (Boolean(s.windowStart) !== Boolean(s.windowEnd))
      ctx.addIssue({ code: "custom", message: "Enter both times or neither.", path: [s.windowStart ? "windowEnd" : "windowStart"] });
    if (s.windowStart && s.windowEnd && s.windowEnd <= s.windowStart)
      ctx.addIssue({ code: "custom", message: "Must be after the start time.", path: ["windowEnd"] });
  });

export type OrderScheduleInput = z.input<typeof orderScheduleInput>;

export function toOrderSchedulePayload(s: z.output<typeof orderScheduleInput>) {
  return {
    scheduled_start: s.scheduledStart || null,
    scheduled_end: s.scheduledEnd || null,
    window_start: s.windowStart || null,
    window_end: s.windowEnd || null,
    scheduling_notes: s.schedulingNotes,
  };
}

export const orderStatusInput = z.object({
  orderId: z.uuid("Invalid order."),
  status: z.enum(ORDER_STATUSES as [string, ...string[]]),
  note: text(1000),
  expectedEditSeq: editSeq,
});

export type OrderStatusInput = z.input<typeof orderStatusInput>;
