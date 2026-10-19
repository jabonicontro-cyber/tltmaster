"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAccess } from "@/server/auth";
import { createClient } from "@/server/supabase/server";

// Help Center actions (B65): feedback on an article and a support request the person wrote and reviewed. Rows are
// stored for the person's own company (RLS); nothing is emailed from here.

const articleId = z.string().regex(/^[a-z0-9-]{1,80}$/);

export async function sendFeedback(formData: FormData) {
  await requireAccess();
  const id = articleId.safeParse(formData.get("article"));
  if (!id.success) redirect("/help");
  const helpful = formData.get("helpful") === "yes";
  const note = String(formData.get("note") ?? "").trim().slice(0, 1000);
  const supabase = await createClient();
  const { error } = await supabase.from("help_feedback").upsert({ article_id: id.data, helpful, note }, { onConflict: "company_id,user_id,article_id" });
  redirect(`/help/${id.data}?feedback=${error ? "error" : helpful ? "yes" : "no"}#feedback`);
}

/** Stores a support request the person reviewed on the page (see SupportForm). */
export async function sendSupportRequest(formData: FormData) {
  await requireAccess();
  const message = String(formData.get("message") ?? "").trim().slice(0, 4000);
  const page = String(formData.get("page") ?? "").slice(0, 200);
  const art = articleId.safeParse(formData.get("article"));
  if (message.length < 10) redirect(`/help/contact?error=${encodeURIComponent("Write a few words about what you need (at least 10 characters).")}`);
  const supabase = await createClient();
  const { error } = await supabase.from("help_support_requests").insert({ message, page: page.startsWith("/") ? page : "", article_id: art.success ? art.data : null });
  if (error) redirect(`/help/contact?error=${encodeURIComponent(error.code === "42P01" || error.code === "PGRST205" ? "Support requests need a database update that has not been installed yet." : "Your request could not be saved. Try again.")}`);
  redirect("/help/contact?sent=1");
}
