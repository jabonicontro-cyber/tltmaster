// The early-access cookie: a signed, short statement "this browser holds grant
// G until X, last confirmed with the database at C". HMAC-SHA256 with a server
// secret (SITE_ACCESS_SECRET); verified with a constant-time comparison. It
// carries no code and no personal data. Server only (proxy and server code).
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SiteAccessClaims {
  /** Grant id in private.site_access_grants. */
  g: string;
  /** Expiry, seconds since epoch. */
  x: number;
  /** Last confirmed with the database, seconds since epoch. */
  c: number;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const mac = (body: string, secret: string) => createHmac("sha256", secret).update(`site-access.v1.${body}`).digest();

export function signSiteAccess(claims: SiteAccessClaims, secret: string): string {
  const body = b64(JSON.stringify(claims));
  return `v1.${body}.${mac(body, secret).toString("base64url")}`;
}

/** The claims when the token is authentic and unexpired; otherwise null. */
export function verifySiteAccess(token: string | undefined | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): SiteAccessClaims | null {
  if (!token || token.length > 512 || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, body, sig] = parts;
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = mac(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const c = claims as Partial<SiteAccessClaims>;
  if (typeof c.g !== "string" || !/^[0-9a-f-]{36}$/i.test(c.g) || typeof c.x !== "number" || typeof c.c !== "number") return null;
  if (c.x <= nowSeconds) return null;
  return { g: c.g, x: c.x, c: c.c };
}
