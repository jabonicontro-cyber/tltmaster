"use server";

import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { requireAccess } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";
import { decodeArgs, resultFields } from "@/lib/support-requests";
import { REQUEST_RUNNERS } from "@/server/support/execute";
import { verifiedArgs, type RequestKind } from "@/server/support/request";

// Taviron support access (SA1, owner 2026-11-06: "customer picks"). Only a real owner of the company gives or ends it
// (a Taviron team member inside the company cannot); the database checks that again and records it in the audit log.

async function owner() {
  const access = await requireAccess();
  if (access.role !== "owner" || access.support) throw new Error("Only an owner of the company can change Taviron support access.");
  return access;
}

export async function grantSupportAccess(formData: FormData): Promise<ActionResult<{ endsAt: string }>> {
  return guard(async () => {
    await owner();
    const days = Number(formData.get("days"));
    if (![1, 3, 7].includes(days)) return fail("Choose 1, 3 or 7 days.");
    const { data, error } = await (await createClient()).rpc("support_access_grant", { p_days: days });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    return ok({ endsAt: String(data) }, `Taviron support can come in for ${days} ${days === 1 ? "day" : "days"}.`);
  });
}

export async function endSupportAccess(): Promise<ActionResult> {
  return guard(async () => {
    await owner();
    const { error } = await (await createClient()).rpc("support_access_end");
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    return ok(undefined, "Taviron support access ended. Anyone from Taviron in your account has been signed out of it.");
  });
}

// Support change requests (SA2, migration 20261120009200). A visiting staff member's people or sign-in change waits
// here; a real owner approves it (it then runs as the owner, with the owner's permissions checked again) or declines
// it. A one-time password or link the change produces is returned to the owner only, never stored.

const requestId = (v: FormDataEntryValue | null) => (/^[0-9a-f-]{36}$/i.test(String(v ?? "")) ? String(v) : null);

export async function approveSupportRequest(formData: FormData): Promise<ActionResult<{ fields: Array<{ label: string; value: string; secret?: boolean }> }>> {
  return guard(async () => {
    await owner();
    const id = requestId(formData.get("request"));
    if (!id) return fail("Request not found.");
    const supabase = await createClient();
    const claim = await supabase.rpc("support_change_claim", { p_request: id });
    if (claim.error) return fail(dbErrorMessage(claim.error));
    const c = claim.data as { kind: string; payload: unknown; summary: string; details: unknown };
    const run = (REQUEST_RUNNERS as Partial<Record<string, (typeof REQUEST_RUNNERS)[RequestKind]>>)[c.kind];
    const decoded = decodeArgs(c.payload);
    // What runs must be exactly what was shown: described again now, from the stored change itself.
    const args = run && decoded ? await verifiedArgs(c.kind, decoded, c) : null;
    let result: ActionResult<unknown>;
    if (!run || !decoded) result = fail("This kind of change can no longer be made from a request. Make it yourself, or ask Taviron support again.");
    else if (!args) result = fail("The request no longer matches what it would change (the records changed since it was made). Nothing was changed; ask Taviron support to send it again.");
    else {
      try { result = await run(args); } catch (e) {
        if (e && typeof e === "object" && "digest" in e) throw e;
        result = fail("The change could not be made. Nothing was changed; try again or make it yourself.");
      }
    }
    await supabase.rpc("support_change_finish", { p_request: id, p_ok: result.ok, p_result: result.ok ? (result.message ?? "Done.") : result.error });
    revalidatePath("/", "layout");
    if (!result.ok) return fail(`Not done: ${result.error}`);
    return ok({ fields: resultFields(result.data) }, `Approved and done: ${c.summary}.${result.message ? ` ${result.message}` : ""}`);
  });
}

export async function declineSupportRequest(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await owner();
    const id = requestId(formData.get("request"));
    if (!id) return fail("Request not found.");
    const { error } = await (await createClient()).rpc("support_change_decline", { p_request: id });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/", "layout");
    return ok(undefined, "Declined. Nothing was changed.");
  });
}

/** The staff member who asked, during the visit. */
export async function withdrawSupportRequest(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const access = await requireAccess();
    if (!access.support) return fail("Only the Taviron team member who asked can withdraw it.");
    const id = requestId(formData.get("request"));
    if (!id) return fail("Request not found.");
    const { error } = await (await createClient()).rpc("support_change_withdraw", { p_request: id });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/", "layout");
    return ok(undefined, "Withdrawn.");
  });
}
