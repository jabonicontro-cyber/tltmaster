import "server-only";
import { cookies } from "next/headers";
import { isPortalSlug, isPortalToken } from "@/lib/portal";

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

/**
 * Cookie that brings a customer who asked for a password reset on a portal's sign-in page back to that portal once the
 * new password is saved (same browser; owner 2026-11-17, PR1). The portal's address only, one hour. From another
 * device the person lands on the usual page, which sends a portal-only account to its portal (src/server/auth.ts).
 */
export const PORTAL_RETURN = "portal_return";

/** The portal to continue to after a password reset asked for from it, if any (the cookie is used once). */
export async function takePortalReturn(): Promise<string | null> {
  const jar = await cookies();
  const slug = jar.get(PORTAL_RETURN)?.value ?? "";
  if (!slug) return null;
  jar.delete(PORTAL_RETURN);
  return isPortalSlug(slug) ? `/portal/${slug}` : null;
}
