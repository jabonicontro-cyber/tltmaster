// "Stay signed in" at sign-in (owner 2026-11-01; before: "This is a shared computer"). Unticked, the session cookies
// become browser-session cookies (no expiry), so closing the browser signs the person out and the next person never
// lands in their account. Ticked (the default), the person stays signed in on that device. Nothing else is stored.

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

/**
 * Whether a sign-in form asked to sign out when the browser closes: "Stay signed in" left unticked (the form says it
 * showed the box), or the older "This is a shared computer" ticked.
 */
export function wantsBrowserSession(formData: FormData): boolean {
  if (formData.get("shared_device") === "on") return true;
  return formData.get("stay_signed_in_shown") === "1" && formData.get("stay_signed_in") !== "on";
}
