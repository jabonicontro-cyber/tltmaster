import { createHmac } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two-step verification in browser tests: global-setup enrolls an authenticator (TOTP) for the platform test account
// and for every shared test user the database says must use one (money access, 20261120018000), and leaves each secret
// in a file; tests compute the current code like a phone would (RFC 6238, SHA-1, 6 digits, 30 s).
export const TOTP_FILE = join(tmpdir(), "taviron-e2e-platform-totp");

/** Where the authenticator secret of a shared test user (a tests/e2e/users.ts key) is kept for this run. */
export const userTotpFile = (who: string) => join(tmpdir(), `taviron-e2e-totp-${who}`);

export function writeUserTotpSecret(who: string, secret: string | null) {
  if (secret) writeFileSync(userTotpFile(who), secret, { mode: 0o600 });
  else rmSync(userTotpFile(who), { force: true });
}

/** The user's authenticator secret, or null when this user signs in with the password alone. */
export function userTotpSecret(who: string): string | null {
  const f = userTotpFile(who);
  return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null;
}

function base32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v >= 0) bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

export function platformTotpSecret(): string {
  return readFileSync(TOTP_FILE, "utf8").trim();
}
