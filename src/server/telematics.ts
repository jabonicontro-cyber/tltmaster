import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { FEED_KEY_PATTERN } from "@/lib/telematics";

// GPS and hours feed keys (B101). The key is shown once to the person who creates it; the database keeps only its
// SHA-256 (telematics_settings.feed_key_hash) and the last four characters as a hint. Never logged.

export function generateFeedKey(): { key: string; hash: string; hint: string } {
  const key = `tlk_${randomBytes(20).toString("hex")}`;
  return { key, hash: hashFeedKey(key), hint: key.slice(-4) };
}

export function hashFeedKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** The key from "Authorization: Bearer tlk_…", or null when it is missing or malformed. */
export function feedKeyFrom(authorization: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? "");
  return m && FEED_KEY_PATTERN.test(m[1]) ? m[1] : null;
}
