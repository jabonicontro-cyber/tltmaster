// "This is a shared computer" at sign-in: the session cookies become browser-session cookies (no expiry), so closing
// the browser signs the person out and the next person never lands in their account. Nothing else is stored.

export const SHARED_DEVICE_COOKIE = "tlt_shared";

type CookieOptions = { maxAge?: number; expires?: Date | number | string } & Record<string, unknown>;

/** The cookie options to use: unchanged normally; without maxAge/expires on a shared computer. */
export function cookiePersistence<T extends CookieOptions | undefined>(options: T, shared: boolean): T {
  if (!shared || !options) return options;
  const rest: Record<string, unknown> = { ...options };
  delete rest.maxAge;
  delete rest.expires;
  return rest as T;
}
