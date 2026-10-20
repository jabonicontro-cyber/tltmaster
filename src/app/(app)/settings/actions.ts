"use server";

import { revalidatePath } from "next/cache";
import { MAX_LOGO_BYTES, brandingProblems, sniffImage } from "@/lib/branding";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { companySettingsSchema, inviteSchema, sequenceSchema, userAccessSchema } from "@/lib/schemas/settings";
import { uuid } from "@/lib/schemas/common";
import { PERMISSIONS, ROLES, type AppRole } from "@/lib/permissions";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";
import { inviteMember } from "@/server/people/invite";

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
    if (!["customer", "quote", "order", "ticket", "billing", "work_order"].includes(key)) return fail("Unknown sequence.");
    const parsed = sequenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.from("document_sequences").update(parsed.data).eq("key", key);
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    return ok(undefined, "Numbering saved. Existing records keep their numbers; a number already used is skipped, never issued twice.");
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
    const r = await inviteMember(access, parsed.data);
    revalidatePath("/settings");
    revalidatePath("/employees", "layout");
    return r.ok ? ok(undefined, r.message) : r;
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

const DOCUMENT_RULE_KINDS = ["registration", "insurance", "inspection", "permit"] as const;

/** Set the dispatch rule per vehicle document kind (settings.manage; checked again by the database). */
export async function saveDocumentRules(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("settings.manage");
    const supabase = await createClient();
    for (const kind of DOCUMENT_RULE_KINDS) {
      const action = formData.get(kind);
      if (action !== "block" && action !== "warn") return fail("Choose block or warn for every document.");
      const { error } = await supabase.rpc("set_document_rule", { p_kind: kind, p_action: action });
      if (error) return fail(dbErrorMessage(error));
    }
    revalidatePath("/settings");
    revalidatePath("/dispatch", "layout");
    return ok(undefined, "Document rules saved. Dispatch checks use them from now on.");
  });
}

/** Replace the time-off approval chain (settings.manage; checked again by the database). */
export async function saveApprovalChain(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("settings.manage");
    let steps: Array<{ role: string; label: string }>;
    try {
      steps = JSON.parse(String(formData.get("steps") ?? "[]"));
    } catch {
      return fail("Invalid approval steps.");
    }
    if (!Array.isArray(steps) || steps.length > 5) return fail("An approval chain has at most five steps.");
    for (const s of steps) {
      if (!ROLES.includes(s?.role as AppRole)) return fail("Choose who decides each step.");
      if (typeof s.label !== "string" || !s.label.trim() || s.label.length > 60) return fail("Give each step a short name (up to 60 characters).");
    }
    const supabase = await createClient();
    const { error } = await supabase.rpc("time_off_set_chain", { p: steps.map((s) => ({ role: s.role, label: s.label.trim() })) });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    revalidatePath("/time-off", "layout");
    return ok(undefined, steps.length ? "Approval chain saved. Pending requests start again at step 1." : "Approval chain removed: one approval decides.");
  });
}
