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

/**
 * Link an employee record to a login of this company, or unlink it (userId null). Needs employees.edit;
 * the database guarantees the login is a member of the same company (foreign key) and is linked to at most
 * one employee (unique index). When the employee is a driver, the driver record follows, so the driver
 * portal (My Day) works for that login.
 */
export async function linkEmployeeLogin(employeeId: string, userId: string | null): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("employees.edit");
    if (!uuid.safeParse(employeeId).success || (userId !== null && !uuid.safeParse(userId).success)) return fail("Invalid request.");
    const supabase = await createClient();
    const { data: before } = await supabase.from("employees").select("user_id, driver_id").eq("id", employeeId).maybeSingle();
    if (!before) return fail("Employee not found.");
    const res = await supabase.from("employees").update({ user_id: userId }).eq("id", employeeId).select("id");
    if (res.error) {
      if (res.error.code === "23505") return fail("That login is already linked to another employee. Unlink it there first.");
      if (res.error.code === "23503") return fail("That login is not a member of this company.");
      return fail(dbErrorMessage(res.error));
    }
    if (!res.data?.length) return fail("The employee could not be changed (not found or not permitted).");
    let note = "";
    const driverId = (before as { driver_id: string | null }).driver_id;
    if (driverId) {
      const previous = (before as { user_id: string | null }).user_id;
      const d = userId
        ? await supabase.from("drivers").update({ user_id: userId }).eq("id", driverId).select("id")
        : previous
          ? await supabase.from("drivers").update({ user_id: null }).eq("id", driverId).eq("user_id", previous).select("id")
          : { data: [], error: null };
      if (d.error) note = d.error.code === "23505"
        ? " The driver record could not follow: that login is already linked to another driver."
        : " The driver record could not be updated with your permissions; ask an owner to link it in Fleet.";
    }
    revalidatePath("/employees", "layout");
    return ok(undefined, (userId ? "Login linked." : "Login unlinked.") + note);
  });
}
