"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isIsoDate } from "@/lib/dates";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Schedule changes (migration 20261120003300). Each calls one database function that checks schedules.manage, the
// company and the input again; every change is recorded in schedule_events.

const date = z.string().refine(isIsoDate, "Choose a valid date.");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 06:00.");

async function call(fn: string, args: Record<string, unknown>, message: string): Promise<ActionResult> {
  await assertPermission("schedules.manage");
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, args);
  if (error) return fail(dbErrorMessage(error));
  revalidatePath("/schedule");
  revalidatePath("/dispatch", "layout");
  return ok(undefined, message);
}

const dayInput = z.object({
  employeeId: uuid,
  date,
  kind: z.enum(["shift", "off"]),
  start: time.optional(),
  end: time.optional(),
  breakMinutes: z.coerce.number().int().min(0).max(240).default(0),
  reason: z.string().trim().max(300).default(""),
});

export async function setScheduleDay(input: z.input<typeof dayInput>): Promise<ActionResult> {
  return guard(async () => {
    const p = dayInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the shift.");
    const d = p.data;
    if (d.kind === "shift" && (!d.start || !d.end || d.start === d.end)) return fail("A shift needs a start and an end time.");
    return call("schedule_set_day", { p_employee: d.employeeId, p_date: d.date, p_kind: d.kind, p_start: d.kind === "shift" ? d.start : null, p_end: d.kind === "shift" ? d.end : null, p_break: d.breakMinutes, p_reason: d.reason },
      d.kind === "off" ? "Day off saved." : "Shift saved.");
  });
}

export async function clearScheduleDay(input: { employeeId: string; date: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ employeeId: uuid, date }).safeParse(input);
    if (!p.success) return fail("Invalid day.");
    return call("schedule_clear_day", { p_employee: p.data.employeeId, p_date: p.data.date }, "Back to the regular schedule.");
  });
}

const patternInput = z.object({
  employeeId: uuid,
  kind: z.enum(["weekly", "rotation"]),
  cycleDays: z.coerce.number().int().min(1).max(56).default(7),
  anchor: date.optional(),
  from: date,
  note: z.string().trim().max(300).default(""),
  days: z.array(z.object({ day: z.number().int().min(0).max(55), start: time, end: time, breakMinutes: z.coerce.number().int().min(0).max(240).default(0) })).min(1, "Add at least one working day."),
});

export async function setSchedulePattern(input: z.input<typeof patternInput>): Promise<ActionResult> {
  return guard(async () => {
    const p = patternInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the schedule.");
    const d = p.data;
    if (d.days.some((x) => x.start === x.end)) return fail("Each shift needs a different start and end time.");
    return call("schedule_set_pattern", {
      p_employee: d.employeeId, p_kind: d.kind, p_cycle_days: d.kind === "weekly" ? 7 : d.cycleDays, p_anchor: d.kind === "rotation" ? (d.anchor ?? d.from) : null,
      p_effective_from: d.from, p_days: d.days.map((x) => ({ day: x.day, start: x.start, end: x.end, break: x.breakMinutes })), p_note: d.note,
    }, "Schedule saved.");
  });
}

export async function endSchedulePattern(input: { employeeId: string; lastDay: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ employeeId: uuid, lastDay: date }).safeParse(input);
    if (!p.success) return fail("Choose the last day.");
    return call("schedule_end_pattern", { p_employee: p.data.employeeId, p_last_day: p.data.lastDay }, "Repeating schedule ended.");
  });
}
