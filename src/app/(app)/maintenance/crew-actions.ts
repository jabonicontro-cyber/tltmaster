"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isIsoDate, zonedTimeToUtc } from "@/lib/dates";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Crew, time and checklist changes on a work order (migration 20261120002900). Each calls one database function that
// checks maintenance.manage, the company, the work order's state and the overlap rules again.

const refresh = (id?: string) => {
  revalidatePath("/maintenance", "layout");
  if (id) revalidatePath(`/maintenance/work-orders/${id}`);
};

async function call(fn: string, args: Record<string, unknown>, workOrderId: string | undefined, message: string): Promise<ActionResult> {
  await assertPermission("maintenance.manage");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return fail(dbErrorMessage(error));
  refresh(workOrderId ?? (typeof data === "string" ? data : undefined));
  return ok(undefined, message);
}

const woId = z.object({ workOrderId: uuid });

export async function addMechanic(input: { workOrderId: string; userId: string; lead?: boolean }): Promise<ActionResult> {
  return guard(async () => {
    const p = woId.extend({ userId: uuid, lead: z.boolean().default(false) }).safeParse(input);
    if (!p.success) return fail("Choose a mechanic.");
    return call("maintenance_add_mechanic", { p_wo: p.data.workOrderId, p_user: p.data.userId, p_lead: p.data.lead }, p.data.workOrderId, p.data.lead ? "Lead mechanic set." : "Mechanic added.");
  });
}

export async function removeMechanic(input: { workOrderId: string; userId: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = woId.extend({ userId: uuid }).safeParse(input);
    if (!p.success) return fail("Invalid mechanic.");
    return call("maintenance_remove_mechanic", { p_wo: p.data.workOrderId, p_user: p.data.userId }, p.data.workOrderId, "Removed from the crew. Their logged time stays on the work order.");
  });
}

export async function setMyStatus(input: { workOrderId: string; status: "assigned" | "paused" | "done" }): Promise<ActionResult> {
  return guard(async () => {
    const p = woId.extend({ status: z.enum(["assigned", "paused", "done"]) }).safeParse(input);
    if (!p.success) return fail("Invalid status.");
    return call("maintenance_set_my_status", { p_wo: p.data.workOrderId, p_status: p.data.status }, p.data.workOrderId, p.data.status === "done" ? "Marked your part done." : "Status updated.");
  });
}

export async function startTimer(input: { workOrderId: string; note?: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = woId.extend({ note: z.string().trim().max(500).default("") }).safeParse(input);
    if (!p.success) return fail("Invalid work order.");
    return call("maintenance_start_timer", { p_wo: p.data.workOrderId, p_note: p.data.note }, p.data.workOrderId, "Timer started.");
  });
}

export async function stopTimer(input: { note?: string } = {}): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ note: z.string().trim().max(500).default("") }).safeParse(input);
    if (!p.success) return fail("The note is too long.");
    return call("maintenance_stop_timer", { p_note: p.data.note }, undefined, "Timer stopped.");
  });
}

const timeInput = woId.extend({
  userId: uuid,
  date: z.string().refine(isIsoDate, "Enter a date."),
  start: z.string().regex(/^\d{2}:\d{2}$/, "Enter a start time."),
  end: z.string().regex(/^\d{2}:\d{2}$/, "Enter an end time."),
  note: z.string().trim().max(500).default(""),
});

/** Time logged after the fact, in the company's time zone. An end before the start means it ran past midnight. */
export async function addTime(input: z.input<typeof timeInput>): Promise<ActionResult> {
  return guard(async () => {
    const p = timeInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the time.");
    const { timezone } = await businessToday();
    const started = zonedTimeToUtc(p.data.date, p.data.start, timezone);
    let ended = zonedTimeToUtc(p.data.date, p.data.end, timezone);
    if (!started || !ended) return fail("Check the date and times.");
    if (Date.parse(ended) <= Date.parse(started)) ended = new Date(Date.parse(ended) + 86400000).toISOString();
    return call("maintenance_add_time", { p_wo: p.data.workOrderId, p_user: p.data.userId, p_started: started, p_ended: ended, p_note: p.data.note }, p.data.workOrderId, "Time logged.");
  });
}

export async function voidTime(input: { workOrderId: string; entryId: string; reason: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = woId.extend({ entryId: uuid, reason: z.string().trim().min(3, "Say why this time is being removed.").max(300) }).safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Say why.");
    return call("maintenance_void_time", { p_entry: p.data.entryId, p_reason: p.data.reason }, p.data.workOrderId, "Time entry removed. It stays in the history.");
  });
}

export async function addTask(input: { workOrderId: string; title: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = woId.extend({ title: z.string().trim().min(2, "Describe the task.").max(200) }).safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Describe the task.");
    return call("maintenance_add_task", { p_wo: p.data.workOrderId, p_title: p.data.title }, p.data.workOrderId, "Task added.");
  });
}

export async function setTask(input: { workOrderId: string; taskId: string; status: "open" | "done" | "skipped" }): Promise<ActionResult> {
  return guard(async () => {
    const p = woId.extend({ taskId: uuid, status: z.enum(["open", "done", "skipped"]) }).safeParse(input);
    if (!p.success) return fail("Invalid task.");
    return call("maintenance_set_task", { p_task: p.data.taskId, p_status: p.data.status }, p.data.workOrderId, "Task updated.");
  });
}

const shopInput = z.object({
  bays: z.coerce.number().int().min(1, "Enter at least 1 bay.").max(100),
  shiftStart: z.string().regex(/^\d{2}:\d{2}$/, "Enter the shift start."),
  shiftEnd: z.string().regex(/^\d{2}:\d{2}$/, "Enter the shift end."),
  workDays: z.array(z.coerce.number().int().min(1).max(7)).min(1, "Choose at least one working day."),
});

/** Shop bays, shift and working days (20261120003000). */
export async function saveShop(input: z.input<typeof shopInput>): Promise<ActionResult> {
  return guard(async () => {
    const p = shopInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the shop settings.");
    return call("maintenance_save_shop", { p_bays: p.data.bays, p_shift_start: p.data.shiftStart, p_shift_end: p.data.shiftEnd, p_work_days: p.data.workDays }, undefined, "Shop settings saved.");
  });
}

const CATEGORIES = ["preventive", "repair", "inspection", "brakes", "tires", "engine", "electrical", "hydraulics", "body", "other"] as const;

export async function saveSkills(input: { userId: string; categories: string[] }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ userId: uuid, categories: z.array(z.enum(CATEGORIES)) }).safeParse(input);
    if (!p.success) return fail("Invalid skills.");
    return call("maintenance_set_skills", { p_user: p.data.userId, p_categories: p.data.categories }, undefined, "Skills saved.");
  });
}

export async function setEstimate(input: { workOrderId: string; hours: string }): Promise<ActionResult> {
  return guard(async () => {
    const raw = input.hours.trim();
    const hours = raw === "" ? null : Number(raw);
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 1000)) return fail("Enter hours between 0 and 1,000, or leave it empty.");
    const p = woId.safeParse(input);
    if (!p.success) return fail("Invalid work order.");
    return call("maintenance_set_estimate", { p_wo: p.data.workOrderId, p_hours: hours }, p.data.workOrderId, hours === null ? "Estimate cleared." : "Estimate saved.");
  });
}

/**
 * Suggest triage for a work order with the deterministic rules (src/lib/maintenance-triage.ts). The report itself is
 * read from the database, never from the browser. AI triage is not connected: it would need its own capability,
 * evaluation and switch (docs/AI.md) and would be labelled as AI.
 */
export async function suggestTriage(input: { workOrderId: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = woId.safeParse(input);
    if (!p.success) return fail("Invalid work order.");
    await assertPermission("maintenance.manage");
    const supabase = await createClient();
    const { data: wo, error } = await supabase.from("work_orders").select("id, title, description, truck_id, trailer_id").eq("id", p.data.workOrderId).maybeSingle();
    if (error || !wo) return fail("Work order not found.");
    const w = wo as { id: string; title: string; description: string; truck_id: string | null; trailer_id: string | null };
    let others = supabase.from("work_orders").select("id, number, title, category").neq("id", w.id).not("status", "in", "(completed,closed,canceled)").limit(20);
    others = w.trailer_id ? others.eq("trailer_id", w.trailer_id) : others.eq("truck_id", w.truck_id ?? "");
    const { triageRules } = await import("@/lib/maintenance-triage");
    const suggestion = triageRules({ title: w.title, description: w.description, openOnUnit: ((await others).data ?? []) as Array<{ id: string; number: string; title: string; category: string }> });
    return call("maintenance_save_triage", { p_wo: w.id, p_source: "rules", p_model: "", p_suggestion: suggestion }, w.id, "Triage suggested. Check it before accepting.");
  });
}

const decideInput = z.object({
  workOrderId: uuid,
  triageId: uuid,
  decision: z.enum(["accepted", "edited", "rejected"]),
  category: z.string().optional(),
  urgency: z.string().optional(),
  safety: z.boolean().optional(),
  note: z.string().trim().max(1000).default(""),
});

export async function decideTriage(input: z.input<typeof decideInput>): Promise<ActionResult> {
  return guard(async () => {
    const p = decideInput.safeParse(input);
    if (!p.success) return fail("Invalid decision.");
    const d = p.data;
    return call("maintenance_decide_triage", {
      p_triage: d.triageId, p_decision: d.decision, p_category: d.category ?? null, p_urgency: d.urgency ?? null, p_safety: d.safety ?? null, p_note: d.note,
    }, d.workOrderId, d.decision === "rejected" ? "Suggestion rejected." : d.decision === "edited" ? "Your changes were applied." : "Suggestion accepted.");
  });
}
