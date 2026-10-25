import { NextResponse, type NextRequest } from "next/server";
import { can } from "@/lib/permissions";
import { companyName, exchangeCode, qboConfigured, saveTokens } from "@/server/accounting/qbo";
import { getAccess } from "@/server/auth";
import { env } from "@/server/env";
import { createClient } from "@/server/supabase/server";

// Intuit sends the person back here after they approve the connection (master plan B82). The state must match the
// cookie set by /connect for the same company; the code is exchanged on the server and the tokens stored encrypted.

const STATE_COOKIE = "taviron-qbo-state";

export async function GET(req: NextRequest) {
  const base = env().APP_BASE_URL;
  const done = (q: string) => {
    const res = NextResponse.redirect(`${base}/billing/quickbooks?${q}`);
    res.cookies.delete({ name: STATE_COOKIE, path: "/api/accounting/qbo" });
    return res;
  };
  const access = await getAccess();
  if (!access?.companyId || !can(access, "billing.manage") || access.isDemo || !qboConfigured()) return done(`error=${encodeURIComponent("QuickBooks could not be connected from this account.")}`);
  const url = req.nextUrl;
  if (url.searchParams.get("error")) return done(`error=${encodeURIComponent("QuickBooks connection was canceled.")}`);
  const [state, company] = (req.cookies.get(STATE_COOKIE)?.value ?? "").split(".");
  const code = url.searchParams.get("code");
  const realm = url.searchParams.get("realmId");
  if (!state || state !== url.searchParams.get("state") || company !== access.companyId || !code || !realm) {
    return done(`error=${encodeURIComponent("The QuickBooks connection could not be verified. Try again.")}`);
  }
  try {
    const tokens = await exchangeCode(code);
    await saveTokens(access.companyId, tokens);
    const environment = env().QBO_ENVIRONMENT;
    const name = await companyName({ companyId: access.companyId, realmId: realm, environment }).catch(() => "");
    const supabase = await createClient();
    const { error } = await supabase.rpc("accounting_save_connection", { p_environment: environment, p_realm: realm, p_company_name: name });
    if (error) throw new Error(error.message);
    return done("saved=connected");
  } catch (e) {
    return done(`error=${encodeURIComponent(e instanceof Error ? e.message : "QuickBooks could not be connected.")}`);
  }
}
