// Username sign-in. Supabase Auth signs people in with an email address, so an
// account created with a username carries an internal sign-in address,
// <username>@users.mytaviron.com. It is an identifier only: it is never a
// person's contact address, nothing is ever sent to it, and it is shown as the
// username. The mapping is deterministic, so signing in needs no lookup and
// never reveals which usernames exist.

export const USERNAME_DOMAIN = "users.mytaviron.com";

/** 3–32 characters: lowercase letters, digits, dots and hyphens; starts and ends with a letter or digit; no "..". */
const USERNAME = /^[a-z0-9](?:[a-z0-9.-]{1,30})[a-z0-9]$/;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidUsername(value: string): boolean {
  const v = normalizeUsername(value);
  return USERNAME.test(v) && !v.includes("..");
}

export function usernameEmail(username: string): string {
  return `${normalizeUsername(username)}@${USERNAME_DOMAIN}`;
}

/** True for internal sign-in addresses (and anything else at the reserved domain). */
export function isUsernameEmail(email: string | null | undefined): boolean {
  return Boolean(email && email.trim().toLowerCase().endsWith(`@${USERNAME_DOMAIN}`));
}

/** How an account's sign-in is shown: the username for username accounts, otherwise the email. */
export function displayLogin(email: string | null | undefined): string {
  if (!email) return "";
  return isUsernameEmail(email) ? email.trim().toLowerCase().slice(0, -(USERNAME_DOMAIN.length + 1)) : email;
}

/**
 * What a person typed in the sign-in box → the address Supabase Auth expects.
 * An email is used as is (except the reserved domain, which must be typed as a
 * username); anything without "@" must be a valid username.
 */
export function signInAddress(input: string): { ok: true; email: string } | { ok: false; error: string } {
  const v = input.trim();
  if (!v) return { ok: false, error: "Enter your email or username." };
  if (v.includes("@")) {
    if (isUsernameEmail(v)) return { ok: false, error: "Sign in with your username." };
    return { ok: true, email: v };
  }
  if (!isValidUsername(v)) return { ok: false, error: "Enter a valid email address or username." };
  return { ok: true, email: usernameEmail(v) };
}
