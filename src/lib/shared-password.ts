// The shared Early Access password (server only: imported by the early-access
// action and its tests, never by client code). The expected password comes
// from the server environment; it is never sent to the browser, stored in the
// database or logged. The database gets only a fingerprint keyed with the
// server's signing secret, so it can tell one password from the next (a new
// password retires the old one's devices) without being able to recover it.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Shortest accepted password: anything shorter is treated as not configured. */
export const SHARED_PASSWORD_MIN_LENGTH = 12;
export const SHARED_PASSWORD_MAX_LENGTH = 128;

/** The configured password, or null when unset or too short (the shared password is then off). */
export function parseSharedPassword(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return v.length >= SHARED_PASSWORD_MIN_LENGTH && v.length <= SHARED_PASSWORD_MAX_LENGTH ? v : null;
}

/** EARLY_ACCESS_PASSWORD_MAX_DEVICES: devices admitted at the same time (1–1000, default 500). */
export function parseMaxDevices(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 1000) : 500;
}

const digest = (key: string, value: string) => createHmac("sha256", key).update(`shared-password.v1:${value}`).digest();

/**
 * Constant-time comparison: both sides are hashed to the same length first, so
 * neither the content nor the length of the expected password leaks through timing.
 * Exact match after trimming surrounding spaces (passwords are case-sensitive).
 */
export function sharedPasswordMatches(input: string, expected: string, key: string): boolean {
  if (!key || !expected) return false;
  return timingSafeEqual(digest(key, input.trim()), digest(key, expected));
}

/** What the database stores for the password: 64 hex characters, not reversible without the server secret. */
export function sharedPasswordFingerprint(password: string, key: string): string {
  return digest(key, password).toString("hex");
}
