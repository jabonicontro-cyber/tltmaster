"use server";

import { fail, ok, type ActionResult } from "@/lib/action-result";
import { homePathFor, passwordProblem } from "@/lib/accounts";
import { getAccess } from "@/server/auth";
import { mySetup } from "@/server/setup";
import { createClient } from "@/server/supabase/server";

/**
 * First sign-in: the person replaces the temporary password with their own. The database marks setup complete only
 * when the stored password really changed (account_setup_complete); until then it gives no company and no portal.
 * Where to go next comes from the server (verified role and permissions), never from the browser.
 */
export async function completeFirstSignIn(formData: FormData): Promise<ActionResult<{ next: string }>> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return fail("Your session ended. Sign in again with your temporary password.");
  const setup = await mySetup();
  if (!setup) return fail("First-time setup is not available on this server yet.");
  if (setup.required && setup.expired) return fail("Your temporary sign-in has expired. Ask your administrator for a new sign-in sheet.");
  if (setup.required) {
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    const problem = passwordProblem(password, confirm, setup.username ?? "");
    if (problem) return fail(problem, { [problem.includes("match") ? "confirm" : "password"]: problem });
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      console.warn("First sign-in password change refused", { status: error.status, code: error.code });
      if (error.code === "same_password") return fail("Choose a password different from your temporary one.", { password: "Choose a different password." });
      if (error.code === "weak_password") return fail("That password is too easy to guess. Try a longer one.", { password: "Try a longer password." });
      return fail("Your password could not be saved. Try again.");
    }
    const done = await supabase.rpc("account_setup_complete");
    if (done.error) return fail(done.error.message.replace(/^.*?ERROR:\s*/, "").slice(0, 200));
    // Any other session (for example a shared computer someone forgot to sign out) ends now.
    await supabase.auth.signOut({ scope: "others" });
  }
  if (setup.kind === "portal" && setup.slug) return ok({ next: `/portal/${setup.slug}` }, "Your password is set.");
  const access = await getAccess();
  return ok({ next: homePathFor(access?.role ?? null, access?.permissions ?? []) }, "Your password is set.");
}
