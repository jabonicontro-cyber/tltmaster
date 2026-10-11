"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/server/supabase/server";
import { env } from "@/server/env";
import { safeNextPath } from "@/lib/safe-redirect";
import type { ActionResult } from "@/lib/action-result";
import { EARLY_ACCESS_REQUIRED, hasSiteAccess } from "@/server/site-access-request";

const signInSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
  next: z.string().optional(),
});

export async function signIn(formData: FormData): Promise<ActionResult> {
  if (!(await hasSiteAccess())) return { ok: false, error: EARLY_ACCESS_REQUIRED };
  const parsed = signInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    if (error.status === 429) return { ok: false, error: "Too many attempts. Wait a minute and try again." };
    // Supabase reports an unconfirmed email only after the password has matched,
    // so saying so reveals nothing to someone who does not know the password.
    if (error.code === "email_not_confirmed") {
      return { ok: false, error: "This email address has not been confirmed yet. Open the confirmation link sent when the account was created, or ask your Taviron administrator to confirm the account." };
    }
    if (error.status === 400 || error.code === "invalid_credentials") {
      // Same message either way: do not reveal whether the account exists.
      return { ok: false, error: "Email or password is incorrect." };
    }
    console.error("Sign-in failed", { status: error.status, code: error.code });
    return { ok: false, error: "Sign-in is temporarily unavailable. Please try again in a minute." };
  }
  redirect(safeNextPath(parsed.data.next));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

const resetSchema = z.object({ email: z.email("Enter a valid email address.") });

export async function requestPasswordReset(formData: FormData): Promise<ActionResult> {
  if (!(await hasSiteAccess())) return { ok: false, error: EARLY_ACCESS_REQUIRED };
  const parsed = resetSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${env().APP_BASE_URL}/auth/confirm?next=/update-password`,
  });
  if (error && error.status === 429) {
    return { ok: false, error: "Too many requests. Wait a few minutes and try again." };
  }
  if (error) {
    console.error("Password reset request failed", error.message);
    return { ok: false, error: "The reset email could not be sent. Try again later or contact your administrator." };
  }
  // Same message whether or not the account exists.
  return { ok: true, data: undefined, message: "If an account exists for that email, a reset link is on its way." };
}

const updatePasswordSchema = z
  .object({
    password: z.string().min(10, "Use at least 10 characters.").max(128),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords do not match.", path: ["confirm"] });

export async function updatePassword(formData: FormData): Promise<ActionResult> {
  const parsed = updatePasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) {
    return { ok: false, error: "Your reset link has expired. Request a new one." };
  }
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return { ok: false, error: error.message.includes("different") ? "Choose a password you have not used before." : "Password could not be updated. Try again." };
  }
  redirect("/command-center");
}
