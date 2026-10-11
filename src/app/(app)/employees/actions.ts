"use server";

import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { compensationSchema, employeeSchema } from "@/lib/employees";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

/** Add or edit an employee record (employees.edit). Roles and sign-in access are not touched here. */
export async function saveEmployee(id: string | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await assertPermission("employees.edit");
    if (id && !uuid.safeParse(id).success) return fail("Invalid employee.");
    const parsed = employeeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const res = id
      ? await supabase.from("employees").update(parsed.data).eq("id", id).select("id")
      : await supabase.from("employees").insert(parsed.data).select("id");
    if (res.error) return fail(dbErrorMessage(res.error));
    if (!res.data?.length) return fail("The employee could not be saved (not found or not permitted).");
    revalidatePath("/employees");
    return ok({ id: res.data[0].id as string }, id ? "Employee saved." : "Employee added.");
  });
}

/** Confidential pay details (employees.compensation). */
export async function saveCompensation(employeeId: string, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("employees.compensation");
    if (!uuid.safeParse(employeeId).success) return fail("Invalid employee.");
    const parsed = compensationSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const p = parsed.data;
    const supabase = await createClient();
    const { error } = await supabase.from("employee_compensation").upsert({
      employee_id: employeeId,
      pay_type: p.pay_type,
      rate_cents: p.pay_type === "percentage" ? null : p.rate,
      rate_percent: p.pay_type === "percentage" ? p.rate_percent : null,
      effective_date: p.effective_date,
      notes: p.notes,
    });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/employees/${employeeId}`);
    return ok(undefined, "Pay details saved.");
  });
}

/** A driver's primary truck (fleet.assign). Null clears it (the truck becomes unassigned). */
export async function setPrimaryTruck(employeeId: string, driverId: string, truckId: string | null): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.assign");
    if (!uuid.safeParse(driverId).success || (truckId && !uuid.safeParse(truckId).success)) return fail("Invalid selection.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_driver_primary_truck", { p_driver_id: driverId, p_truck_id: truckId });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/employees/${employeeId}`);
    revalidatePath("/employees");
    return ok(undefined, truckId ? "Primary truck set." : "Primary truck removed.");
  });
}
