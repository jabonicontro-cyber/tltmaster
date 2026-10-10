"use server";

import { revalidatePath } from "next/cache";
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
import { assertPermission } from "@/server/auth";
import { getCustomerQuoteContext } from "@/server/data/customers";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";
import type { EffectivePrice, OrderStatus } from "@/server/data/types";

function revalidateOrder(id: string) {
  revalidatePath("/orders");
  revalidatePath(`/orders/${id}`);
  revalidatePath("/dashboard");
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
    revalidatePath("/dashboard");
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
