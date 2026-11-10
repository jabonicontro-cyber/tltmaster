// QR sign-in tokens (DS1): 256 random bits as base64url, carried only in the address's fragment, parsed strictly, and
// refusals in plain words that never name the driver.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bytesToBase64Url, isQrToken, newQrToken, QR_PATH, qrRefusalMessage, qrSignInUrl, qrStatusLabel, tokenFromFragment } from "@/lib/signin-qr";

describe("QR sign-in tokens", () => {
  it("are 32 random bytes in base64url (43 characters), different every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = newQrToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isQrToken(t)).toBe(true);
      expect(Buffer.from(t, "base64url")).toHaveLength(32);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });

  it("encode bytes like Node's base64url", () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 250, 1, 2]);
    expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
  });

  it("travel in the fragment only, never the path or the query", () => {
    const t = newQrToken();
    const url = new URL(qrSignInUrl("https://tltmaster.vercel.app/", t));
    expect(url.pathname).toBe(QR_PATH);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#t=${t}`);
    expect(tokenFromFragment(url.hash)).toBe(t);
  });

  it("refuse malformed fragments", () => {
    for (const h of ["", "#", "#t=", "#t=short", `#t=${"A".repeat(42)}`, `#t=${"A".repeat(44)}`, `#t=${"A".repeat(42)}=`, `#x=${"A".repeat(43)}`, `#t=${"A".repeat(42)}/`]) {
      expect(tokenFromFragment(h), h).toBeNull();
    }
    expect(isQrToken(null)).toBe(false);
    expect(isQrToken(123)).toBe(false);
  });

  it("explain refusals in plain words without naming anyone", () => {
    for (const r of ["invalid", "used", "expired", "replaced", "not_allowed", "limited", "unavailable", "failed", "anything"]) {
      const m = qrRefusalMessage(r);
      expect(m.length).toBeGreaterThan(20);
      expect(m).not.toMatch(/—|token|hash|error/i);
    }
    expect(qrStatusLabel("used")).toEqual({ text: expect.stringMatching(/Signed in/), done: true });
    expect(qrStatusLabel("waiting").done).toBe(false);
  });

  it("server code never logs the token", () => {
    for (const f of ["src/server/signin-qr.ts", "src/app/auth/qr/redeem/route.ts"]) {
      const src = readFileSync(f, "utf8");
      for (const line of src.split("\n").filter((l) => /console\./.test(l))) expect(line, f).not.toMatch(/token|email|hashed|url/i);
    }
  });
});
