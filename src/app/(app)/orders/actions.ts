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
import { ORDER_STATUS_LABELS, orderReasonMissing, orderTransitionPermissions } from "@/lib/orders/status";
import { NOTE_REQUIRED, URGENCY_LABELS, URGENCY_STATES } from "@/lib/orders/urgency";
import { zonedTimeToUtc } from "@/lib/dates";
import { priceConfirmedMessage } from "@/lib/orders/price-check";
import { businessToday } from "@/server/data/settings";
import { can } from "@/lib/permissions";
import { rolesPhrase } from "@/lib/permission-words";
import { assertAnyPermission, assertPermission } from "@/server/auth";
import { rolesWith } from "@/server/permission-holders";
import { getCustomerQuoteContext } from "@/server/data/customers";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";
import { creditGate, creditHolds, holdSummary, recordCreditOverride } from "@/server/credit";
import { creditHoldSentence } from "@/lib/dispatch/board";
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
export async function convertQuoteToOrder(quoteId: string, creditReason?: string): Promise<ActionResult<{ orderId: string; orderNumber: string; created: boolean }>> {
  return guard(async () => {
    await assertPermission("orders.edit");
    if (!uuid.safeParse(quoteId).success) return fail("Invalid quote.");
    const supabase = await createClient();
    // Credit hold (B128): a new order for a customer on hold needs a reason (an existing order just opens).
    const quote = (await supabase.from("quotes").select("customer_id").eq("id", quoteId).maybeSingle()).data as { customer_id: string } | null;
    const existing = (await supabase.from("orders").select("id").eq("source_quote_id", quoteId).limit(1)).data ?? [];
    const reason = creditReason?.trim().slice(0, 500);
    const gate = quote && !existing.length ? await creditGate(quote.customer_id, reason) : null;
    if (gate) return fail(gate.message, { creditReason: "Give a reason to go ahead." });
    const { data, error } = await supabase.rpc("convert_quote_to_order", { p_quote_id: quoteId });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { order_id: string; order_number: string; created: boolean };
    if (quote && r.created && reason) await recordCreditOverride(quote.customer_id, "order", r.order_id, reason);
    revalidatePath("/orders");
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath("/command-center");
    return ok(
      { orderId: r.order_id, orderNumber: r.order_number, created: r.created },
      r.created ? `Order ${r.order_number} created.` : `This quote was already converted. Opening order ${r.order_number}.`,
    );
  });
}

/**
 * Who decides about a new order for a customer on credit hold, for people who may create orders but not go ahead for
 * a customer on hold (orders.create without orders.edit).
 */
async function creditHoldDecider(): Promise<string> {
  return `A new order for a customer on hold needs someone in ${rolesPhrase(await rolesWith("orders.edit"))}: ask one of them to enter it (they record why), or ask billing to release the hold. Loads of existing orders can still be dispatched with a reason.`;
}

/**
 * Create or edit a direct order (no quote) while it is a Draft. The database
 * prices every line (customer list → standard list → manual) and refuses
 * overrides and discounts without pricing.override.
 *
 * orders.edit: any draft, as before. orders.create (owner 2026-11-09, dispatchers take phoned-in orders): a new order
 * and the person's own draft only, never for a customer on credit hold (checked again in the database,
 * private.require_order_draft_save).
 */
export async function saveOrderDraft(input: OrderDraftInput): Promise<ActionResult<{ orderId: string; editSeq: number; orderNumber: string; totalCents: number }>> {
  return guard(async () => {
    const access = await assertAnyPermission("orders.create", "orders.edit");
    const parsed = orderDraftInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const isNew = !parsed.data.orderId;
    // Credit hold (B128): a new order for a customer on hold needs a reason, which is recorded; only people who can
    // change orders may give one. Everyone else is told who decides.
    const mayGoAhead = can(access, "orders.edit");
    if (isNew && !mayGoAhead) {
      const hold = (await creditHolds([parsed.data.customerId])).get(parsed.data.customerId);
      if (hold) return fail(`${creditHoldSentence(`${hold.name} is ${holdSummary(hold)}`)} ${await creditHoldDecider()}`);
    }
    const gate = isNew && mayGoAhead ? await creditGate(parsed.data.customerId, parsed.data.creditReason) : null;
    if (gate) return fail(gate.message, { creditReason: "Give a reason to go ahead." });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_order_draft", { p_payload: toOrderDraftPayload(parsed.data) });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { order_id: string; edit_seq: number; order_number: string; total_cents: number };
    if (isNew && mayGoAhead && parsed.data.creditReason) await recordCreditOverride(parsed.data.customerId, "order", r.order_id, parsed.data.creditReason);
    revalidateOrder(r.order_id);
    if (parsed.data.saveSite) revalidatePath(`/customers/${parsed.data.customerId}`);
    return ok({ orderId: r.order_id, editSeq: r.edit_seq, orderNumber: r.order_number, totalCents: r.total_cents }, `Order ${r.order_number} saved.`);
  });
}

/** Customer contacts, sites and configured prices for the direct-order editor. */
export async function loadOrderCustomerContext(customerId: string, onDate: string) {
  return guard(async () => {
    const access = await assertAnyPermission("orders.create", "orders.edit");
    if (!uuid.safeParse(customerId).success || !/^\d{4}-\d{2}-\d{2}$/.test(onDate)) return fail("Invalid request.");
    const context = await getCustomerQuoteContext(customerId);
    if (!context) return fail("Customer not found.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("effective_prices", { p_customer_id: customerId, p_on: onDate });
    if (error) return fail(dbErrorMessage(error));
    const hold = (await creditHolds([customerId])).get(customerId);
    return ok({
      ...context,
      prices: (data ?? []) as EffectivePrice[],
      creditHold: hold ? creditHoldSentence(`${hold.name} is ${holdSummary(hold)}`) : null,
      // People who may create orders but not go ahead for a customer on hold are told who decides (no reason field).
      creditDecider: hold && !can(access, "orders.edit") ? await creditHoldDecider() : null,
    });
  });
}

/**
 * Confirm a price typed on an order line without a price-list rate ("Price to be checked", financial review M1, owner
 * 2026-11-10). pricing.edit, pricing.override or billing.manage confirm; billing.manage may also correct each typed
 * per-unit price in the same step, with a reason (20261120016400), even on a confirmed order. Checked again in the
 * database, which recomputes the totals, records the old and new prices in the order's history, and refuses an order on
 * an issued invoice or a handed-off one, and any of it during a Taviron support visit.
 */
export async function confirmOrderPrice(orderId: string, note: string, corrections: Array<{ line_id: string; unit_rate_cents: number }> = []): Promise<ActionResult<{ confirmed: boolean; corrected: number }>> {
  return guard(async () => {
    if (corrections.length) await assertPermission("billing.manage");
    else await assertAnyPermission("pricing.edit", "pricing.override", "billing.manage");
    if (!uuid.safeParse(orderId).success) return fail("Order not found.");
    const parsed = z.array(z.object({ line_id: z.uuid(), unit_rate_cents: z.number().int().min(0).max(100_000_000) })).max(200).safeParse(corrections);
    if (!parsed.success) return fail("Enter each corrected price in dollars, for example 95 or 12.50.");
    const reason = note.trim().slice(0, 500);
    if (parsed.data.length && reason.length < 3) return fail("Say why the price is corrected.", { note: "Say why the price is corrected." });
    const supabase = await createClient();
    const args: Record<string, unknown> = { p_order_id: orderId, p_note: reason };
    if (parsed.data.length) args.p_corrections = parsed.data;
    const { data, error } = await supabase.rpc("order_confirm_price", args);
    if (error) return fail(dbErrorMessage(error));
    const r = data as { confirmed: boolean; corrected?: number };
    revalidateOrder(orderId);
    revalidatePath("/billing");
    revalidatePath(`/billing/orders/${orderId}`);
    const corrected = r.corrected ?? 0;
    // Say what billing still waits for; readiness is read with the person's own rights (null if they cannot see it).
    const [{ data: billing }, { data: o }] = await Promise.all([
      supabase.from("billing_order_status").select("readiness, tickets_accepted").eq("order_id", orderId).maybeSingle(),
      supabase.from("orders").select("status").eq("id", orderId).maybeSingle(),
    ]);
    return ok({ confirmed: r.confirmed, corrected }, priceConfirmedMessage({ confirmed: r.confirmed, corrected }, (billing as { readiness: string; tickets_accepted: number } | null) ?? null, (o as { status: string } | null)?.status));
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
    const missing = orderReasonMissing(to, parsed.data.note ?? "");
    if (missing) return fail(missing, { note: missing });
    // Confirming or canceling a draft also takes orders.create, for the person's own new order only (the database
    // checks whose).
    const access = await assertAnyPermission(...orderTransitionPermissions(input.from, to));
    const supabase = await createClient();
    // Confirming one's own draft without orders.edit (SEC3): the customer may have been put on credit hold since the
    // draft was saved. Say who decides, as when saving a new order (the database refuses it as well).
    if (input.from === "draft" && to === "confirmed" && !can(access, "orders.edit")) {
      const draft = (await supabase.from("orders").select("customer_id").eq("id", parsed.data.orderId).maybeSingle()).data as { customer_id: string } | null;
      const hold = draft ? (await creditHolds([draft.customer_id])).get(draft.customer_id) : undefined;
      if (hold) return fail(`${creditHoldSentence(`${hold.name} is ${holdSummary(hold)}`)} ${await creditHoldDecider()}`);
    }
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
 * assignment or promises the customer a time. orders.edit on any order; orders.create on a direct order the person
 * entered themselves (owner 2026-11-09, MD1; the database checks whose, private.require_own_order_change).
 */
export async function flagOrderUrgent(input: z.input<typeof urgencyFlagInput>): Promise<ActionResult<{ created: boolean }>> {
  return guard(async () => {
    await assertAnyPermission("orders.edit", "orders.create");
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
