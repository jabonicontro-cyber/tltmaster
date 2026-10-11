"use server";

import { revalidatePath } from "next/cache";
import { MAX_LOGO_BYTES, brandingProblems, sniffImage } from "@/lib/branding";
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
    const { data, error } = await supabase.from("company_settings").update({ ...parsed.data, updated_by: access.userId }).eq("company_id", access.companyId!).select("company_id");
    if (error) return fail(dbErrorMessage(error));
    if (!data?.length) return fail("Settings could not be saved.");
    revalidatePath("/", "layout");
    return ok(undefined, "Company settings saved. Quotes already sent keep the details they were sent with.");
  });
}

export async function saveSequence(key: string, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("settings.manage");
    if (!["customer", "quote", "order", "ticket", "billing"].includes(key)) return fail("Unknown sequence.");
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
    if (access.isDemo) return fail("Invitations are turned off in the demo company: it never sends email to anyone.");
    const parsed = inviteSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    if (parsed.data.role === "owner" && access.role !== "owner") return fail("Only an owner can add another owner.");
    const supabase = await createClient();

    // Someone who already has an account (for example in another company) is
    // added to this company directly — no second account, no new password.
    const existing = await supabase.rpc("add_existing_member", {
      p_email: parsed.data.email,
      p_role: parsed.data.role,
      p_full_name: parsed.data.full_name,
    });
    if (existing.error) return fail(dbErrorMessage(existing.error));
    const found = existing.data as { found: boolean; already?: boolean };
    if (found.found) {
      revalidatePath("/settings");
      return ok(
        undefined,
        found.already
          ? `${parsed.data.email} is already a member of your company.`
          : `${parsed.data.email} already has an account and was added to your company. They can switch to it from the account menu after signing in.`,
      );
    }

    if (!adminAvailable()) {
      return fail("Inviting users needs SUPABASE_SERVICE_ROLE_KEY on the server. Until then, add users in the Supabase dashboard (Authentication → Users) and assign their role here.");
    }
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.inviteUserByEmail(parsed.data.email, {
      data: { full_name: parsed.data.full_name },
      redirectTo: `${env().APP_BASE_URL}/auth/confirm?next=/update-password`,
    });
    if (error) {
      return fail(/already/i.test(error.message) ? "An account with this email was just created. Try the invitation again." : `The invitation could not be sent: ${error.message}`);
    }
    // Membership in the inviter's company is created by the permission-checked
    // database function, running as the inviting user (never the service role).
    const { error: roleErr } = await supabase.rpc("add_company_member", {
      p_user_id: data.user.id,
      p_role: parsed.data.role,
      p_full_name: parsed.data.full_name,
    });
    revalidatePath("/settings");
    if (roleErr) return fail(`Invitation sent, but the user could not be added to your company: ${dbErrorMessage(roleErr)}`);
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
    const r = data as { quotes: number; direct_orders: number; customers: number; materials: number; charge_items: number; price_lists: number; deactivated_in_use: number };
    revalidatePath("/", "layout");
    return ok(
      undefined,
      `Removed ${r.quotes} quotes (with their orders), ${r.direct_orders} direct orders, ${r.customers} customers, ${r.materials} materials, ${r.charge_items} charges and ${r.price_lists} price lists.` +
        (r.deactivated_in_use ? ` ${r.deactivated_in_use} sample records used by real quotes were deactivated instead.` : ""),
    );
  });
}

/**
 * Company branding: logo and colors for this company only (company_settings,
 * row-level security). The logo's type is checked from its bytes (PNG, JPEG
 * or WebP), at most 250 KB; colors must keep white text readable.
 */
export async function saveBranding(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const access = await assertPermission("settings.manage");
    const color = String(formData.get("brand_color") ?? "").trim();
    const sidebarColor = String(formData.get("brand_sidebar_color") ?? "").trim();
    const problems = brandingProblems({ color, sidebarColor });
    if (Object.keys(problems).length) return fail("Check the colors.", problems);
    const update: Record<string, string> = { brand_color: color, brand_sidebar_color: sidebarColor };
    const file = formData.get("brand_logo");
    if (formData.get("remove_logo") === "on") update.brand_logo = "";
    else if (file instanceof File && file.size > 0) {
      if (file.size > MAX_LOGO_BYTES) return fail("The logo is too large.", { brand_logo: "Use an image of at most 250 KB." });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = sniffImage(bytes);
      if (!kind) return fail("The logo must be a PNG, JPEG or WebP image.", { brand_logo: "Use a PNG, JPEG or WebP image." });
      update.brand_logo = `data:image/${kind};base64,${Buffer.from(bytes).toString("base64")}`;
    }
    const supabase = await createClient();
    const { data, error } = await supabase.from("company_settings").update({ ...update, updated_by: access.userId }).eq("company_id", access.companyId!).select("company_id");
    if (error) return fail(dbErrorMessage(error));
    if (!data?.length) return fail("Branding could not be saved.");
    revalidatePath("/", "layout");
    return ok(undefined, "Branding saved. Everyone in your company sees it on their next page.");
  });
}
