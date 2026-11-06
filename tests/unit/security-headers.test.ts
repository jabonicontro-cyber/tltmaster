import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "@/lib/security-headers";
import { sessionCookieOptions, SESSION_MAX_AGE_SECONDS } from "@/lib/session-cookie";

// Security review 2026-11-06 (M4): the sign-in cookie cannot be read by scripts, and the browser loads and sends data
// only to this site and the database's storage host.

describe("session cookie", () => {
  it("is httpOnly, lax, 30 days, and Secure except on a plain-HTTP local server", () => {
    expect(sessionCookieOptions("https://mytaviron.com")).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS });
    expect(sessionCookieOptions("http://localhost:3000").secure).toBe(false);
    expect(sessionCookieOptions("").secure).toBe(true);
    expect(SESSION_MAX_AGE_SECONDS).toBe(2_592_000);
  });
});

describe("content security policy", () => {
  const csp = contentSecurityPolicy("https://abc.supabase.co/");
  const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));
  it("allows only this site and the storage host, and nothing frames, posts or rebases elsewhere", () => {
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("img-src")).toBe("img-src 'self' data: blob: https://abc.supabase.co");
    expect(directive("connect-src")).toBe("connect-src 'self' https://abc.supabase.co");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'self'");
    expect(directive("form-action")).toBe("form-action 'self'");
    expect(directive("base-uri")).toBe("base-uri 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp).not.toMatch(/\*/);
  });
  it("adds eval and websockets only for the development server, and survives a missing or bad URL", () => {
    expect(contentSecurityPolicy(undefined, true)).toMatch(/script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
    expect(contentSecurityPolicy("not a url")).toMatch(/img-src 'self' data: blob:;/);
  });
});
