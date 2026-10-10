import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ACCESS_CODE_ERRORS, CODE_ALPHABET, formatAccessCode, looksLikeAccessCode, normalizeAccessCode } from "@/lib/early-access";

describe("early-access codes", () => {
  it("normalize forgiving input to one canonical form", () => {
    expect(normalizeAccessCode("tlt-abc12 de34f-ghjkm-npqrs")).toBe("TLTABC12DE34FGHJKMNPQRS");
    expect(normalizeAccessCode("TLT-0OIL1")).toBe("TLT00111"); // O→0, I/L→1 after the prefix
    expect(normalizeAccessCode("abcde")).toBe("TLTABCDE"); // prefix optional
  });

  it("recognise the issued format only", () => {
    const raw = "ABCDE".repeat(4);
    expect(formatAccessCode(raw)).toBe("TLT-ABCDE-ABCDE-ABCDE-ABCDE");
    expect(looksLikeAccessCode(formatAccessCode(raw))).toBe(true);
    expect(looksLikeAccessCode("tlt abcde abcde abcde abcde")).toBe(true);
    expect(looksLikeAccessCode("TLT-ABCDE")).toBe(false);
    expect(looksLikeAccessCode("XYZ-ABCDE-ABCDE-ABCDE-ABCDE")).toBe(false);
    expect(looksLikeAccessCode("TLT-UUUUU-UUUUU-UUUUU-UUUUU")).toBe(false); // U is not in the alphabet
    expect(CODE_ALPHABET).toHaveLength(32);
  });

  it("the operator script hashes exactly like the server", () => {
    const code = "tlt-7x9k2-mm4qa-z81bc-hj5rt";
    const server = createHash("sha256").update(normalizeAccessCode(code)).digest("hex");
    const script = execFileSync("node", ["scripts/early-access.mjs", "hash", code], { encoding: "utf8" }).trim();
    expect(script).toBe(server);
  });

  it("explains every refusal without revealing more than needed", () => {
    for (const k of ["unknown", "expired", "revoked", "used_up", "rate_limited"]) expect(ACCESS_CODE_ERRORS[k]).toBeTruthy();
  });
});
