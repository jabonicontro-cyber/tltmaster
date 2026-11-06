"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { renderEmailHtml } from "@/lib/email/html";
import { getEmailMode } from "@/server/email/provider";
import { env } from "@/server/env";
import { dbErrorMessage, guard } from "@/server/errors";
import { requirePlatformAdmin } from "@/server/platform";
import { confirmPasswordAndCode } from "@/server/reauth";
import { createClient } from "@/server/supabase/server";

// The Taviron team (SA1, owner 2026-11-06: "invite from console", "two levels"). Only an Admin invites, changes levels
// or removes; inviting and raising someone to Admin need the Admin's password and authenticator code again. The
// database checks all of it again (platform_staff_*) and records every change in the platform audit log.

const MISSING = new Set(["PGRST202", "42883"]);
const NOT_INSTALLED = "The Taviron team needs the database update 20261120008900, which is not installed yet.";
const LEVEL_LABEL = { admin: "Admin", support: "Support" } as const;

const inviteSchema = z.object({
  full_name: z.string().trim().min(2, "Enter the person's name.").max(120),
  email: z.email("Enter a valid email address.").max(254),
  level: z.enum(["support", "admin"]),
  password: z.string().min(1, "Enter your password.").max(200),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app."),
});

export interface StaffInviteResult { link: string; email: string; fullName: string; level: "admin" | "support"; expiresAt: string; emailed: "sent" | "test" | "not_sent"; note: string }

async function reauth(email: string, password: string, code: string): Promise<ReturnType<typeof fail> | null> {
  const r = await confirmPasswordAndCode(email, password, code);
  if (r === "password") return fail("That password is not correct. Nothing was changed.", { password: "Not correct." });
  if (r === "code") return fail("That code is not correct or has expired. Nothing was changed.", { code: "Not correct." });
  return null;
}

export async function inviteStaff(formData: FormData): Promise<ActionResult<StaffInviteResult>> {
  return guard(async () => {
    const me = await requirePlatformAdmin();
    const p = inviteSchema.safeParse(Object.fromEntries(formData));
    if (!p.success) {
      const issue = p.error.issues[0];
      return fail(issue?.message ?? "Check the form.", issue?.path[0] ? { [String(issue.path[0])]: issue.message } : undefined);
    }
    const v = p.data;
    const denied = await reauth(me.email, v.password, v.code);
    if (denied) return denied;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("platform_staff_invite", { p_email: v.email, p_full_name: v.full_name, p_level: v.level });
    if (error) return fail(MISSING.has(error.code ?? "") ? NOT_INSTALLED : dbErrorMessage(error));
    const inv = data as { token: string; expires_at: string; email: string; full_name: string; level: "admin" | "support" };
    const link = `${env().APP_BASE_URL}/join-team?token=${inv.token}`;

    // The invitation email (the owner's decision: the invitee gets a link). Without a configured provider nothing is
    // sent and the link is shown to copy instead; test mode sends to the test inbox.
    const mode = getEmailMode();
    let emailed: StaffInviteResult["emailed"] = "not_sent";
    let note = mode.mode === "preview" ? mode.reason : "";
    if (mode.mode !== "preview") {
      const subject = "You are invited to the Taviron team";
      const paragraphs = [
        `${inv.full_name}, you are invited to join the Taviron team as ${LEVEL_LABEL[inv.level]}.`,
        "Open the link to choose your password and set up an authenticator app. The link works once and expires in 7 days.",
      ];
      const testing = mode.mode === "test";
      const result = await mode.provider.send(
        {
          to: testing ? [mode.testRecipient] : [inv.email], cc: [], replyTo: env().EMAIL_REPLY_TO,
          subject: testing ? `[TEST] ${subject}` : subject,
          text: `${testing ? `TEST MODE. Intended for: ${inv.email}\n\n` : ""}${paragraphs.join("\n\n")}\n\n${link}`,
          html: renderEmailHtml({ preheader: subject, heading: "Join the Taviron team", paragraphs, action: { label: "Accept the invitation", url: link }, footer: "If you did not expect this, ignore this email." }),
          attachments: [],
        },
        { idempotencyKey: `staff-invite-${inv.token.slice(0, 16)}` },
      );
      if (result.ok) emailed = testing ? "test" : "sent";
      else note = "The email could not be sent. Copy the link and send it yourself.";
    }
    revalidatePath("/admin/platform");
    return ok({ link, email: inv.email, fullName: inv.full_name, level: inv.level, expiresAt: inv.expires_at, emailed, note }, "Invitation created.");
  });
}

export async function withdrawInvite(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requirePlatformAdmin();
    const id = z.uuid().safeParse(formData.get("invite"));
    if (!id.success) return fail("Reload the page and try again.");
    const { error } = await (await createClient()).rpc("platform_staff_invite_revoke", { p_invite: id.data });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/admin/platform");
    return ok(undefined, "Invitation withdrawn.");
  });
}

const levelSchema = z.object({ user: z.uuid(), level: z.enum(["support", "admin"]), password: z.string().max(200).default(""), code: z.string().trim().default("") });

export async function setStaffLevel(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const me = await requirePlatformAdmin();
    const p = levelSchema.safeParse(Object.fromEntries(formData));
    if (!p.success) return fail("Reload the page and try again.");
    if (p.data.level === "admin") {
      const denied = await reauth(me.email, p.data.password, p.data.code);
      if (denied) return denied;
    }
    const { error } = await (await createClient()).rpc("platform_staff_set_level", { p_user: p.data.user, p_level: p.data.level });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/admin/platform");
    return ok(undefined, `Changed to ${LEVEL_LABEL[p.data.level]}.`);
  });
}

export async function removeStaff(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requirePlatformAdmin();
    const user = z.uuid().safeParse(formData.get("user"));
    if (!user.success) return fail("Reload the page and try again.");
    const { error } = await (await createClient()).rpc("platform_staff_remove", { p_user: user.data, p_note: String(formData.get("note") ?? "").slice(0, 300) });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/admin/platform");
    return ok(undefined, "Removed from the team. Any visit they had open has ended.");
  });
}
