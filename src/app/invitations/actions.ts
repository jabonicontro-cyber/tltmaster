"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Answering a company's invitation (security review 2026-11-06, M1): only the invited person, signed in, can accept;
// accepting opens that company.

export async function answerInvitation(formData: FormData) {
  const id = z.uuid().safeParse(formData.get("invitation"));
  const accept = formData.get("answer") === "accept";
  if (!id.success) redirect("/invitations?error=" + encodeURIComponent("Reload the page and try again."));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("answer_membership_invitation", { p_invitation: id.data, p_accept: accept });
  if (error) redirect("/invitations?error=" + encodeURIComponent(dbErrorMessage(error)));
  revalidatePath("/", "layout");
  if (accept && data) {
    await supabase.rpc("switch_company", { p_company_id: data as string });
    redirect("/command-center");
  }
  redirect("/invitations?declined=1");
}
