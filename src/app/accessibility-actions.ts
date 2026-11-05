"use server";

import { fail, ok, type ActionResult } from "@/lib/action-result";
import { parseAccessibility, type AccessibilitySettings } from "@/lib/accessibility";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

/** Save the signed-in person's accessibility settings to their account (staff and customer portal alike). */
export async function saveMyAccessibility(input: AccessibilitySettings): Promise<ActionResult> {
  return guard(async () => {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return fail("Sign in first.");
    const { error } = await supabase.rpc("set_my_accessibility", { p_settings: parseAccessibility(input) });
    if (error) return fail(dbErrorMessage(error));
    return ok(undefined, "Accessibility settings saved.");
  });
}
