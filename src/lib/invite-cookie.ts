// The invitation link's token, moved off the URL (security review 2026-11-16). The first owner (/join-company) and Taviron
// team (/join-team) invitation links carry a single-use token in the query string. The first request keeps it in a
// cookie (HttpOnly; Secure and __Secure- on HTTPS; SameSite=Strict; only sent to that page) and moves on to the clean
// address, so the token does not stay in the browser history, server logs or a sign-in "next=" address. Edge-safe:
// used by the proxy (src/proxy.ts) and the pages' server code (src/server/invite-token.ts).

export const INVITE_PAGES = ["/join-company", "/join-team"] as const;
export type InvitePage = (typeof INVITE_PAGES)[number];

export const INVITE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** A day is enough to finish the steps; the link itself can be opened again until the invitation expires. */
export const INVITE_COOKIE_SECONDS = 24 * 60 * 60;

export function isInvitePage(path: string): path is InvitePage {
  return (INVITE_PAGES as readonly string[]).includes(path);
}

export function inviteCookieName(page: InvitePage, secure: boolean): string {
  const base = page === "/join-company" ? "taviron-owner-invite" : "taviron-team-invite";
  return secure ? `__Secure-${base}` : base;
}

export function inviteCookieOptions(page: InvitePage, secure: boolean) {
  return { httpOnly: true, secure, sameSite: "strict" as const, path: page, maxAge: INVITE_COOKIE_SECONDS };
}

/**
 * The page the first request answers with: it only moves on to the clean address. A same-site step (not an HTTP
 * redirect) on purpose: a SameSite=Strict cookie is not sent on a redirect that started from another site (the email),
 * but it is sent when this page moves on. No script (the content security policy allows none inline).
 */
export function inviteHandoffHtml(page: InvitePage): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${page}"><title>Opening your invitation</title></head><body><p>Opening your invitation… <a href="${page}">Continue</a></p></body></html>`;
}
