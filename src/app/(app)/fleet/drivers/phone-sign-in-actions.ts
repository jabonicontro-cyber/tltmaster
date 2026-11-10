"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { SUPPORT_VISIT_REFUSAL, inSupportVisit } from "@/server/accounts";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { passkeysAvailable, removePasskeysFor } from "@/server/passkeys";
import { issueDriverQr, QR_NOT_INSTALLED, type IssuedQr } from "@/server/signin-qr";
import { createClient } from "@/server/supabase/server";
import { asSupportRequest } from "@/server/support/request";

// Phone sign-in for a driver from Fleet (master plan DS1): a one-time QR code, and removing face or fingerprint
// sign-in when a phone is lost. users.manage, the permission that creates and resets sign-ins; the database checks it
// again with every rule (migration 20261120017000).
//
// A Taviron support visit cannot show a code: a code is a way in that only the company's own people may hand out, and
// an owner's later approval could not show the support person anything. Removing face or fingerprint sign-in becomes
// a request an owner approves (SA2), like turning a sign-in off.

const uuid = z.uuid();
const MISSING = new Set(["PGRST202", "42883", "42P01"]);

export async function showDriverSignInQr(driverId: string): Promise<ActionResult<IssuedQr>> {
  await assertPermission("users.manage");
  if (!uuid.safeParse(driverId).success) return fail("Driver not found.");
  if (await inSupportVisit()) return fail(SUPPORT_VISIT_REFUSAL);
  return issueDriverQr(driverId);
}

/** Has the phone used the code yet? (The office's window asks every few seconds while it is open.) */
export async function driverSignInQrStatus(codeId: string): Promise<string> {
  await assertPermission("users.manage");
  if (!uuid.safeParse(codeId).success) return "unknown";
  const { data, error } = await (await createClient()).rpc("signin_qr_status", { p_id: codeId });
  return error ? "unknown" : String(data);
}

/** The window was closed: the code stops working at once. */
export async function cancelDriverSignInQr(codeId: string): Promise<void> {
  await assertPermission("users.manage");
  if (!uuid.safeParse(codeId).success) return;
  await (await createClient()).rpc("signin_qr_cancel", { p_id: codeId });
}

/** Lost or new phone: remove every face or fingerprint sign-in of this person; username and password keep working. */
export async function removeDriverPasskeys(userId: string): Promise<ActionResult> {
  await assertPermission("users.manage");
  if (!uuid.safeParse(userId).success) return fail("Sign-in not found.");
  const req = await asSupportRequest("signin.passkeys_remove", [userId]);
  if (req) return req;
  const supabase = await createClient();
  const check = await supabase.rpc("signin_passkey_check", { p_user: userId });
  if (check.error) return fail(MISSING.has(check.error.code ?? "") ? QR_NOT_INSTALLED : dbErrorMessage(check.error));
  if (!(await passkeysAvailable())) return fail("Face or fingerprint sign-in is not turned on for this site, so there is nothing to remove.");
  const removed = await removePasskeysFor(userId);
  if (removed === null) return fail("Face or fingerprint sign-in could not be removed. Try again in a moment.");
  await supabase.rpc("signin_passkeys_removed", { p_user: userId, p_count: removed });
  revalidatePath("/fleet/drivers", "layout");
  return ok(undefined, removed ? `Removed from ${removed === 1 ? "1 phone" : `${removed} phones`}. Their username and password still work.` : "No phone had face or fingerprint sign-in set up.");
}
