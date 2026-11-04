"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { SUPPORT_KINDS } from "@/lib/support";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { sendSupportNotice } from "@/server/support/notice";
import { createClient } from "@/server/supabase/server";

// Support center (B138). The database checks customers.edit, the customer's own links and the rules; these actions
// validate input, then tell the customer by email (never from a demo company).

const kind = z.enum(Object.keys(SUPPORT_KINDS) as [keyof typeof SUPPORT_KINDS, ...Array<keyof typeof SUPPORT_KINDS>], { message: "Choose what the case is about." });
const optionalId = z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v)).default("");

const noticeText = (n: Awaited<ReturnType<typeof sendSupportNotice>>) =>
  n === "sent" ? " The customer was emailed a notice." : n === "test" ? " A test notice went to the test address." : n === "none" ? " The customer has no portal login, so no email was sent."
  : n === "failed" ? " The email notice could not be sent; the reply is in the portal." : " Email notices are shown, not sent, here.";

const openInput = z.object({
  customer: z.uuid({ message: "Choose a customer." }), kind, subject: z.string().trim().min(1, "Enter a subject.").max(160),
  message: z.string().trim().min(5, "Write a message.").max(4000), order: optionalId, ticket: optionalId, invoice: optionalId, assign: optionalId,
});

export async function openSupportCase(raw: z.input<typeof openInput>): Promise<ActionResult<{ id: string; messageId: string }>> {
  return guard(async () => {
    const access = await assertPermission("customers.edit");
    const p = openInput.safeParse(raw);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the form.");
    const v = p.data;
    const { data, error } = await (await createClient()).rpc("support_open_case", {
      p_customer: v.customer, p_kind: v.kind, p_subject: v.subject, p_message: v.message, p_order: v.order, p_ticket: v.ticket, p_invoice: v.invoice, p_assign: v.assign,
    });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { id: string; message_id: string };
    const n = await sendSupportNotice(r.id, Boolean(access.isDemo));
    revalidatePath("/support");
    return ok({ id: r.id, messageId: r.message_id }, `Case opened.${noticeText(n)}`);
  });
}

const replyInput = z.object({ request: z.uuid(), body: z.string().trim().max(4000), internal: z.boolean().default(false), close: z.boolean().default(false) });

export async function replySupportCase(raw: z.input<typeof replyInput>): Promise<ActionResult<{ messageId: string | null }>> {
  return guard(async () => {
    const access = await assertPermission("customers.edit");
    const p = replyInput.safeParse(raw);
    if (!p.success) return fail("Check the reply.");
    const v = p.data;
    if (!v.body && !v.close) return fail(v.internal ? "Write the note." : "Write a reply.");
    const { data, error } = await (await createClient()).rpc("support_reply", { p_request: v.request, p_body: v.body, p_internal: v.internal, p_close: v.close });
    if (error) return fail(dbErrorMessage(error));
    const notice = v.body && !v.internal ? noticeText(await sendSupportNotice(v.request, Boolean(access.isDemo))) : "";
    revalidatePath(`/support/${v.request}`);
    revalidatePath("/support");
    const what = v.internal ? "Note saved (staff only)." : v.body ? "Reply sent." : "Case closed.";
    return ok({ messageId: (data as string | null) ?? null }, `${what}${v.close && v.body ? " Case closed." : ""}${notice}`);
  });
}

const updateInput = z.object({ request: z.uuid(), kind, assign: optionalId, order: optionalId, ticket: optionalId, invoice: optionalId });

export async function updateSupportCase(formData: FormData) {
  const raw = Object.fromEntries(["request", "kind", "assign", "order", "ticket", "invoice"].map((k) => [k, String(formData.get(k) ?? "")]));
  const back = `/support/${raw.request}`;
  try {
    await assertPermission("customers.edit");
  } catch {
    redirect(`${back}?error=${encodeURIComponent("You do not have permission to change support cases.")}`);
  }
  const p = updateInput.safeParse(raw);
  if (!p.success) redirect(`${back}?error=${encodeURIComponent(p.error.issues[0]?.message ?? "Check the form.")}`);
  const v = p.data!;
  const { error } = await (await createClient()).rpc("support_update", { p_request: v.request, p_kind: v.kind, p_assign: v.assign, p_order: v.order, p_ticket: v.ticket, p_invoice: v.invoice });
  if (error) redirect(`${back}?error=${encodeURIComponent(dbErrorMessage(error).slice(0, 300))}`);
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}

/** The company's first-reply target in hours (empty turns it off). */
export async function saveSupportTarget(formData: FormData) {
  const raw = String(formData.get("hours") ?? "").trim();
  const hours = raw === "" ? null : Number.parseInt(raw, 10);
  try {
    await assertPermission("settings.manage");
  } catch {
    redirect(`/support?error=${encodeURIComponent("Only people who manage settings can change the reply target.")}`);
  }
  if (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 168)) redirect(`/support?error=${encodeURIComponent("The target is 1 to 168 hours, or empty to turn it off.")}`);
  const { error } = await (await createClient()).rpc("support_save_settings", { p_first_reply_hours: hours });
  if (error) redirect(`/support?error=${encodeURIComponent(dbErrorMessage(error).slice(0, 300))}`);
  revalidatePath("/support");
  revalidatePath("/command-center");
  redirect("/support?saved=target");
}
