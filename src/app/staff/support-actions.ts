"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isRequestStatus } from "@/lib/platform/console";
import { dbErrorMessage } from "@/server/errors";
import { assertPlatformStaff } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

// Support inbox (PC1, 20261120020500): both staff levels change a request's status and add a note or a reply. A reply
// is recorded only; nothing is emailed from Taviron (the page offers to open it in the staff member's own email). The
// database checks the staff level again and records every change in the platform audit log.

const BASES = new Set(["/admin/support", "/staff/support"]);

export async function updateSupportRequest(formData: FormData) {
  await assertPlatformStaff();
  const id = z.uuid().safeParse(formData.get("id"));
  const base = String(formData.get("base") ?? "");
  const root = BASES.has(base) ? base : "/staff/support";
  if (!id.success) redirect(`${root}?error=${encodeURIComponent("Reload the page and try again.")}`);
  const path = `${root}/${id.data}`;
  const status = String(formData.get("status") ?? "");
  const kind = formData.get("kind") === "reply" ? "reply" : "note";
  const body = String(formData.get("body") ?? "").trim().slice(0, 4000);
  const back = (error: string): never => redirect(`${path}?error=${encodeURIComponent(error.slice(0, 300))}`);
  if (status && !isRequestStatus(status)) back("Choose New, Answered or Closed.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_support_request_update", { p_id: id.data, p_status: status || null, p_kind: kind, p_body: body });
  if (error) back(dbErrorMessage(error));
  revalidatePath(root);
  revalidatePath(path);
  redirect(`${path}?saved=${body ? kind : "status"}`);
}
