import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { SHARED_DEVICE_COOKIE } from "@/lib/shared-device";
import { recordSignInFailure, signInAllowed } from "@/server/signin-limit";
import { redeemQrToken } from "@/server/signin-qr";

// The phone posts the token from a scanned QR code here (src/app/auth/qr/qr-sign-in.tsx). Reachable without sign-in
// and without early access (a brand-new phone has neither); a valid, unused code made by the office is the proof.
// Same-origin only; invented codes are counted per network address (8 in 15 minutes, then refused). Never logs the token.

const reply = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let sameOrigin = false;
  try {
    sameOrigin = Boolean(origin && host && new URL(origin).host === host);
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return reply(403, { ok: false, reason: "invalid" });

  const ip = (request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "local").trim();
  const key = `qr-sign-in:${ip}`;
  if (!(await signInAllowed(key))) return reply(429, { ok: false, reason: "limited" });

  let token: unknown = null;
  try {
    const body = (await request.json()) as { token?: unknown } | null;
    token = body?.token ?? null;
  } catch {
    token = null;
  }
  const result = await redeemQrToken(token);
  if (!result.ok) {
    // Only invented codes count: drivers rescanning a used or expired code (often behind one depot address) do not.
    if (result.reason === "invalid") await recordSignInFailure(key);
    return reply(result.reason === "unavailable" ? 503 : 400, { ok: false, reason: result.reason });
  }
  // A phone signed in by its driver's own code is a personal device: stay signed in (as "Stay signed in").
  (await cookies()).delete(SHARED_DEVICE_COOKIE);
  // QR codes are only for driver sign-ins: their home is My Day.
  return reply(200, { ok: true, next: "/driver" });
}
