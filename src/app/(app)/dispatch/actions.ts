"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { OPERATIONAL_DATE_MESSAGE, isIsoDate, isOperationalDate } from "@/lib/dates";
import { HOS_REQUIRED_MESSAGE, approvalNote, hosApprovalAllowed, hosProvider } from "@/lib/hos";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";
import { checkPair } from "@/lib/dispatch/smart";
import { checkAssignment } from "@/lib/optimization/plan";
import { getOptimizationInput } from "@/server/data/optimization";
import { getSmartDispatchInput } from "@/server/data/smart-dispatch";

const optionalUuid = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.uuid().nullable());
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Enter a valid time.");

function revalidateBoard(orderId?: string) {
  revalidatePath("/dispatch");
  revalidatePath("/command-center");
  if (orderId) revalidatePath(`/orders/${orderId}`);
}

const loadInput = z
  .object({
    loadId: optionalUuid,
    orderId: z.uuid("Invalid order."),
    loadDate: z.string().refine(isOperationalDate, OPERATIONAL_DATE_MESSAGE),
    startTime: time,
    endTime: time,
    plannedQuantity: z
      .string()
      .trim()
      .default("")
      .refine((v) => v === "" || (/^\d{1,6}(\.\d{1,3})?$/.test(v) && Number(v) > 0), "Enter a quantity greater than 0 with up to 3 decimals."),
    unitCode: z.string().default(""),
    notes: z.string().trim().max(1000).default(""),
  })
  .superRefine((l, ctx) => {
    if (l.endTime <= l.startTime) ctx.addIssue({ code: "custom", message: "Must be after the start time.", path: ["endTime"] });
    if (Boolean(l.plannedQuantity) !== Boolean(l.unitCode)) ctx.addIssue({ code: "custom", message: "Enter both quantity and unit, or neither.", path: [l.plannedQuantity ? "unitCode" : "plannedQuantity"] });
  });

export async function saveLoad(input: z.input<typeof loadInput>): Promise<ActionResult<{ loadId: string; loadNumber: number }>> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = loadInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const l = parsed.data;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_order_load", {
      p_payload: {
        load_id: l.loadId,
        order_id: l.orderId,
        load_date: l.loadDate,
        start_time: l.startTime,
        end_time: l.endTime,
        planned_quantity: l.plannedQuantity || null,
        unit_code: l.unitCode || null,
        notes: l.notes,
      },
    });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { load_id: string; load_number: number };
    revalidateBoard(l.orderId);
    return ok({ loadId: r.load_id, loadNumber: r.load_number }, l.loadId ? `Load ${r.load_number} updated.` : `Load ${r.load_number} added.`);
  });
}

const reasonInput = z.object({ id: z.uuid("Invalid record."), reason: z.string().trim().min(1, "Enter a reason.").max(500), orderId: z.uuid() });

export async function cancelLoad(input: z.input<typeof reasonInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = reasonInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("cancel_order_load", { p_load_id: parsed.data.id, p_reason: parsed.data.reason });
    if (error) return fail(dbErrorMessage(error));
    revalidateBoard(parsed.data.orderId);
    return ok(undefined, "Load canceled.");
  });
}

const assignInput = z.object({
  loadId: z.uuid("Invalid load."),
  orderId: z.uuid(),
  truckId: z.uuid("Choose a truck."),
  trailerId: optionalUuid,
  driverId: z.uuid("Choose a driver."),
  note: z.string().trim().max(500).default(""),
  /** The assignment the user saw on the board (null when the load was unassigned). */
  replaceAssignmentId: optionalUuid,
});

export async function assignLoad(input: z.input<typeof assignInput>): Promise<ActionResult<{ assignmentId: string; warnings: string[] }>> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = assignInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const a = parsed.data;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("assign_load", {
      p_load_id: a.loadId,
      p_truck_id: a.truckId,
      p_trailer_id: a.trailerId,
      p_driver_id: a.driverId,
      p_note: a.note,
      p_replace_assignment_id: a.replaceAssignmentId,
    });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { assignment_id: string; warnings: string[] };
    revalidateBoard(a.orderId);
    return ok({ assignmentId: r.assignment_id, warnings: r.warnings }, a.replaceAssignmentId ? "Load reassigned." : "Load assigned.");
  });
}

export async function cancelAssignment(input: z.input<typeof reasonInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = reasonInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("cancel_assignment", { p_assignment_id: parsed.data.id, p_reason: parsed.data.reason });
    if (error) return fail(dbErrorMessage(error));
    revalidateBoard(parsed.data.orderId);
    return ok(undefined, "Assignment removed.");
  });
}

const scheduleInput = z
  .object({
    orderId: z.uuid("Invalid order."),
    expectedEditSeq: z.number().int().nonnegative(),
    start: z.string().refine(isOperationalDate, OPERATIONAL_DATE_MESSAGE),
    end: z.string().default("").refine((v) => v === "" || isOperationalDate(v), OPERATIONAL_DATE_MESSAGE),
  })
  .superRefine((s, ctx) => {
    if (s.end && s.end < s.start) ctx.addIssue({ code: "custom", message: "Must be on or after the delivery date.", path: ["end"] });
  });

/**
 * Give a confirmed order its delivery dates and mark it Scheduled, from the
 * dispatch board's "Needs scheduling" queue. Uses the same database functions
 * (and checks) as the order page: the schedule first (edit-sequence checked,
 * so a stale screen cannot overwrite a newer change), then the status.
 */
export async function scheduleOrderFromQueue(input: z.input<typeof scheduleInput>): Promise<ActionResult<{ date: string }>> {
  return guard(async () => {
    await assertPermission("orders.schedule");
    const parsed = scheduleInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const { orderId, expectedEditSeq, start, end } = parsed.data;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("update_order_schedule", {
      p_order_id: orderId,
      p_expected_edit_seq: expectedEditSeq,
      p_payload: { scheduled_start: start, scheduled_end: end || null },
    });
    if (error) return fail(dbErrorMessage(error));
    const seq = (data as { edit_seq: number }).edit_seq;
    const { error: sErr } = await supabase.rpc("set_order_status", { p_order_id: orderId, p_status: "scheduled", p_note: "Scheduled from the dispatch queue", p_expected_edit_seq: seq });
    revalidateBoard(orderId);
    revalidatePath("/orders");
    if (sErr) return fail(`The dates were saved, but the order could not be marked Scheduled: ${dbErrorMessage(sErr)}`);
    return ok({ date: start }, "Scheduled. It is now on the board for that day.");
  });
}

const pairInput = z.object({ loadId: z.uuid(), truckId: z.uuid(), driverId: z.uuid(), trailerId: z.uuid().nullish(), loadDate: z.string().refine(isIsoDate), hosConfirmed: z.boolean().default(false) });

/**
 * Approve a Smart Dispatch proposal. Re-checks the pair against current data,
 * then assigns through public.assign_load — the same function, permission and
 * database checks as a manual assignment (eligibility, capacity, conflicts,
 * and a refusal if someone else assigned the load meanwhile). Recorded in the
 * order's history as an approved proposal.
 */
export async function approveRecommendation(input: z.input<typeof pairInput>): Promise<ActionResult<{ warnings: string[] }>> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = pairInput.safeParse(input);
    if (!parsed.success) return fail("Invalid proposal.");
    const { loadId, truckId, driverId, loadDate, hosConfirmed } = parsed.data;
    const trailerId = parsed.data.trailerId ?? null;
    // Hours of service are not in Taviron (lib/hos): the dispatcher confirms them, or nothing is assigned.
    if (!hosApprovalAllowed(hosProvider(), [driverId], loadDate, hosConfirmed)) return fail(HOS_REQUIRED_MESSAGE);
    // A tractor's proposal carries its trailer: checked with the trailer rules (the same as Plan the day).
    const check = trailerId
      ? checkAssignment(await getOptimizationInput(loadDate), loadId, truckId, trailerId, driverId)
      : checkPair(await getSmartDispatchInput(loadDate, loadDate), loadId, truckId, driverId);
    if (!check.ok) {
      revalidateBoard();
      return fail(`This proposal is no longer valid — ${check.reasons.join(" ")} The proposals have been refreshed; review them again.`);
    }
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("assign_load", {
      p_load_id: loadId, p_truck_id: truckId, p_trailer_id: trailerId, p_driver_id: driverId, p_note: approvalNote("Approved Smart Dispatch proposal", hosConfirmed), p_replace_assignment_id: null,
    });
    revalidateBoard();
    if (error) return fail(`Not assigned: ${dbErrorMessage(error)} Review the refreshed proposals.`);
    return ok({ warnings: ((data as { warnings: string[] }).warnings ?? []) }, "Assigned.");
  });
}

const rejectInput = z.object({ loadId: z.uuid(), truckId: z.uuid(), driverId: z.uuid(), reason: z.string().trim().max(300).default("") });

/** Reject one proposed pair for a load; the next feasible pair is proposed instead. Nothing is assigned or removed. */
export async function rejectRecommendation(input: z.input<typeof rejectInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = rejectInput.safeParse(input);
    if (!parsed.success) return fail("Invalid proposal.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("reject_dispatch_recommendation", { p_load_id: parsed.data.loadId, p_truck_id: parsed.data.truckId, p_driver_id: parsed.data.driverId, p_reason: parsed.data.reason });
    revalidateBoard();
    if (error) return fail(dbErrorMessage(error));
    return ok(undefined, "Rejected. The next option is proposed.");
  });
}

/** Consider a load's rejected pairs again. */
export async function reconsiderRecommendations(loadId: string): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    if (!z.uuid().safeParse(loadId).success) return fail("Invalid load.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("reconsider_dispatch_recommendations", { p_load_id: loadId });
    revalidateBoard();
    if (error) return fail(dbErrorMessage(error));
    return ok(undefined, "Rejected options will be proposed again.");
  });
}
