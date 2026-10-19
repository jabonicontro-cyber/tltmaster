"use server";

import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { assertPermission } from "@/server/auth";
import { createClient } from "@/server/supabase/server";

// Staff side of the customer portal (B66). Permissions are checked here and again inside each database function.

const PATH = "/customer-portal";
const message = (e: { message: string }) => e.message.replace(/^.*?ERROR:\s*/, "").slice(0, 300);
const bool = (fd: FormData, k: string) => fd.get(k) === "on";

export async function savePortalSettings(formData: FormData): Promise<ActionResult> {
  await assertPermission("settings.manage");
  const supabase = await createClient();
  const p = {
    enabled: bool(formData, "enabled"), public_page: bool(formData, "public_page"),
    display_name: String(formData.get("display_name") ?? ""), welcome: String(formData.get("welcome") ?? ""),
    contact_email: String(formData.get("contact_email") ?? "").trim(), contact_phone: String(formData.get("contact_phone") ?? ""),
    hours: String(formData.get("hours") ?? ""),
    feature_orders: bool(formData, "feature_orders"), feature_quotes: bool(formData, "feature_quotes"), feature_documents: bool(formData, "feature_documents"),
    feature_support: bool(formData, "feature_support"), feature_help: bool(formData, "feature_help"), feature_tracking: bool(formData, "feature_tracking"),
  };
  const { error } = await supabase.rpc("portal_save_settings", { p });
  if (error) return fail(message(error));
  revalidatePath(PATH);
  return ok(undefined, "Portal settings saved.");
}

/** Returns the one-time invitation link (shown once to the staff member; never emailed from here). */
export async function invitePortalCustomer(formData: FormData): Promise<ActionResult<{ link: string; expires: string }>> {
  await assertPermission("customers.edit");
  const supabase = await createClient();
  const contact = String(formData.get("contact") ?? "") || null;
  const { data, error } = await supabase.rpc("portal_invite", { p_customer: String(formData.get("customer") ?? ""), p_contact: contact, p_email: String(formData.get("email") ?? "") });
  if (error) return fail(message(error));
  const r = data as { token: string; expires_at: string };
  revalidatePath(PATH);
  return ok({ link: `/portal/accept?token=${r.token}`, expires: r.expires_at }, "Invitation ready.");
}

export async function revokePortalAccount(formData: FormData): Promise<ActionResult> {
  await assertPermission("customers.edit");
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_revoke", { p_account: String(formData.get("account") ?? "") });
  if (error) return fail(message(error));
  revalidatePath(PATH);
  return ok(undefined, "Portal access removed.");
}

export async function replyToPortalRequest(formData: FormData): Promise<ActionResult> {
  await assertPermission("customers.edit");
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_staff_reply", { p_request: String(formData.get("request") ?? ""), p_body: String(formData.get("body") ?? ""), p_close: bool(formData, "close") });
  if (error) return fail(message(error));
  revalidatePath(PATH);
  return ok(undefined, "Reply sent to the customer's portal.");
}

export async function updateQuoteRequest(formData: FormData): Promise<ActionResult> {
  await assertPermission("quotes.edit");
  const supabase = await createClient();
  const quote = String(formData.get("quote") ?? "") || null;
  const { error } = await supabase.rpc("portal_quote_request_update", {
    p_request: String(formData.get("request") ?? ""), p_status: String(formData.get("status") ?? ""), p_quote: quote, p_note: String(formData.get("note") ?? ""),
  });
  if (error) return fail(message(error));
  revalidatePath(PATH);
  return ok(undefined, "Request updated.");
}

/** Confirm (runs the normal quote status workflow) or dismiss a customer's answer to a quote. */
export async function handleQuoteResponse(formData: FormData): Promise<ActionResult> {
  await assertPermission("quotes.status");
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_quote_response_handle", { p_response: String(formData.get("response") ?? ""), p_confirm: formData.get("confirm") === "yes" });
  if (error) return fail(message(error));
  revalidatePath(PATH);
  revalidatePath("/quotes");
  return ok(undefined, formData.get("confirm") === "yes" ? "Confirmed. The quote status is updated." : "Dismissed.");
}

export async function saveHelpArticle(formData: FormData): Promise<ActionResult> {
  await assertPermission("settings.manage");
  const supabase = await createClient();
  const id = String(formData.get("id") ?? "") || null;
  const { error } = await supabase.rpc("portal_help_save", {
    p_id: id, p_title: String(formData.get("title") ?? ""), p_category: String(formData.get("category") ?? ""),
    p_body: String(formData.get("body") ?? ""), p_status: String(formData.get("status") ?? "draft"),
  });
  if (error) return fail(message(error));
  revalidatePath(PATH);
  return ok(undefined, "Article saved.");
}

export async function createTrackingLink(formData: FormData): Promise<ActionResult<{ link: string }>> {
  await assertPermission("orders.edit");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("portal_tracking_create", { p_order: String(formData.get("order") ?? ""), p_days: Number(formData.get("days") ?? 14) });
  if (error) return fail(message(error));
  revalidatePath(`/orders/${String(formData.get("order") ?? "")}`);
  return ok({ link: `/track/${(data as { token: string }).token}` }, "Tracking link created.");
}

export async function revokeTrackingLink(formData: FormData): Promise<ActionResult> {
  await assertPermission("orders.edit");
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_tracking_revoke", { p_link: String(formData.get("link") ?? "") });
  if (error) return fail(message(error));
  revalidatePath(`/orders/${String(formData.get("order") ?? "")}`);
  return ok(undefined, "Link turned off.");
}
