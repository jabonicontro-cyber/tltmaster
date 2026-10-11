"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { OPERATIONAL_DATE_MESSAGE, isOperationalDate } from "@/lib/dates";
import { REPORT_KINDS } from "@/lib/driver/rules";
import { quantityError } from "@/lib/tickets/rules";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

const ticketInput = z
  .object({
    assignmentId: z.uuid("This load is no longer available. Go back to My Day."),
    orderLineId: z.uuid("Choose what you delivered."),
    deliveredDate: z.string().refine(isOperationalDate, OPERATIONAL_DATE_MESSAGE),
    deliveredTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter the delivery time."),
    quantity: z.string().trim(),
    unitCode: z.string().min(1, "Tap the unit on the paper ticket."),
    externalReference: z.string().trim().max(60).default(""),
    notes: z.string().trim().max(2000).default(""),
    /** Made when the form opens and kept for retries: a repeated send returns the same ticket. */
    submissionKey: z.uuid(),
    confirmDuplicate: z.boolean().default(false),
    /** Photos already uploaded and confirmed (attached in the same transaction as the ticket). */
    photoIds: z.array(z.uuid()).max(3, "At most 3 photos per ticket.").default([]),
  })
  .superRefine((t, ctx) => {
    const q = quantityError(t.quantity, t.unitCode);
    if (q) ctx.addIssue({ code: "custom", message: q, path: ["quantity"] });
  });

type Sent = { ticketNumber: string; status: string; created: boolean };
type Outcome = ActionResult<Sent> | { ok: false; error: string; needsConfirmation: true };

/** Driver ticket: the server checks the load is the driver's own and applies every office rule. */
export async function submitDriverTicket(input: z.input<typeof ticketInput>): Promise<Outcome> {
  return guard(async () => {
    await assertPermission("driver.portal");
    const parsed = ticketInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const t = parsed.data;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("driver_submit_ticket", {
      p_payload: {
        assignment_id: t.assignmentId,
        order_line_id: t.orderLineId,
        delivered_date: t.deliveredDate,
        delivered_time: t.deliveredTime,
        quantity: t.quantity,
        unit_code: t.unitCode,
        external_reference: t.externalReference,
        notes: t.notes,
        submission_key: t.submissionKey,
        confirm_duplicate: t.confirmDuplicate,
        photo_ids: t.photoIds,
      },
    });
    if (error) {
      if (error.code === "PT422") return { ok: false as const, error: error.message, needsConfirmation: true as const };
      return fail(dbErrorMessage(error));
    }
    const r = data as { ticket_number: string; status: string; created: boolean };
    revalidatePath("/driver");
    return ok({ ticketNumber: r.ticket_number, status: r.status, created: r.created }, `Ticket ${r.ticket_number} sent to the office.`);
  }) as Promise<Outcome>;
}

const reportInput = z.object({
  assignmentId: z.uuid("This load is no longer available. Go back to My Day."),
  kind: z.enum(REPORT_KINDS, "Choose what you are reporting."),
  equipment: z.enum(["", "truck", "trailer"]).default(""),
  description: z.string().trim().min(3, "Say in a few words what happened.").max(2000),
  submissionKey: z.uuid(),
});

export async function submitFieldReport(input: z.input<typeof reportInput>): Promise<ActionResult<{ created: boolean }>> {
  return guard(async () => {
    await assertPermission("driver.portal");
    const parsed = reportInput.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the report.");
    const r = parsed.data;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("driver_submit_field_report", {
      p_payload: { assignment_id: r.assignmentId, kind: r.kind, equipment: r.equipment, description: r.description, submission_key: r.submissionKey },
    });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/driver");
    revalidatePath("/field-reports");
    return ok({ created: (data as { created: boolean }).created }, "Report sent to the office.");
  }) as Promise<ActionResult<{ created: boolean }>>;
}
