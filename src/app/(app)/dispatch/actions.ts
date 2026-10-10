"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isIsoDate } from "@/lib/dates";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

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
    loadDate: z.string().refine(isIsoDate, "Enter a valid date."),
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
