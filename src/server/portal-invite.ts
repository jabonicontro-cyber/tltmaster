import "server-only";
import { cookies } from "next/headers";
import { isPortalToken } from "@/lib/portal";

/** Cookie that carries a pending portal invitation through the emailed sign-in link (same browser). Token only, 7 days. */
const PENDING_INVITE = "portal_invite";

export async function rememberPendingPortalInvite(token: string): Promise<void> {
  (await cookies()).set(PENDING_INVITE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 86400, path: "/" });
}

export async function forgetPendingPortalInvite(): Promise<void> {
  (await cookies()).delete(PENDING_INVITE);
}

/** Where a person who just chose a password continues: the invitation they asked about from this browser, if any. */
export async function takePendingPortalInvite(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(PENDING_INVITE)?.value ?? "";
  if (!token) return null;
  jar.delete(PENDING_INVITE);
  return isPortalToken(token) ? `/portal/accept?token=${token}` : null;
}
