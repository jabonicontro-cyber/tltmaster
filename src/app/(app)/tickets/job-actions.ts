"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isIsoDate } from "@/lib/dates";
import { parseMoneyToCents } from "@/lib/money";
import { quantityError } from "@/lib/tickets/rules";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { moduleIsOn } from "@/server/modules";
import { createClient } from "@/server/supabase/server";

// Tickets without Dispatch (MOD1 (2), docs/MODULES.md §5). Permissions and every rule are checked again by the
// database functions (submit_ticket_without_dispatch, create_ticket_job, 20261120023100).

const optionalUuid = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.uuid().nullable());
const NOT_INSTALLED = "Entering tickets without dispatch needs a database update that has not been installed yet.";
const missingFn = (code?: string) => code === "PGRST202" || code === "42883";

const ticketInput = z
  .object({
    orderId: z.uuid("Choose the customer's job."),
    orderLineId: z.uuid("Choose the material that was delivered."),
    deliveredDate: z.string().refine(isIsoDate, "Enter the delivery date."),
    deliveredTime: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, "Enter a valid time, or leave it empty."),
    quantity: z.string().trim(),
    unitCode: z.string().min(1, "Choose the unit of the delivered quantity."),
    externalReference: z.string().trim().max(60).default(""),
    notes: z.string().trim().max(2000).default(""),
    truckId: optionalUuid,
    trailerId: optionalUuid,
    driverId: optionalUuid,
    submissionKey: optionalUuid,
    confirmDuplicate: z.boolean().default(false),
  })
  .superRefine((t, ctx) => {
    const q = quantityError(t.quantity, t.unitCode);
    if (q) ctx.addIssue({ code: "custom", message: q, path: ["quantity"] });
  });

export type TicketWithoutDispatchInput = z.input<typeof ticketInput>;
type Outcome<T> = ActionResult<T> | { ok: false; error: string; needsConfirmation: true };

const payload = (t: z.output<typeof ticketInput>) => ({
  order_id: t.orderId,
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
});

export async function submitTicketWithoutDispatch(input: TicketWithoutDispatchInput): Promise<Outcome<{ ticketId: string; ticketNumber: string; status: string; created: boolean }>> {
  return guard(async () => {
    await assertPermission("tickets.edit");
    if (await moduleIsOn("dispatch")) return fail("Your company uses Dispatch: enter the ticket from its dispatched load.");
    const parsed = ticketInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("submit_ticket_without_dispatch", { p_payload: payload(parsed.data) });
    if (error) {
      if (error.code === "PT422") return { ok: false as const, error: error.message ?? "Possible duplicate.", needsConfirmation: true as const };
      return fail(missingFn(error.code) ? NOT_INSTALLED : dbErrorMessage(error));
    }
    const r = data as { ticket_id: string; ticket_number: string; status: string; created: boolean };
    revalidatePath("/tickets", "layout");
    revalidatePath("/command-center");
    revalidatePath("/billing");
    revalidatePath(`/orders/${parsed.data.orderId}`);
    return ok({ ticketId: r.ticket_id, ticketNumber: r.ticket_number, status: r.status, created: r.created }, r.created ? `Ticket ${r.ticket_number} submitted.` : `Ticket ${r.ticket_number} was already submitted.`);
  }) as Promise<Outcome<{ ticketId: string; ticketNumber: string; status: string; created: boolean }>>;
}

/** Correct a ticket entered without dispatch: same rules as at entry; time, truck and driver optional. */
export async function correctTicketWithoutDispatch(
  ticketId: string,
  input: { loadId: string; orderId: string; orderLineId: string; deliveredDate: string; deliveredTime: string; quantity: string; unitCode: string; externalReference: string; notes: string; truckId: string | null; trailerId: string | null; driverId: string | null; confirmDuplicate?: boolean; reason: string },
): Promise<Outcome<{ ticketId: string; revision: number }>> {
  return guard(async () => {
    await assertPermission("tickets.edit");
    if (!z.uuid().safeParse(ticketId).success || !z.uuid().safeParse(input.loadId).success) return fail("Invalid ticket.");
    const reason = input.reason.trim();
    if (!reason) return fail("Enter the reason for the correction.", { reason: "Enter the reason for the correction." });
    const parsed = ticketInput.safeParse({ ...input, submissionKey: null });
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("correct_delivery_ticket", { p_ticket_id: ticketId, p_payload: { ...payload(parsed.data), load_id: input.loadId }, p_reason: reason });
    if (error) {
      if (error.code === "PT422") return { ok: false as const, error: error.message ?? "Possible duplicate.", needsConfirmation: true as const };
      return fail(dbErrorMessage(error));
    }
    const r = data as { ticket_id: string; revision: number };
    revalidatePath("/tickets", "layout");
    revalidatePath(`/orders/${parsed.data.orderId}`);
    return ok({ ticketId: r.ticket_id, revision: r.revision }, `Correction saved as revision ${r.revision}.`);
  }) as Promise<Outcome<{ ticketId: string; revision: number }>>;
}

const jobInput = z.object({
  customerId: z.uuid("Choose the customer."),
  siteLabel: z.string().trim().min(1, "Enter the job or site name.").max(200),
  materialId: z.uuid("Choose the material."),
  description: z.string().trim().min(1).max(300),
  unitCode: z.string().min(1, "Choose the unit."),
  price: z.string().trim().min(1, "Enter the agreed price."),
  quantity: z.string().trim().regex(/^\d{1,6}(\.\d{1,3})?$/, "Enter the job's expected quantity (more than 0)."),
  taxable: z.boolean(),
  taxRateBp: z.number().int().min(0).max(2500),
  deliveredDate: z.string().refine(isIsoDate, "Enter the delivery date first."),
});

export type TicketJobInput = z.input<typeof jobInput>;

/** A new job in one step from the ticket screen (orders.edit or orders.create, checked again by the order functions). */
export async function createTicketJob(input: TicketJobInput): Promise<ActionResult<{ orderId: string; orderNumber: string; orderLineId: string }>> {
  return guard(async () => {
    await assertPermission("tickets.edit");
    if (await moduleIsOn("dispatch")) return fail("Your company uses Dispatch: create the order on the Orders page.");
    const parsed = jobInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const j = parsed.data;
    const cents = parseMoneyToCents(j.price);
    if (cents === null || cents < 0) return fail("Enter the agreed price, for example 12.50.", { price: "Enter the agreed price, for example 12.50." });
    if (Number(j.quantity) <= 0) return fail("Enter the job's expected quantity (more than 0).", { quantity: "Enter the job's expected quantity (more than 0)." });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("create_ticket_job", {
      p_payload: {
        customer_id: j.customerId,
        site_label: j.siteLabel,
        project_name: j.siteLabel,
        tax_rate_bp: j.taxRateBp,
        delivered_date: j.deliveredDate,
        lines: [{ kind: "material", calc_method: "per_unit", material_id: j.materialId, description: j.description, unit_code: j.unitCode, quantity: j.quantity, unit_rate_cents: cents, taxable: j.taxable }],
      },
    });
    if (error) return fail(missingFn(error.code) ? NOT_INSTALLED : dbErrorMessage(error));
    const r = data as { order_id: string; order_number: string; order_line_id: string };
    revalidatePath("/orders");
    return ok({ orderId: r.order_id, orderNumber: r.order_number, orderLineId: r.order_line_id }, `Job ${r.order_number} created.`);
  });
}

/** The customer's price for a material on a date, from their price list (null: none on file). */
export async function ticketJobPrice(customerId: string, materialId: string, unitCode: string, date: string): Promise<ActionResult<{ cents: number | null; source: string | null }>> {
  return guard(async () => {
    await assertPermission("tickets.edit");
    if (![customerId, materialId].every((v) => z.uuid().safeParse(v).success) || !isIsoDate(date)) return fail("Choose the customer and material.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("effective_prices", { p_customer_id: customerId, p_on: date });
    if (error) return ok({ cents: null, source: null });
    const rows = (data ?? []) as Array<{ material_id: string | null; unit_code: string | null; rate_cents: number | null; source: string }>;
    const hit = rows.find((p) => p.material_id === materialId && p.unit_code === unitCode && p.rate_cents !== null);
    return ok({ cents: hit?.rate_cents ?? null, source: hit?.source ?? null });
  });
}
