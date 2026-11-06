"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { OPERATIONAL_DATE_MESSAGE, isOperationalDate } from "@/lib/dates";
import { assertPermission, requireSignedIn } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Truck-day jobs (UX11, migration 20261120008600): how an order runs, planning N trucks for a day, and releasing a
// truck. The database checks every permission again (orders.edit, dispatch.edit, or the truck's own driver).

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Enter a valid time.");

function revalidateJob(orderId?: string) {
  revalidatePath("/dispatch");
  revalidatePath("/driver");
  revalidatePath("/command-center");
  if (orderId) {
    revalidatePath(`/orders/${orderId}`);
    revalidatePath(`/billing/orders/${orderId}`);
  }
}

const jobTypeInput = z.object({
  orderId: z.uuid("Invalid order."),
  jobType: z.enum(["loads", "truck_day"]),
  billing: z.enum(["tickets", "hours"]),
});

export async function setOrderJobType(input: z.input<typeof jobTypeInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("orders.edit");
    const parsed = jobTypeInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const { orderId, jobType, billing } = parsed.data;
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_order_job_type", { p_order: orderId, p_job_type: jobType, p_billing: jobType === "loads" ? "tickets" : billing });
    if (error) return fail(dbErrorMessage(error));
    revalidateJob(orderId);
    return ok(undefined, jobType === "truck_day" ? "This order now runs as trucks for the day." : "This order now runs as a set number of loads.");
  });
}

const planInput = z
  .object({
    orderId: z.uuid("Invalid order."),
    date: z.string().refine(isOperationalDate, OPERATIONAL_DATE_MESSAGE),
    trucks: z.coerce.number().int("Whole trucks only.").min(1, "At least 1 truck.").max(50, "At most 50 trucks."),
    startTime: time,
    endTime: time,
    note: z.string().trim().max(1000).default(""),
  })
  .superRefine((p, ctx) => {
    if (p.endTime <= p.startTime) ctx.addIssue({ code: "custom", message: "Must be after the start time.", path: ["endTime"] });
  });

export async function planTruckDay(input: z.input<typeof planInput>): Promise<ActionResult<{ count: number }>> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = planInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const p = parsed.data;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("truck_day_plan", { p_order: p.orderId, p_date: p.date, p_trucks: p.trucks, p_start: p.startTime, p_end: p.endTime, p_note: p.note });
    if (error) return fail(dbErrorMessage(error));
    revalidateJob(p.orderId);
    const count = (data as { count: number }).count;
    return ok({ count }, `${count} ${count === 1 ? "truck" : "trucks"} added for the day. Assign a truck and driver to each.`);
  });
}

const releaseInput = z.object({
  loadId: z.uuid("Invalid truck."),
  orderId: z.uuid().optional(),
  note: z.string().trim().max(300).default(""),
});

/** Dispatch, or the truck's own driver (the database decides which). */
export async function releaseTruck(input: z.input<typeof releaseInput>): Promise<ActionResult> {
  return guard(async () => {
    await requireSignedIn();
    const parsed = releaseInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("truck_day_release", { p_load: parsed.data.loadId, p_note: parsed.data.note });
    if (error) return fail(dbErrorMessage(error));
    revalidateJob(parsed.data.orderId);
    return ok(undefined, "Truck released.");
  });
}

const settingsInput = z.object({
  basis: z.enum(["", "scheduled", "arrived"]),
  minimum: z.string().trim().default("").refine((v) => v === "" || (/^\d{1,2}(\.\d{1,2})?$/.test(v) && Number(v) > 0 && Number(v) <= 24), "Above 0 and up to 24 hours, or empty."),
  shortfall: z.enum(["bill_minimum", "review"]),
});

export async function saveTruckHoursSettings(formData: FormData): Promise<void> {
  const back = "/settings?tab=invoicing";
  const go = (key: string, value: string): never => redirect(`${back}&${key}=${encodeURIComponent(value)}`);
  try {
    await assertPermission("billing.manage");
  } catch {
    go("error", "You do not have permission to change billing settings.");
  }
  const parsed = settingsInput.safeParse({ basis: formData.get("basis") ?? "", minimum: String(formData.get("minimum") ?? "").replace(",", "."), shortfall: formData.get("shortfall") ?? "review" });
  if (!parsed.success) go("error", parsed.error.issues[0]?.message ?? "Check the truck-hours settings.");
  const v = parsed.data!;
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_truck_hours_settings", { p_basis: v.basis || null, p_minimum: v.minimum ? Number(v.minimum) : null, p_shortfall: v.shortfall });
  if (error) go("error", dbErrorMessage(error));
  revalidatePath("/settings");
  go("saved", "invoicing");
}
