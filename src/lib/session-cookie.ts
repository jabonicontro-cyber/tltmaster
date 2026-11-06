// Sign-in cookies (security review 2026-11-06, M4). The app has no browser-side database client, so no script ever needs
// to read the session cookie: it is httpOnly (an injected script could not steal the tokens), Secure on HTTPS, SameSite
// lax, and lasts 30 days from the last refresh (renewed while the person keeps using the app; "Stay signed in" left
// unticked still makes it end when the browser closes, src/lib/shared-device.ts).

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Options for @supabase/ssr's createServerClient. Secure everywhere except a plain-HTTP local server. */
export function sessionCookieOptions(baseUrl = process.env.APP_BASE_URL ?? "") {
  return {
    httpOnly: true,
    secure: !baseUrl.startsWith("http://"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
