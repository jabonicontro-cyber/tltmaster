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

// Inviting a company's first owner (PC2, owner decision 2026-11-14: "Yes, Admin only"). This is a COMPANY membership,
// never Taviron platform access. Only an Admin, with their password and authenticator code again; the database checks
// all of it again (platform_owner_invite: Admin level, fresh re-authentication, a real company with no owner, not a
// demo, not a Taviron team email) and records it in the platform audit and the company's history. The owner opens the
// link, chooses their own password, sets up an authenticator app and accepts (/join-company).

const MISSING = new Set(["PGRST202", "42883"]);
const NOT_INSTALLED = "Inviting an owner from here is not available on this database yet. Nothing was changed.";

const inviteSchema = z.object({
  company: z.uuid(),
  full_name: z.string().trim().min(2, "Enter the owner's name.").max(120),
  email: z.email("Enter a valid email address.").max(254),
  password: z.string().min(1, "Enter your password.").max(200),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app."),
});

export interface OwnerInviteResult {
  email: string;
  fullName: string;
  companyName: string;
  expiresAt: string;
  emailed: "sent" | "test" | "not_sent";
  note: string;
  /** The link to hand over, only when the owner was not emailed it (it works once and expires). */
  link: string | null;
}

export async function inviteOwner(formData: FormData): Promise<ActionResult<OwnerInviteResult>> {
  return guard(async () => {
    const me = await requirePlatformAdmin();
    const p = inviteSchema.safeParse(Object.fromEntries(formData));
    if (!p.success) {
      const issue = p.error.issues[0];
      return fail(issue?.message ?? "Check the form.", issue?.path[0] ? { [String(issue.path[0])]: issue.message } : undefined);
    }
    const v = p.data;
    const r = await confirmPasswordAndCode(me.email, v.password, v.code);
    if (r === "password") return fail("That password is not correct. Nothing was changed.", { password: "Not correct." });
    if (r === "code") return fail("That code is not correct or has expired. Nothing was changed.", { code: "Not correct." });

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("platform_owner_invite", { p_company: v.company, p_email: v.email, p_full_name: v.full_name });
    if (error) return fail(MISSING.has(error.code ?? "") ? NOT_INSTALLED : dbErrorMessage(error));
    const inv = data as { token: string; expires_at: string; email: string; full_name: string; company_name: string };
    const link = `${env().APP_BASE_URL}/join-company?token=${inv.token}`;

    // The invitation email. Without a configured provider nothing is sent and the link is shown to hand over instead;
    // test mode sends to the test inbox only. Demo companies are refused by the database before this point.
    const mode = getEmailMode();
    let emailed: OwnerInviteResult["emailed"] = "not_sent";
    let note = mode.mode === "preview" ? mode.reason : "";
    if (mode.mode !== "preview") {
      const subject = `Set up ${inv.company_name} in Taviron`;
      const paragraphs = [
        `${inv.full_name}, Taviron set up ${inv.company_name} for you. You are invited to be its owner.`,
        "Open the link to choose your password and set up an authenticator app. Then you can add your team. The link works once and expires in 7 days.",
      ];
      const testing = mode.mode === "test";
      const sent = await mode.provider.send(
        {
          to: testing ? [mode.testRecipient] : [inv.email], cc: [], replyTo: env().EMAIL_REPLY_TO,
          subject: testing ? `[TEST] ${subject}` : subject,
          text: `${testing ? `TEST MODE. Intended for: ${inv.email}\n\n` : ""}${paragraphs.join("\n\n")}\n\n${link}`,
          html: renderEmailHtml({ preheader: subject, heading: `Welcome to Taviron`, paragraphs, action: { label: "Accept the invitation", url: link }, footer: "If you did not expect this, ignore this email." }),
          attachments: [],
        },
        { idempotencyKey: `owner-invite-${inv.token.slice(0, 16)}` },
      );
      if (sent.ok) emailed = testing ? "test" : "sent";
      else note = "The email could not be sent. Copy the link and send it yourself.";
    }
    revalidatePath(`/admin/companies/${v.company}`);
    return ok(
      { email: inv.email, fullName: inv.full_name, companyName: inv.company_name, expiresAt: inv.expires_at, emailed, note, link: emailed === "sent" ? null : link },
      emailed === "sent" ? `Invitation emailed to ${inv.email}.` : "Invitation created.",
    );
  });
}

export async function withdrawOwnerInvite(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requirePlatformAdmin();
    const id = z.uuid().safeParse(formData.get("invite"));
    const company = z.uuid().safeParse(formData.get("company"));
    if (!id.success || !company.success) return fail("Reload the page and try again.");
    const { error } = await (await createClient()).rpc("platform_owner_invite_withdraw", { p_invite: id.data });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/admin/companies/${company.data}`);
    return ok(undefined, "Invitation withdrawn. The link no longer works.");
  });
}
