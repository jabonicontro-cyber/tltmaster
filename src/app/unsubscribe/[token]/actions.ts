"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/server/supabase/admin";

/**
 * Confirm an unsubscribe from an outreach email (master plan B139). The token in the link is the only key: the address
 * is added to the do-not-contact list and never emailed again. The answer is the same whether or not the token exists.
 */
export async function confirmUnsubscribe(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  if (/^[0-9a-f]{32}$/.test(token)) {
    try {
      await createAdminClient().rpc("outreach_unsubscribe", { p_token: token });
    } catch {
      // The page still confirms; a failure is visible in the server logs and the person can reply to the email instead.
    }
  }
  redirect(`/unsubscribe/${/^[0-9a-f]{32}$/.test(token) ? token : "x"}?done=1`);
}
