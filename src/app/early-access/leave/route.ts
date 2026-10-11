import { NextResponse, type NextRequest } from "next/server";
import { verifySiteAccess } from "@/lib/site-access-token";
import { accessCookieName, siteGate } from "@/server/site-access";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";

/**
 * "Remove early access from this browser": ends this device's grant in the
 * database (so a copy of the cookie stops working too) and deletes the cookie.
 * POST only; the cookie is SameSite=Lax, so another site cannot trigger it with
 * this browser's grant. Does not sign anyone out of their account.
 */
export async function POST(request: NextRequest) {
  const gate = siteGate();
  const secure = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  const name = accessCookieName(secure);
  const claims = gate.secret ? verifySiteAccess(request.cookies.get(name)?.value, gate.secret) : null;
  if (claims && adminAvailable()) {
    const { error } = await createAdminClient().rpc("site_access_revoke_grant", { p_grant_id: claims.g, p_reason: "Left early access on this device" });
    if (error) console.error("Could not end early access for this device", error.code);
  }
  const res = NextResponse.redirect(new URL("/early-access?left=1", request.url), 303);
  res.cookies.delete(name);
  res.headers.set("cache-control", "no-store");
  return res;
}
