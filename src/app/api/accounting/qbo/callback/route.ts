import { NextResponse, type NextRequest } from "next/server";
import { QBO_SUPPORT_VISIT_MESSAGE } from "@/lib/accounting/qbo";
import { can } from "@/lib/permissions";
import { companyName, exchangeCode, qboConfigured, saveTokens } from "@/server/accounting/qbo";
import { getAccess } from "@/server/auth";
import { env } from "@/server/env";
import { createClient } from "@/server/supabase/server";

// Intuit sends the person back here after they approve the connection (master plan B82). The state must match the
// cookie set by /connect for the same company; the code is exchanged on the server and the tokens stored encrypted.
// Never during a Taviron support visit (financial review L3), and never onto a business already connected to another
// QuickBooks company (disconnect first); the database refuses both too (20261120018100).

const STATE_COOKIE = "taviron-qbo-state";

export async function GET(req: NextRequest) {
  const base = env().APP_BASE_URL;
  const done = (q: string) => {
    const res = NextResponse.redirect(`${base}/billing/setup?${q}`);
    res.cookies.delete({ name: STATE_COOKIE, path: "/api/accounting/qbo" });
    return res;
  };
  const access = await getAccess();
  if (access?.support) return done(`error=${encodeURIComponent(QBO_SUPPORT_VISIT_MESSAGE)}`);
  if (!access?.companyId || !can(access, "billing.manage") || access.isDemo || !qboConfigured()) return done(`error=${encodeURIComponent("QuickBooks could not be connected from this account.")}`);
  const url = req.nextUrl;
  if (url.searchParams.get("error")) return done(`error=${encodeURIComponent("QuickBooks connection was canceled.")}`);
  const [state, company, entity] = (req.cookies.get(STATE_COOKIE)?.value ?? "").split(".");
  const code = url.searchParams.get("code");
  const realm = url.searchParams.get("realmId");
  if (!state || state !== url.searchParams.get("state") || company !== access.companyId || !code || !realm) {
    return done(`error=${encodeURIComponent("The QuickBooks connection could not be verified. Try again.")}`);
  }
  try {
    const environment = env().QBO_ENVIRONMENT;
    const supabase = await createClient();
    // Already connected to another QuickBooks company: stop before exchanging the code, so no tokens are issued.
    let current = supabase.from("accounting_connections").select("realm_id, environment");
    current = entity ? current.eq("billing_entity_id", entity) : current.is("billing_entity_id", null);
    const { data: existing } = await current.maybeSingle();
    const was = existing as { realm_id: string; environment: string } | null;
    if (was && (was.realm_id !== realm || was.environment !== environment)) {
      return done(`error=${encodeURIComponent("This business is already connected to another QuickBooks company. Disconnect it first, then connect the other company.")}`);
    }
    const tokens = await exchangeCode(code);
    const save = (name: string) => supabase.rpc("accounting_save_connection", { p_entity: entity || null, p_environment: environment, p_realm: realm, p_company_name: name });
    const first = await save("");
    if (first.error) throw new Error(first.error.message);
    const connectionId = first.data as string;
    await saveTokens(connectionId, tokens);
    const name = await companyName({ connectionId, realmId: realm, environment }).catch(() => "");
    if (name) await save(name);
    return done("saved=connected");
  } catch (e) {
    return done(`error=${encodeURIComponent(e instanceof Error ? e.message : "QuickBooks could not be connected.")}`);
  }
}
