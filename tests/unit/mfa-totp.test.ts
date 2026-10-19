import { describe, expect, it } from "vitest";
import { totp } from "../e2e/mfa";

// The browser tests' authenticator must compute codes exactly like a phone app (RFC 6238 test vector, SHA-1).
describe("test authenticator", () => {
  it("matches the RFC 6238 SHA-1 vectors (last 6 digits)", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890" in base32
    expect(totp(secret, 59_000)).toBe("287082");
    expect(totp(secret, 1_111_111_109_000)).toBe("081804");
    expect(totp(secret, 2_000_000_000_000)).toBe("279037");
  });
});
