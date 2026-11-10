import "server-only";
import { createHash } from "node:crypto";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isQrToken, newQrToken, qrSignInUrl, type QrRefusal } from "@/lib/signin-qr";
import { dbErrorMessage } from "@/server/errors";
import { env } from "@/server/env";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

// One-time QR sign-in codes (master plan DS1; migration 20261120017000). The token exists only in the value returned
// to the office's window (shown as a QR code) and on the phone; the database keeps its SHA-256. Nothing here logs the
// token, its hash or the sign-in address. The service-role key is used only after the database accepted the code.

const MISSING = new Set(["PGRST202", "42883", "42P01"]);
export const QR_NOT_INSTALLED = "QR sign-in needs the database update 20261120017000, which is not installed yet.";

export function hashQrToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface IssuedQr {
  id: string;
  url: string;
  expiresAt: string;
  driverName: string;
}

/** Make a code for a driver. The database checks the permission, the driver and every refusal rule. */
export async function issueDriverQr(driverId: string): Promise<ActionResult<IssuedQr>> {
  if (!adminAvailable()) return fail("Signing in with a code needs SUPABASE_SERVICE_ROLE_KEY on the server. Ask the Taviron team to configure it.");
  const token = newQrToken();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("signin_qr_issue", { p_driver: driverId, p_token_hash: hashQrToken(token) });
  if (error) return fail(MISSING.has(error.code ?? "") ? QR_NOT_INSTALLED : dbErrorMessage(error));
  const r = data as { id: string; expires_at: string; driver_name: string };
  return ok({ id: r.id, url: qrSignInUrl(env().APP_BASE_URL, token), expiresAt: r.expires_at, driverName: r.driver_name });
}

export type RedeemResult = { ok: true } | { ok: false; reason: QrRefusal };

/**
 * Use a code on this browser: the database takes it (once), then the server makes a real session for that sign-in with
 * the Auth admin API (a one-time sign-in link that is verified here at once and never sent anywhere) and writes the
 * session cookies on this response.
 */
export async function redeemQrToken(token: unknown): Promise<RedeemResult & { id?: string }> {
  if (!isQrToken(token)) return { ok: false, reason: "invalid" };
  if (!adminAvailable()) return { ok: false, reason: "unavailable" };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("signin_qr_redeem", { p_token_hash: hashQrToken(token) });
  if (error) {
    console.warn("QR sign-in redeem failed", { code: error.code });
    return { ok: false, reason: MISSING.has(error.code ?? "") ? "unavailable" : "failed" };
  }
  const r = data as { ok: boolean; reason?: QrRefusal; id?: string; email?: string };
  if (!r.ok || !r.id || !r.email) return { ok: false, reason: r.reason ?? "invalid" };
  const failed = async () => {
    await admin.rpc("signin_qr_failed", { p_id: r.id });
    return { ok: false as const, reason: "failed" as const };
  };
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: r.email });
  const hashed = link.data?.properties?.hashed_token;
  if (link.error || !hashed) {
    console.warn("QR sign-in link failed", { status: link.error?.status, code: link.error?.code });
    return failed();
  }
  const supabase = await createClient();
  const verified = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: hashed });
  if (verified.error || !verified.data.session) {
    console.warn("QR sign-in session failed", { status: verified.error?.status, code: verified.error?.code });
    return failed();
  }
  return { ok: true, id: r.id };
}
