import { describe, expect, it } from "vitest";
import { parseMaxDevices, parseSharedPassword, sharedPasswordFingerprint, sharedPasswordMatches } from "@/lib/shared-password";

const KEY = "k".repeat(40);

describe("shared early-access password", () => {
  it("is off unless a long enough password is configured", () => {
    expect(parseSharedPassword(undefined)).toBeNull();
    expect(parseSharedPassword("")).toBeNull();
    expect(parseSharedPassword("   ")).toBeNull();
    expect(parseSharedPassword("short-pass1")).toBeNull(); // 11 characters
    expect(parseSharedPassword("  long-enough-1  ")).toBe("long-enough-1");
    expect(parseSharedPassword("x".repeat(129))).toBeNull();
  });

  it("matches exactly (case-sensitive, surrounding spaces ignored) and never with an empty key", () => {
    expect(sharedPasswordMatches("Quarry-Season-2026", "Quarry-Season-2026", KEY)).toBe(true);
    expect(sharedPasswordMatches("  Quarry-Season-2026 ", "Quarry-Season-2026", KEY)).toBe(true);
    expect(sharedPasswordMatches("quarry-season-2026", "Quarry-Season-2026", KEY)).toBe(false);
    expect(sharedPasswordMatches("Quarry-Season-202", "Quarry-Season-2026", KEY)).toBe(false);
    expect(sharedPasswordMatches("", "Quarry-Season-2026", KEY)).toBe(false);
    expect(sharedPasswordMatches("Quarry-Season-2026", "Quarry-Season-2026", "")).toBe(false);
  });

  it("fingerprints are 64 hex characters, differ by password and key, and do not contain the password", () => {
    const a = sharedPasswordFingerprint("Quarry-Season-2026", KEY);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sharedPasswordFingerprint("Quarry-Season-2027", KEY)).not.toBe(a);
    expect(sharedPasswordFingerprint("Quarry-Season-2026", "other-key-".repeat(4))).not.toBe(a);
    expect(a).not.toContain("Quarry");
  });

  it("bounds the device cap", () => {
    expect(parseMaxDevices(undefined)).toBe(500);
    expect(parseMaxDevices("abc")).toBe(500);
    expect(parseMaxDevices("0")).toBe(1);
    expect(parseMaxDevices("25")).toBe(25);
    expect(parseMaxDevices("5000")).toBe(1000);
  });
});
