"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isOperationalDate } from "@/lib/dates";
import { partWaitSchema } from "@/lib/maintenance/parts-waiting";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Parts on order (20261120012300). Each action checks maintenance.manage here and calls one database function that
// checks the permission, the company and the work order again. Stock and costs change only through the parts ledger
// and cost lines, inside those functions.

const MISSING = new Set(["42883", "PGRST202"]);
/** A job nobody started yet: the unit is still in service (a part on order does not park it). */
const NOT_STARTED = ["reported", "triaged", "scheduled"];

function refresh(workOrderId: string) {
  revalidatePath("/maintenance", "layout");
  revalidatePath(`/maintenance/work-orders/${workOrderId}`);
}

/**
 * Add a part on order. With setWaiting the job also moves to "Waiting for parts" (from reported, triaged, scheduled or
 * in progress); the person's own running timer on the job is stopped first, as for any status change. Before the
 * update is installed, "Waiting for parts" still works and the part is named in the status note.
 */
export async function addPartWait(workOrderId: string, setWaiting: boolean, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const access = await assertPermission("maintenance.manage");
    if (!uuid.safeParse(workOrderId).success) return fail("Invalid work order.");
    const parsed = partWaitSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const { unit_cost, ...p } = parsed.data;
    const supabase = await createClient();
    let stopped = false;
    if (setWaiting) {
      const running = await supabase.from("work_order_time_entries").select("id").eq("work_order_id", workOrderId).eq("user_id", access.userId).is("ended_at", null).is("voided_at", null).maybeSingle();
      if (running.data) {
        const stop = await supabase.rpc("maintenance_stop_timer", { p_note: "" });
        if (stop.error) return fail(dbErrorMessage(stop.error));
        stopped = true;
      }
    }
    const key = String(formData.get("submission_key") ?? "");
    const { error } = await supabase.rpc("part_wait_add", {
      p_work_order: workOrderId,
      p: { ...p, unit_cost_cents: unit_cost, set_waiting: setWaiting, submission_key: uuid.safeParse(key).success ? key : null },
    });
    if (error && MISSING.has(error.code ?? "") && setWaiting) {
      const old = await supabase.rpc("maintenance_set_status", { p_id: workOrderId, p_status: "awaiting_parts", p_note: p.description, p_expected_seq: null });
      if (old.error) return fail(dbErrorMessage(old.error));
      refresh(workOrderId);
      return ok(undefined, `Waiting for parts.${stopped ? " Your timer is stopped." : ""}`);
    }
    if (error) {
      if (stopped) refresh(workOrderId);
      return fail(stopped ? `Your timer is stopped. ${dbErrorMessage(error)}` : dbErrorMessage(error));
    }
    refresh(workOrderId);
    // A part for a job not started: the unit keeps working until the job starts (owner 2026-11-09, MD1), said here.
    let running = "";
    if (!setWaiting) {
      const { data: w } = await supabase.from("work_orders").select("status, trucks(unit_number), trailers(unit_number)").eq("id", workOrderId).maybeSingle();
      const row = w as { status: string; trucks: { unit_number: string } | null; trailers: { unit_number: string } | null } | null;
      if (row && NOT_STARTED.includes(row.status)) {
        const unit = row.trucks?.unit_number ? `Truck ${row.trucks.unit_number}` : row.trailers?.unit_number ? `Trailer ${row.trailers.unit_number}` : null;
        if (unit) running = ` ${unit} keeps running until you start the job.`;
      }
    }
    return ok(undefined, `${setWaiting ? "Waiting for parts. " : ""}Part on order saved.${running}${stopped ? " Your timer is stopped." : ""}`);
  });
}

const receiveInput = z.object({ id: uuid, workOrderId: uuid, toQueue: z.boolean() });

/** The part is in: received through the parts ledger or as a cost line; optionally the job goes back to the queue. */
export async function receivePartWait(input: z.input<typeof receiveInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const p = receiveInput.safeParse(input);
    if (!p.success) return fail("Invalid request.");
    const { data, error } = await (await createClient()).rpc("part_wait_receive", { p_wait: p.data.id, p_to_queue: p.data.toQueue });
    if (error) return fail(dbErrorMessage(error));
    refresh(p.data.workOrderId);
    const r = data as { waiting: number; status: string };
    if (r.waiting > 0) return ok(undefined, `Part received. ${r.waiting} more ${r.waiting === 1 ? "part is" : "parts are"} still on order.`);
    if (r.status === "triaged" || r.status === "scheduled") return ok(undefined, "Part received. The job is back in the shop queue.");
    return ok(undefined, "Part received.");
  });
}

const cancelInput = z.object({ id: uuid, workOrderId: uuid, reason: z.string().trim().min(2, "Say why the part is no longer on order.").max(300) });

export async function cancelPartWait(input: z.input<typeof cancelInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const p = cancelInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Invalid request.");
    const { error } = await (await createClient()).rpc("part_wait_cancel", { p_wait: p.data.id, p_reason: p.data.reason });
    if (error) return fail(dbErrorMessage(error));
    refresh(p.data.workOrderId);
    return ok(undefined, "No longer on order.");
  });
}

const dateInput = z.object({ id: uuid, workOrderId: uuid, expectedOn: z.string().trim().refine((v) => v === "" || isOperationalDate(v), "Enter a full date.") });

/** The vendor moved the delivery: a new expected date (empty removes it). */
export async function setPartWaitDate(input: z.input<typeof dateInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const p = dateInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Invalid request.");
    const { error } = await (await createClient()).rpc("part_wait_update", { p_wait: p.data.id, p: { expected_on: p.data.expectedOn } });
    if (error) return fail(dbErrorMessage(error));
    refresh(p.data.workOrderId);
    return ok(undefined, "Expected date saved.");
  });
}
