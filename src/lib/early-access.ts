// Early-access codes: format and normalization shared by the server and the
// operator script. Codes are never stored; the database keeps a SHA-256 hash.

/** Crockford base32 without I, L, O, U (easy to read aloud and type). */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Upper-case, drop spaces and dashes, map look-alikes (O→0, I/L→1) after the "TLT" prefix. */
export function normalizeAccessCode(input: string): string {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  const body = s.startsWith("TLT") ? s.slice(3) : s;
  return "TLT" + body.replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** "TLT" + 20 characters (100 bits of randomness), grouped for reading. */
export function formatAccessCode(raw: string): string {
  return `TLT-${raw.match(/.{1,5}/g)!.join("-")}`;
}

export function looksLikeAccessCode(input: string): boolean {
  const n = normalizeAccessCode(input);
  return /^TLT[0-9A-HJKMNP-TV-Z]{20}$/.test(n);
}

export const ACCESS_CODE_ERRORS: Record<string, string> = {
  unknown: "This access code is not valid.",
  expired: "This access code has expired. Ask us for a new one.",
  revoked: "This access code is no longer valid. Ask us for a new one.",
  used_up: "This access code has already been used. Ask us for a new one.",
  rate_limited: "Too many attempts. Wait 15 minutes and try again.",
  company_name: "Enter the company name (2 to 120 characters).",
  pending: "This account already has a company waiting to be created. Sign in to finish it.",
  conflict: "This request was already used. Reload the page and try again.",
};
