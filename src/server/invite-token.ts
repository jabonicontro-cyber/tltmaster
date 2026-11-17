import "server-only";
import { cookies } from "next/headers";
import { INVITE_TOKEN_PATTERN, inviteCookieName, inviteCookieOptions, type InvitePage } from "@/lib/invite-cookie";
import { requestIsHttps } from "@/server/site-access-request";

/** The invitation token the link left in this browser for that page (src/lib/invite-cookie.ts), or "" when none. */
export async function readInviteToken(page: InvitePage): Promise<string> {
  const value = (await cookies()).get(inviteCookieName(page, await requestIsHttps()))?.value ?? "";
  return INVITE_TOKEN_PATTERN.test(value) ? value : "";
}

/** Forget the token once the invitation was used (or can no longer be). */
export async function clearInviteToken(page: InvitePage): Promise<void> {
  const secure = await requestIsHttps();
  (await cookies()).set(inviteCookieName(page, secure), "", { ...inviteCookieOptions(page, secure), maxAge: 0 });
}
