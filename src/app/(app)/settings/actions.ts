"use server";

import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { companySettingsSchema, inviteSchema, sequenceSchema, userAccessSchema } from "@/lib/schemas/settings";
import { uuid } from "@/lib/schemas/common";
import { PERMISSIONS, ROLES, type AppRole } from "@/lib/permissions";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";
import { env } from "@/server/env";

export async function saveCompanySettings(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const access = await assertPermission("settings.manage");
    const parsed = companySettingsSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.from("company_settings").update({ ...parsed.data, updated_by: access.userId }).eq("id", true).select("id");
    if (error) return fail(dbErrorMessage(error));
    if (!data?.length) return fail("Settings could not be saved.");
    revalidatePath("/", "layout");
    return ok(undefined, "Company settings saved. Quotes already sent keep the details they were sent with.");
  });
}

export async function saveSequence(key: string, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("settings.manage");
    if (!["customer", "quote", "order", "ticket"].includes(key)) return fail("Unknown sequence.");
    const parsed = sequenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.from("document_sequences").update(parsed.data).eq("key", key);
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    return ok(undefined, "Numbering saved. If a number is already taken, saving that document will be refused rather than duplicated.");
  });
}

export async function updateUserAccess(userId: string, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("users.manage");
    if (!uuid.safeParse(userId).success) return fail("Invalid user.");
    const parsed = userAccessSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_user_access", {
      p_user_id: userId,
      p_role: parsed.data.role,
      p_active: parsed.data.active,
      p_full_name: parsed.data.full_name,
    });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    return ok(undefined, "User updated.");
  });
}

export async function inviteUser(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const access = await assertPermission("users.manage");
    const parsed = inviteSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    if (!adminAvailable()) {
      return fail("Inviting users needs SUPABASE_SERVICE_ROLE_KEY on the server. Until then, add users in the Supabase dashboard (Authentication → Users) and assign their role here.");
    }
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.inviteUserByEmail(parsed.data.email, {
      data: { full_name: parsed.data.full_name },
      redirectTo: `${env().APP_BASE_URL}/auth/confirm?next=/update-password`,
    });
    if (error) {
      return fail(/already/i.test(error.message) ? "A user with this email already exists. Change their role in the list below." : `The invitation could not be sent: ${error.message}`);
    }
    // The role is set through the normal permission-checked function, as the inviting owner.
    const supabase = await createClient();
    const { error: roleErr } = await supabase.rpc("set_user_access", {
      p_user_id: data.user.id,
      p_role: parsed.data.role,
      p_active: true,
      p_full_name: parsed.data.full_name,
    });
    revalidatePath("/settings");
    if (roleErr) return fail(`Invitation sent, but the role could not be set: ${dbErrorMessage(roleErr)} Set it in the user list.`);
    console.info("User invited", { by: access.userId, user: data.user.id });
    return ok(undefined, `Invitation sent to ${parsed.data.email}.`);
  });
}

export async function setRolePermission(role: string, permission: string, granted: boolean): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("users.manage");
    if (!(ROLES as readonly string[]).includes(role) || !(PERMISSIONS as readonly string[]).includes(permission)) return fail("Invalid permission.");
    if ((role as AppRole) === "owner") return fail("Owner permissions cannot be changed.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_role_permission", { p_role: role, p_permission: permission, p_granted: granted });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    return ok(undefined, granted ? "Permission granted." : "Permission removed.");
  });
}

export async function removeSampleData(): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("settings.manage");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("remove_sample_data");
    if (error) return fail(dbErrorMessage(error));
    const r = data as { quotes: number; customers: number; materials: number; charge_items: number; price_lists: number; deactivated_in_use: number };
    revalidatePath("/", "layout");
    return ok(
      undefined,
      `Removed ${r.quotes} quotes, ${r.customers} customers, ${r.materials} materials, ${r.charge_items} charges and ${r.price_lists} price lists.` +
        (r.deactivated_in_use ? ` ${r.deactivated_in_use} sample records used by real quotes were deactivated instead.` : ""),
    );
  });
}
