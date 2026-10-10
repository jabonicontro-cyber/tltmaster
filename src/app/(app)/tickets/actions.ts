"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isIsoDate } from "@/lib/dates";
import { quantityError } from "@/lib/tickets/rules";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

const optionalUuid = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.uuid().nullable());

const ticketInput = z
  .object({
    loadId: z.uuid("Invalid load."),
    orderLineId: z.uuid("Choose the order line that was delivered."),
    deliveredDate: z.string().refine(isIsoDate, "Enter a valid date."),
    deliveredTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a valid time."),
    quantity: z.string().trim(),
    unitCode: z.string().min(1, "Choose the unit of the delivered quantity."),
    externalReference: z.string().trim().max(60).default(""),
    notes: z.string().trim().max(2000).default(""),
    truckId: z.uuid("Choose the truck."),
    trailerId: optionalUuid,
    driverId: z.uuid("Choose the driver."),
    /** Generated when the form opens: a repeated submit returns the same ticket. */
    submissionKey: optionalUuid,
    confirmDuplicate: z.boolean().default(false),
  })
  .superRefine((t, ctx) => {
    const q = quantityError(t.quantity, t.unitCode);
    if (q) ctx.addIssue({ code: "custom", message: q, path: ["quantity"] });
  });

export type TicketInput = z.input<typeof ticketInput>;

function toPayload(t: z.output<typeof ticketInput>) {
  return {
    load_id: t.loadId,
    order_line_id: t.orderLineId,
    delivered_date: t.deliveredDate,
    delivered_time: t.deliveredTime,
    quantity: t.quantity,
    unit_code: t.unitCode,
    external_reference: t.externalReference,
    notes: t.notes,
    truck_id: t.truckId,
    trailer_id: t.trailerId,
    driver_id: t.driverId,
    submission_key: t.submissionKey,
    confirm_duplicate: t.confirmDuplicate,
  };
}

type DbError = { code?: string; message?: string };

/** A possible duplicate is not an error: the form asks the user to confirm. */
type Outcome<T> = ActionResult<T> | { ok: false; error: string; needsConfirmation: true };

function confirmOrFail(error: DbError) {
  if (error.code === "PT422") return { ok: false as const, error: error.message ?? "Possible duplicate.", needsConfirmation: true as const };
  return fail(dbErrorMessage(error));
}

function revalidateTickets(orderId?: string) {
  revalidatePath("/tickets", "layout");
  revalidatePath("/dispatch");
  revalidatePath("/command-center");
  if (orderId) revalidatePath(`/orders/${orderId}`);
}

export async function submitTicket(input: TicketInput & { orderId: string }): Promise<Outcome<{ ticketId: string; ticketNumber: string; status: string; created: boolean }>> {
  return guard(async () => {
    await assertPermission("tickets.edit");
    const parsed = ticketInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("submit_delivery_ticket", { p_payload: toPayload(parsed.data) });
    if (error) return confirmOrFail(error);
    const r = data as { ticket_id: string; ticket_number: string; status: string; created: boolean };
    revalidateTickets(input.orderId);
    return ok(
      { ticketId: r.ticket_id, ticketNumber: r.ticket_number, status: r.status, created: r.created },
      r.created ? `Ticket ${r.ticket_number} submitted.` : `Ticket ${r.ticket_number} was already submitted.`,
    );
  }) as Promise<Outcome<{ ticketId: string; ticketNumber: string; status: string; created: boolean }>>;
}

export async function correctTicket(ticketId: string, input: TicketInput & { orderId: string; reason: string }): Promise<Outcome<{ ticketId: string; revision: number }>> {
  return guard(async () => {
    await assertPermission("tickets.edit");
    if (!z.uuid().safeParse(ticketId).success) return fail("Invalid ticket.");
    const reason = input.reason.trim();
    if (!reason) return fail("Enter the reason for the correction.", { reason: "Enter the reason for the correction." });
    const parsed = ticketInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("correct_delivery_ticket", { p_ticket_id: ticketId, p_payload: toPayload(parsed.data), p_reason: reason });
    if (error) return confirmOrFail(error);
    const r = data as { ticket_id: string; revision: number };
    revalidateTickets(input.orderId);
    return ok({ ticketId: r.ticket_id, revision: r.revision }, `Correction saved as revision ${r.revision}.`);
  }) as Promise<Outcome<{ ticketId: string; revision: number }>>;
}

const reviewInput = z.object({
  ticketId: z.uuid("Invalid ticket."),
  action: z.enum(["accept", "flag", "void"]),
  note: z.string().trim().max(500).default(""),
  orderId: z.uuid(),
});

export async function reviewTicket(input: z.input<typeof reviewInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("tickets.review");
    const parsed = reviewInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("review_delivery_ticket", { p_ticket_id: parsed.data.ticketId, p_action: parsed.data.action, p_note: parsed.data.note });
    if (error) return fail(dbErrorMessage(error));
    revalidateTickets(parsed.data.orderId);
    return ok(undefined, parsed.data.action === "accept" ? "Ticket accepted." : parsed.data.action === "flag" ? "Ticket flagged for review." : "Ticket voided.");
  });
}
