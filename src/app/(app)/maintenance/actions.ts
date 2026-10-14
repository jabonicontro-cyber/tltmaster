"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { costSchema, readingSchema, scheduleSchema, workOrderEditSchema, workOrderSchema, WO_STATUSES } from "@/lib/maintenance";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Every write goes through a database function that checks the permission,
// the company and the lifecycle again; these actions validate input and
// translate errors.

function refresh(id?: string) {
  revalidatePath("/maintenance", "layout");
  if (id) revalidatePath(`/maintenance/work-orders/${id}`);
}

/** Create a work order (maintenance.manage). A repeated submit with the same key returns the first one. */
export async function createWorkOrder(formData: FormData): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const parsed = workOrderSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("maintenance_create_work_order", { p: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { id: string; number: string; duplicate: boolean };
    refresh(r.id);
    return ok({ id: r.id }, r.duplicate ? `Work order ${r.number} was already created.` : `Work order ${r.number} created.`);
  });
}

/** Edit details, findings, labor hours, schedule and assignment (maintenance.manage). */
export async function updateWorkOrder(id: string, formData: FormData): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    if (!uuid.safeParse(id).success) return fail("Invalid work order.");
    const parsed = workOrderEditSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const { edit_seq, ...p } = parsed.data;
    const supabase = await createClient();
    const { error } = await supabase.rpc("maintenance_update_work_order", { p_id: id, p_expected_seq: edit_seq, p });
    if (error) return fail(dbErrorMessage(error));
    refresh(id);
    return ok({ id }, "Work order saved.");
  });
}

const statusInput = z.object({
  id: uuid,
  status: z.enum(Object.keys(WO_STATUSES) as [keyof typeof WO_STATUSES, ...(keyof typeof WO_STATUSES)[]]),
  note: z.string().trim().max(2000).default(""),
  editSeq: z.number().int(),
});

/** Move along the lifecycle (maintenance.manage). The database refuses invalid transitions. */
export async function setWorkOrderStatus(input: z.input<typeof statusInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const parsed = statusInput.safeParse(input);
    if (!parsed.success) return fail("Invalid request.");
    const { id, status, note, editSeq } = parsed.data;
    const supabase = await createClient();
    const { error } = await supabase.rpc("maintenance_set_status", { p_id: id, p_status: status, p_note: note, p_expected_seq: editSeq });
    if (error) return fail(dbErrorMessage(error));
    refresh(id);
    return ok(undefined, `Status: ${WO_STATUSES[status]}.`);
  });
}

/** Start the inspection (maintenance.clear). */
export async function startInspection(id: string): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.clear");
    if (!uuid.safeParse(id).success) return fail("Invalid work order.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("maintenance_start_inspection", { p_id: id });
    if (error) return fail(dbErrorMessage(error));
    refresh(id);
    return ok(undefined, "Inspection started.");
  });
}

const clearanceInput = z.object({ id: uuid, outcome: z.enum(["passed", "failed"]), notes: z.string().trim().max(2000).default("") });

/** Record the inspection result (maintenance.clear). Passed completes the repair and may return the truck or trailer to service. */
export async function recordClearance(input: z.input<typeof clearanceInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.clear");
    const parsed = clearanceInput.safeParse(input);
    if (!parsed.success) return fail("Invalid request.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("maintenance_record_clearance", { p_id: parsed.data.id, p_outcome: parsed.data.outcome, p_notes: parsed.data.notes });
    if (error) return fail(dbErrorMessage(error));
    refresh(parsed.data.id);
    revalidatePath("/fleet", "layout");
    const r = data as { returned_to_service: boolean };
    const { data: wo } = await supabase.from("work_orders").select("*").eq("id", parsed.data.id).maybeSingle();
    const unit = (wo as { trailer_id?: string | null } | null)?.trailer_id ? "trailer" : "truck";
    return ok(undefined, parsed.data.outcome === "failed"
      ? "Inspection failed — the work order is back in progress."
      : r.returned_to_service ? `Cleared. The ${unit} is back in service.` : `Cleared. The ${unit} stays out of service (another restriction remains).`);
  });
}

/** Add a cost line (maintenance.costs). */
export async function addCost(workOrderId: string, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.costs");
    if (!uuid.safeParse(workOrderId).success) return fail("Invalid work order.");
    const parsed = costSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const { unit_cost, ...rest } = parsed.data;
    const supabase = await createClient();
    const { error } = await supabase.from("work_order_costs").insert({ ...rest, unit_cost_cents: unit_cost, work_order_id: workOrderId });
    if (error) return fail(dbErrorMessage(error));
    refresh(workOrderId);
    return ok(undefined, "Cost added.");
  });
}

export async function removeCost(workOrderId: string, costId: string): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.costs");
    if (!uuid.safeParse(workOrderId).success || !uuid.safeParse(costId).success) return fail("Invalid cost line.");
    const supabase = await createClient();
    const { data, error } = await supabase.from("work_order_costs").delete().eq("id", costId).eq("work_order_id", workOrderId).select("id");
    if (error) return fail(dbErrorMessage(error));
    if (!data?.length) return fail("The cost line was not found.");
    refresh(workOrderId);
    return ok(undefined, "Cost removed.");
  });
}

/** Create or edit a preventive schedule (maintenance.manage). */
export async function saveSchedule(formData: FormData): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const parsed = scheduleSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("maintenance_save_schedule", { p: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok({ id: data as string }, parsed.data.id ? "Schedule saved." : "Schedule added.");
  });
}

/** Record an odometer / engine-hour reading (maintenance.manage). */
export async function recordReading(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const parsed = readingSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const p = parsed.data;
    const supabase = await createClient();
    const { error } = await supabase.rpc("record_truck_reading", { p_truck_id: p.truck_id, p_miles: p.odometer_miles, p_hours: p.engine_hours, p_note: p.note });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Reading recorded.");
  });
}

/** Create work orders for due preventive schedules (maintenance.manage). Running it twice creates nothing new. */
export async function generateDueWorkOrders(): Promise<ActionResult<{ created: number }>> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("maintenance_generate_due");
    if (error) return fail(dbErrorMessage(error));
    const n = Number(data ?? 0);
    refresh();
    return ok({ created: n }, n === 0 ? "No new work orders: every due service already has one." : `${n} work order${n === 1 ? "" : "s"} created.`);
  });
}
