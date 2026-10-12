import { timingSafeEqual } from "node:crypto";

/** Constant-time check of "Authorization: Bearer <CRON_SECRET>" (Vercel Cron sends it when CRON_SECRET is set). */
export function authorizedCron(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A housekeeping run failed (partly) when any company failed or any expired file could not be removed. */
export function housekeepingFailed(result: { failed?: unknown[] } | null | undefined, fileErrors: number): boolean {
  return (result?.failed?.length ?? 0) > 0 || fileErrors > 0;
}
