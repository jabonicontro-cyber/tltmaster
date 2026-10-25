import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { can } from "@/lib/permissions";
import { authorizeUrl, qboConfigured } from "@/server/accounting/qbo";
import { getAccess } from "@/server/auth";
import { env } from "@/server/env";

// Start connecting QuickBooks Online (master plan B82): billing.manage only, never in a demo company (demos simulate).
// The state value is kept in a short-lived, HTTP-only cookie and checked on the way back.

const STATE_COOKIE = "taviron-qbo-state";

export async function GET(req: NextRequest) {
  const access = await getAccess();
  const back = (msg: string) => NextResponse.redirect(`${env().APP_BASE_URL}/billing/setup?error=${encodeURIComponent(msg)}`);
  if (!access?.companyId || !can(access, "billing.manage")) return back("You need billing management to connect QuickBooks.");
  if (access.isDemo) return back("Demo companies do not connect to QuickBooks; sending is simulated.");
  if (!qboConfigured()) return back("QuickBooks is not set up for Taviron yet (the app keys are missing).");
  // Which business this QuickBooks belongs to (none = the whole company). Checked again when the connection is saved.
  const entity = req.nextUrl.searchParams.get("entity") ?? "";
  if (entity && !/^[0-9a-f-]{36}$/.test(entity)) return back("Choose a business.");
  const state = randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(authorizeUrl(state));
  res.cookies.set(STATE_COOKIE, `${state}.${access.companyId}.${entity}`, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/accounting/qbo", maxAge: 600 });
  return res;
}
