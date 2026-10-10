import "server-only";
import { cookies, headers } from "next/headers";
import { verifySiteAccess } from "@/lib/site-access-token";
import { accessCookieName, siteGate } from "./site-access";

/** Whether the current request is HTTPS (directly or behind the host's proxy). */
export async function requestIsHttps(): Promise<boolean> {
  const h = await headers();
  return h.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

/**
 * Defense in depth for actions reachable before sign-in (sign-in, password
 * reset, sign-up): the proxy already enforces the gate, and these re-verify the
 * signed cookie themselves so a routing change can never open them.
 */
export async function hasSiteAccess(): Promise<boolean> {
  const gate = siteGate();
  if (!gate.enabled) return true;
  if (!gate.secret) return false;
  const jar = await cookies();
  const secure = await requestIsHttps();
  return verifySiteAccess(jar.get(accessCookieName(secure))?.value, gate.secret) !== null;
}

export const EARLY_ACCESS_REQUIRED = "Early access is required. Open the early-access page and enter your access code.";
