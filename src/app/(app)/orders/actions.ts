"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { uuid } from "@/lib/schemas/common";
import {
  orderDetailsInput,
  orderDraftInput,
  orderScheduleInput,
  orderStatusInput,
  toOrderDetailsPayload,
  toOrderDraftPayload,
  toOrderSchedulePayload,
  type OrderDetailsInput,
  type OrderDraftInput,
  type OrderScheduleInput,
  type OrderStatusInput,
} from "@/lib/schemas/order";
import { ORDER_STATUS_LABELS, orderTransitionPermission } from "@/lib/orders/status";
import { NOTE_REQUIRED, URGENCY_LABELS, URGENCY_STATES } from "@/lib/orders/urgency";
import { zonedTimeToUtc } from "@/lib/dates";
import { businessToday } from "@/server/data/settings";
import { assertPermission } from "@/server/auth";
import { getCustomerQuoteContext } from "@/server/data/customers";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";
import type { EffectivePrice, OrderStatus } from "@/server/data/types";

function revalidateOrder(id: string) {
  revalidatePath("/orders");
  revalidatePath(`/orders/${id}`);
  revalidatePath("/command-center");
}

/**
 * Convert an accepted quote into an order. Safe to repeat: if the quote was
 * already converted (double click, retry, another user), the existing order
 * is returned with created = false. The database function enforces the
 * permission and the accepted status as well.
 */
export async function convertQuoteToOrder(quoteId: string): Promise<ActionResult<{ orderId: string; orderNumber: string; created: boolean }>> {
  return guard(async () => {
    await assertPermission("orders.edit");
    if (!uuid.safeParse(quoteId).success) return fail("Invalid quote.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("convert_quote_to_order", { p_quote_id: quoteId });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { order_id: string; order_number: string; created: boolean };
    revalidatePath("/orders");
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath("/command-center");
    return ok(
      { orderId: r.order_id, orderNumber: r.order_number, created: r.created },
      r.created ? `Order ${r.order_number} created.` : `This quote was already converted — opening order ${r.order_number}.`,
    );
  });
}

/**
 * Create or edit a direct order (no quote) while it is a Draft. The database
 * prices every line (customer list → standard list → manual) and refuses
 * overrides and discounts without pricing.override.
 */
export async function saveOrderDraft(input: OrderDraftInput): Promise<ActionResult<{ orderId: string; editSeq: number; orderNumber: string; totalCents: number }>> {
  return guard(async () => {
    await assertPermission("orders.edit");
    const parsed = orderDraftInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_order_draft", { p_payload: toOrderDraftPayload(parsed.data) });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { order_id: string; edit_seq: number; order_number: string; total_cents: number };
    revalidateOrder(r.order_id);
    if (parsed.data.saveSite) revalidatePath(`/customers/${parsed.data.customerId}`);
    return ok({ orderId: r.order_id, editSeq: r.edit_seq, orderNumber: r.order_number, totalCents: r.total_cents }, `Order ${r.order_number} saved.`);
  });
}

/** Customer contacts, sites and configured prices for the direct-order editor. */
export async function loadOrderCustomerContext(customerId: string, onDate: string) {
  return guard(async () => {
    await assertPermission("orders.edit");
    if (!uuid.safeParse(customerId).success || !/^\d{4}-\d{2}-\d{2}$/.test(onDate)) return fail("Invalid request.");
    const context = await getCustomerQuoteContext(customerId);
    if (!context) return fail("Customer not found.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("effective_prices", { p_customer_id: customerId, p_on: onDate });
    if (error) return fail(dbErrorMessage(error));
    return ok({ ...context, prices: (data ?? []) as EffectivePrice[] });
  });
}

/** Contact, job site, PO, instructions, notes and requested date of an open order. Prices never change here. */
export async function updateOrderDetails(input: OrderDetailsInput): Promise<ActionResult<{ editSeq: number }>> {
  return guard(async () => {
    await assertPermission("orders.edit");
    const parsed = orderDetailsInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("update_order_details", {
      p_order_id: parsed.data.orderId,
      p_expected_edit_seq: parsed.data.expectedEditSeq,
      p_payload: toOrderDetailsPayload(parsed.data),
    });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { edit_seq: number; changed: boolean };
    revalidateOrder(parsed.data.orderId);
    return ok({ editSeq: r.edit_seq }, r.changed ? "Order details saved." : "No changes to save.");
  });
}

export async function updateOrderSchedule(input: OrderScheduleInput): Promise<ActionResult<{ editSeq: number }>> {
  return guard(async () => {
    await assertPermission("orders.schedule");
    const parsed = orderScheduleInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("update_order_schedule", {
      p_order_id: parsed.data.orderId,
      p_expected_edit_seq: parsed.data.expectedEditSeq,
      p_payload: toOrderSchedulePayload(parsed.data),
    });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { edit_seq: number; changed: boolean };
    revalidateOrder(parsed.data.orderId);
    return ok({ editSeq: r.edit_seq }, r.changed ? "Schedule saved." : "No changes to save.");
  });
}

/**
 * Move an order to another status. `from` is the status the user saw; the
 * database re-checks the transition, the permission and the requirements
 * against the current row.
 */
export async function setOrderStatus(input: OrderStatusInput & { from: OrderStatus }): Promise<ActionResult<{ status: OrderStatus; editSeq: number }>> {
  return guard(async () => {
    const parsed = orderStatusInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const to = parsed.data.status as OrderStatus;
    await assertPermission(orderTransitionPermission(input.from, to));
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("set_order_status", {
      p_order_id: parsed.data.orderId,
      p_status: to,
      p_note: parsed.data.note,
      p_expected_edit_seq: parsed.data.expectedEditSeq,
    });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { status: OrderStatus; edit_seq: number };
    revalidateOrder(parsed.data.orderId);
    return ok({ status: r.status, editSeq: r.edit_seq }, `Order marked ${ORDER_STATUS_LABELS[r.status].toLowerCase()}.`);
  });
}

const urgencyFlagInput = z.object({
  orderId: z.uuid("Invalid order."),
  reason: z.string().trim().min(3, "Say why the order is urgent.").max(500),
  /** Optional needed-by time in the business time zone. */
  neededDate: z.string().trim().default(""),
  neededTime: z.string().trim().default(""),
});

/**
 * Flag an order as urgent (or update the reason/deadline of its open flag).
 * Safe to repeat: one open flag per order. It never assigns a truck, changes an
 * assignment or promises the customer a time.
 */
export async function flagOrderUrgent(input: z.input<typeof urgencyFlagInput>): Promise<ActionResult<{ created: boolean }>> {
  return guard(async () => {
    await assertPermission("orders.edit");
    const parsed = urgencyFlagInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const f = parsed.data;
    let neededBy: string | null = null;
    if (f.neededDate || f.neededTime) {
      const { timezone } = await businessToday();
      neededBy = zonedTimeToUtc(f.neededDate, f.neededTime || "23:59", timezone);
      if (!neededBy) return fail("Enter a valid needed-by date and time.", { neededDate: "Enter a valid date and time." });
    }
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("flag_order_urgent", { p_order_id: f.orderId, p_reason: f.reason, p_needed_by: neededBy });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { created: boolean; changed: boolean };
    revalidateOrder(f.orderId);
    revalidatePath("/dispatch");
    return ok({ created: r.created }, r.created ? "Flagged urgent. Dispatch sees it on the board and in the Command Center." : r.changed ? "Urgent flag updated." : "Already flagged with these details.");
  });
}

const urgencyUpdateInput = z.object({
  urgencyId: z.uuid("Invalid flag."),
  orderId: z.uuid("Invalid order."),
  state: z.enum(URGENCY_STATES),
  note: z.string().trim().max(500).default(""),
});

/** Move an urgent flag on (acknowledge, evaluating, waiting, blocked, assigned, resolve, withdraw). The database checks permission and state. */
export async function updateOrderUrgency(input: z.input<typeof urgencyUpdateInput>): Promise<ActionResult> {
  return guard(async () => {
    const parsed = urgencyUpdateInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const f = parsed.data;
    if (NOTE_REQUIRED.includes(f.state) && !f.note) return fail("Add a note.", { note: "Required for this step." });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("update_order_urgency", { p_urgency_id: f.urgencyId, p_state: f.state, p_note: f.note });
    if (error) return fail(dbErrorMessage(error));
    revalidateOrder(f.orderId);
    revalidatePath("/dispatch");
    const r = data as { changed: boolean };
    return ok(undefined, r.changed ? `Urgent order: ${URGENCY_LABELS[f.state].toLowerCase()}.` : "No change.");
  });
}
