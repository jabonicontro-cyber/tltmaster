// One-time QR sign-in codes for drivers (master plan DS1; migration 20261120017000). Pure helpers shared by the server
// and the phone's page. The token is 32 random bytes (256 bits) written as base64url (43 characters). It travels only
// in the address's fragment ("#…"), which browsers never send to a server: it stays out of request logs, proxies and
// referrers. The phone's page reads it, removes it from the address bar and posts it once to /auth/qr/redeem.

export const QR_PATH = "/auth/qr";
export const QR_REDEEM_PATH = "/auth/qr/redeem";
/** Minutes a code works (the database sets the same expiry). */
export const QR_MINUTES = 10;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isQrToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/** base64url without padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new random token (Web Crypto: works on the server and in browsers). */
export function newQrToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/** The address the QR code holds: the site's sign-in page with the token in the fragment. */
export function qrSignInUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${QR_PATH}#t=${token}`;
}

/** The token from a fragment such as "#t=…" (null when it is missing or malformed). */
export function tokenFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const t = params.get("t");
  return isQrToken(t) ? t : null;
}

export type QrRefusal = "invalid" | "used" | "expired" | "replaced" | "not_allowed" | "limited" | "unavailable" | "failed";

/** What the phone shows when a code does not sign it in. Plain words; never says whose code it was. */
export function qrRefusalMessage(reason: QrRefusal | string): string {
  switch (reason) {
    case "used":
      return "This code was already used. Each code works once. Ask the office to show a new one.";
    case "expired":
      return `This code has expired (codes work for ${QR_MINUTES} minutes). Ask the office to show a new one.`;
    case "replaced":
      return "This code was replaced or cancelled. Scan the newest code the office shows you.";
    case "not_allowed":
      return "This code cannot sign in right now. Ask the office to check your sign-in.";
    case "limited":
      return "Too many tries from this network. Wait 15 minutes and try again.";
    case "unavailable":
      return "Signing in with a code is not set up on this server. Sign in with your username and password.";
    case "failed":
      return "The code was accepted, but this phone could not be signed in. Ask the office to show a new code.";
    default:
      return "This code is not valid. Scan the code again, or ask the office to show a new one.";
  }
}

/** The office window's line for the code's state (from public.signin_qr_status). */
export function qrStatusLabel(status: string): { text: string; done: boolean } {
  switch (status) {
    case "waiting":
      return { text: "Waiting for the phone to scan it…", done: false };
    case "used":
      return { text: "Signed in on the phone. You can close this window.", done: true };
    case "expired":
      return { text: "This code expired. Show a new code if the driver still needs one.", done: true };
    case "failed":
      return { text: "The phone scanned the code but could not be signed in. Show a new code.", done: true };
    case "refused":
      return { text: "The code was refused when it was scanned (the sign-in changed). Check the sign-in, then show a new code.", done: true };
    case "replaced":
    case "cancelled":
      return { text: "This code no longer works.", done: true };
    default:
      return { text: "", done: false };
  }
}
