import "server-only";
import { createHash, createHmac } from "node:crypto";
import { headers } from "next/headers";
import { normalizeAccessCode } from "@/lib/early-access";

/** SHA-256 of the normalized code: the only form the database ever sees. */
export function accessCodeHash(code: string): string {
  return createHash("sha256").update(normalizeAccessCode(code)).digest("hex");
}

/**
 * Keyed hash for rate-limit keys (IP address, email), so the database never
 * stores the raw values. Uses the server-only service-role key as the secret.
 */
export function rateKey(value: string): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createHmac("sha256", secret).update(value.trim().toLowerCase()).digest("hex");
}

/**
 * Client IP for rate limiting. Behind a host such as Vercel the first
 * x-forwarded-for entry is set by the platform; locally it may be absent.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "local").trim();
}
