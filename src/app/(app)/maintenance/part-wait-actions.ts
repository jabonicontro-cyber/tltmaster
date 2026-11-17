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
import { businessToday } from "@/server/data/settings";
import { startJob } from "./crew-actions";

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
    // An optional note with "Waiting for parts" (WK1) goes on the status change in the job's history. With a note the
    // part is saved first and the job then moves with that note; the same submission key makes a retry safe (the part
    // is not added twice). Without a note the database does both in one step, as before.
    const note = setWaiting ? String(formData.get("note") ?? "").trim().slice(0, 2000) : "";
    const { error } = await supabase.rpc("part_wait_add", {
      p_work_order: workOrderId,
      p: { ...p, unit_cost_cents: unit_cost, set_waiting: setWaiting && !note, submission_key: uuid.safeParse(key).success ? key : null },
    });
    if (!error && note) {
      const moved = await supabase.rpc("maintenance_set_status", { p_id: workOrderId, p_status: "awaiting_parts", p_note: note, p_expected_seq: null });
      if (moved.error) {
        refresh(workOrderId);
        return fail(`The part on order is saved, but the job could not be set to Waiting for parts: ${dbErrorMessage(moved.error)}`);
      }
    }
    if (error && MISSING.has(error.code ?? "") && setWaiting) {
      const old = await supabase.rpc("maintenance_set_status", { p_id: workOrderId, p_status: "awaiting_parts", p_note: note ? `${p.description}: ${note}` : p.description, p_expected_seq: null });
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

export interface WaitingPart { id: string; description: string; quantity: number }

/**
 * The parts still on order for a job (walkthrough P11): "Waiting for parts" offers them instead of asking for the part
 * again, and "Part is in" receives them. Read with the person's own session (company rules apply); empty before the
 * update is installed.
 */
export async function waitingParts(workOrderId: string): Promise<ActionResult<WaitingPart[]>> {
  return guard(async () => {
    await assertPermission("maintenance.view");
    if (!uuid.safeParse(workOrderId).success) return fail("Invalid work order.");
    const { data, error } = await (await createClient()).from("work_order_part_waits")
      .select("id, description, quantity").eq("work_order_id", workOrderId).eq("status", "waiting").order("created_at");
    if (error) return MISSING.has(error.code ?? "") || error.code === "42P01" ? ok([]) : fail(dbErrorMessage(error));
    return ok((data ?? []).map((r) => ({ id: r.id as string, description: r.description as string, quantity: Number(r.quantity) })));
  }) as Promise<ActionResult<WaitingPart[]>>;
}

const waitOnOrderInput = z.object({ workOrderId: uuid, editSeq: z.number().int().nullable().default(null) });

/**
 * "Waiting for parts" for parts already on order (walkthrough P11): the job waits for them, and no second line is added
 * for the same part. The person's own running timer on the job is stopped first, as for any status change.
 */
export async function waitForPartsOnOrder(input: z.input<typeof waitOnOrderInput>): Promise<ActionResult> {
  return guard(async () => {
    const access = await assertPermission("maintenance.manage");
    const p = waitOnOrderInput.safeParse(input);
    if (!p.success) return fail("Invalid work order.");
    const id = p.data.workOrderId;
    const supabase = await createClient();
    const { data: rows, error: readError } = await supabase.from("work_order_part_waits").select("description").eq("work_order_id", id).eq("status", "waiting").order("created_at");
    if (readError) return fail(dbErrorMessage(readError));
    const names = (rows ?? []).map((r) => r.description as string);
    if (!names.length) return fail("No part is on order for this job. Say which part is missing.");
    const running = await supabase.from("work_order_time_entries").select("id").eq("work_order_id", id).eq("user_id", access.userId).is("ended_at", null).is("voided_at", null).maybeSingle();
    if (running.data) {
      const stop = await supabase.rpc("maintenance_stop_timer", { p_note: "" });
      if (stop.error) return fail(dbErrorMessage(stop.error));
    }
    const note = `Waiting for parts on order: ${names.join(", ")}`.slice(0, 2000);
    const { error } = await supabase.rpc("maintenance_set_status", { p_id: id, p_status: "awaiting_parts", p_note: note, p_expected_seq: p.data.editSeq });
    refresh(id);
    if (error) return fail(dbErrorMessage(error));
    return ok(undefined, `Waiting for parts.${running.data ? " Your timer is stopped." : ""}`);
  });
}

const partsInInput = z.object({
  workOrderId: uuid,
  waitIds: z.array(uuid).max(50),
  then: z.enum(["queue", "start"]),
  editSeq: z.number().int(),
});

/**
 * "Part is in" from the job's next step (walkthrough P11): the chosen parts on order are received through the same
 * database function as the Parts on order tab (part_wait_receive: stock, and the cost line when a price was recorded),
 * then the job goes back to the shop queue or starts again. A part already received is skipped, never received twice.
 */
export async function partsIn(input: z.input<typeof partsInInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const p = partsInInput.safeParse(input);
    if (!p.success) return fail("Invalid request.");
    const { workOrderId: id, waitIds, then, editSeq } = p.data;
    const supabase = await createClient();
    // Only this job's parts still on order: ids from the page are never trusted to belong to it.
    const { data: rows, error: readError } = waitIds.length
      ? await supabase.from("work_order_part_waits").select("id, description").eq("work_order_id", id).eq("status", "waiting").in("id", waitIds)
      : { data: [], error: null };
    if (readError) return fail(dbErrorMessage(readError));
    const received: string[] = [];
    for (const r of rows ?? []) {
      const { error } = await supabase.rpc("part_wait_receive", { p_wait: r.id, p_to_queue: false });
      if (error) {
        refresh(id);
        return fail(`${received.length ? `Received: ${received.join(", ")}. ` : ""}${r.description as string} could not be marked received: ${dbErrorMessage(error)}`);
      }
      received.push(r.description as string);
    }
    const got = received.length ? `Part received: ${received.join(", ")}. ` : "";
    if (then === "start") {
      const started = await startJob({ workOrderId: id, editSeq });
      refresh(id);
      return started.ok ? ok(undefined, `${got}${started.message ?? "Job started."}`) : fail(`${got}${started.error}`);
    }
    const { data: wo } = await supabase.from("work_orders").select("scheduled_for").eq("id", id).maybeSingle();
    const { today } = await businessToday();
    const scheduled = (wo as { scheduled_for: string | null } | null)?.scheduled_for;
    const to = scheduled && scheduled >= today ? "scheduled" : "triaged";
    const { error } = await supabase.rpc("maintenance_set_status", { p_id: id, p_status: to, p_note: "Parts are in.", p_expected_seq: editSeq });
    refresh(id);
    if (error) return fail(`${got}${dbErrorMessage(error)}`);
    return ok(undefined, `${got}The job is back in the shop queue.`);
  });
}
