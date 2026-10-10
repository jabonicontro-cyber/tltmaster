import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { signSiteAccess, verifySiteAccess } from "@/lib/site-access-token";
import { OFFLINE_GRACE_SECONDS, accessCookieName, isGateExempt, revalidateGrant, revalidateSeconds, siteGate } from "@/server/site-access";

const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/auth/callback", "/auth/confirm", "/auth/error", "/early-access"];

const isHttps = (request: NextRequest) =>
  request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";

/**
 * Runs before every route (pages, server actions, route handlers, files):
 *
 * 1. Early-access gate (when enabled): a visitor who is not signed in needs a
 *    valid early-access grant — a signed HttpOnly cookie issued after a valid
 *    code, re-checked with the database every few minutes so revocation takes
 *    effect. Without it, pages redirect to /early-access and everything else
 *    gets 401. Signed-in users pass: accounts exist only by invitation or an
 *    approved early-access sign-up. Passing the gate grants no account,
 *    company, membership or permission.
 * 2. Refreshes the Supabase session cookie and sends anonymous visitors to sign in.
 *
 * Authorization is enforced again on the server for every page and action
 * (src/server/auth.ts) and by RLS in the database.
 */
export async function proxy(request: NextRequest) {
  const gate = siteGate();
  if (gate.enabled && !gate.secret) {
    // Fail closed: never serve the app with a gate that cannot verify anything.
    return new NextResponse("Early access is not configured on this server.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }

  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return gate.enabled ? new NextResponse("Not configured.", { status: 503 }) : response;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // Do not run code between createServerClient and getClaims().
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  const path = request.nextUrl.pathname;

  // 1. Early-access gate.
  if (gate.enabled && gate.secret && !signedIn && !isGateExempt(path)) {
    const secure = isHttps(request);
    const name = accessCookieName(secure);
    const now = Math.floor(Date.now() / 1000);
    let claims = verifySiteAccess(request.cookies.get(name)?.value, gate.secret, now);
    let refreshed: string | null = null;
    if (claims && now - claims.c >= revalidateSeconds()) {
      const check = await revalidateGrant(claims.g);
      if (check === null) {
        // Database unreachable: keep a recently confirmed grant for a while, then refuse.
        if (now - claims.c > OFFLINE_GRACE_SECONDS) claims = null;
      } else if (!check.valid) {
        claims = null;
      } else {
        const x = Math.min(claims.x, check.expiresAt ? Math.floor(new Date(check.expiresAt).getTime() / 1000) : claims.x);
        claims = { g: claims.g, x, c: now };
        refreshed = signSiteAccess(claims, gate.secret);
      }
    }
    if (!claims) {
      const wantsPage = (request.method === "GET" || request.method === "HEAD") && (request.headers.get("accept") ?? "").includes("text/html");
      const denied = wantsPage
        ? NextResponse.redirect(new URL(`/early-access${path === "/" ? "" : `?next=${encodeURIComponent(path + request.nextUrl.search)}`}`, request.url))
        : NextResponse.json({ error: "Early access required." }, { status: 401 });
      denied.headers.set("cache-control", "no-store");
      denied.cookies.delete(name);
      return denied;
    }
    if (refreshed) {
      response.cookies.set(name, refreshed, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: Math.max(claims.x - now, 0) });
    }
  }

  // 2. Sign-in.
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
  if (!signedIn && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = path === "/" ? "" : `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    const redirect = NextResponse.redirect(loginUrl);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
