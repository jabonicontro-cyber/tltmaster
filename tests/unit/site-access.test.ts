import { afterEach, describe, expect, it, vi } from "vitest";
import { signSiteAccess, verifySiteAccess } from "@/lib/site-access-token";
import { accessCookieName, isGateExempt, revalidateSeconds, siteGate } from "@/server/site-access";

const SECRET = "s".repeat(40);
const G = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000;

describe("early-access cookie", () => {
  it("verifies only authentic, unexpired tokens", () => {
    const t = signSiteAccess({ g: G, x: NOW + 3600, c: NOW }, SECRET);
    expect(verifySiteAccess(t, SECRET, NOW)).toEqual({ g: G, x: NOW + 3600, c: NOW });
    expect(verifySiteAccess(t, SECRET, NOW + 3600)).toBeNull(); // expired
    expect(verifySiteAccess(t, "t".repeat(40), NOW)).toBeNull(); // another secret (rotation signs everyone out)
    const [v, body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ g: G, x: NOW + 999999, c: NOW })).toString("base64url");
    expect(verifySiteAccess(`${v}.${forged}.${sig}`, SECRET, NOW)).toBeNull(); // extended expiry, old signature
    expect(verifySiteAccess(`${v}.${body}.${sig.slice(0, -2)}AA`, SECRET, NOW)).toBeNull();
    for (const bad of ["", "v1", "v2.a.b", `${v}.${body}`, "x".repeat(600), undefined, null]) expect(verifySiteAccess(bad as string, SECRET, NOW)).toBeNull();
    expect(verifySiteAccess(t, "", NOW)).toBeNull();
  });

  it("contains no code and no personal data — only the grant id and times", () => {
    const t = signSiteAccess({ g: G, x: NOW + 60, c: NOW }, SECRET);
    expect(JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString())).toEqual({ g: G, x: NOW + 60, c: NOW });
  });
});

describe("gate configuration", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is on by default in production, off in development, and fails closed without a long secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EARLY_ACCESS_GATE", "");
    vi.stubEnv("SITE_ACCESS_SECRET", "short");
    expect(siteGate()).toMatchObject({ enabled: true, secret: null });
    vi.stubEnv("EARLY_ACCESS_GATE", "off");
    expect(siteGate().enabled).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EARLY_ACCESS_GATE", "");
    expect(siteGate().enabled).toBe(false);
    vi.stubEnv("EARLY_ACCESS_GATE", "on");
    vi.stubEnv("SITE_ACCESS_SECRET", SECRET);
    vi.stubEnv("EARLY_ACCESS_DAYS", "500");
    expect(siteGate()).toEqual({ enabled: true, secret: SECRET, days: 90 });
    vi.stubEnv("EARLY_ACCESS_RECHECK_SECONDS", "");
    expect(revalidateSeconds()).toBe(300);
  });

  it("uses a __Host- cookie on HTTPS and exempts only the gate and Auth email links", () => {
    expect(accessCookieName(true)).toBe("__Host-taviron-access");
    expect(accessCookieName(false)).toBe("taviron-access");
    for (const p of ["/early-access", "/auth/confirm", "/auth/callback", "/auth/error"]) expect(isGateExempt(p), p).toBe(true);
    for (const p of ["/", "/login", "/signup", "/forgot-password", "/command-center", "/tickets/photos/x", "/early-accessx", "/auth/confirmx", "/driver/photos"]) expect(isGateExempt(p), p).toBe(false);
  });
});
