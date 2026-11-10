import { describe, expect, it } from "vitest";
import { MONEY_MFA_REASON, MONEY_PERMISSIONS, mfaReason, recoveryCodesPending } from "@/lib/mfa-policy";
import { PERMISSIONS } from "@/lib/permissions";

// Two-step verification is always required for money access (20261120018000). The database decides; these words and
// the list are what the app shows and what the database list is checked against (tests/db/money-two-step.test.ts).

describe("two-step verification reasons", () => {
  it("names the most specific reason first, and nothing when nothing requires it", () => {
    expect(mfaReason({ platform: true, money: true, current_company: true })).toBe("Platform administrators must use two-step verification.");
    expect(mfaReason({ platform: false, money: true, current_company: true })).toBe(MONEY_MFA_REASON);
    expect(mfaReason({ platform: false, money: false, current_company: true })).toBe("Your company requires two-step verification.");
    expect(mfaReason({ platform: false, money: false, current_company: false })).toBeNull();
    // A database before 20261120018000 has no money field: the company rule still applies, nothing more.
    expect(mfaReason({ platform: false, current_company: false })).toBeNull();
  });

  it("says why in plain words, without permission codes", () => {
    expect(MONEY_MFA_REASON).toBe("Your access to invoices, payments or pay requires two-step verification.");
    expect(MONEY_MFA_REASON).not.toMatch(/[a-z]+\.[a-z]+/);
  });

  it("the money list holds known permissions only, every billing, pricing, pay and cost one included", () => {
    for (const p of MONEY_PERMISSIONS) expect(PERMISSIONS).toContain(p);
    expect(new Set(MONEY_PERMISSIONS).size).toBe(MONEY_PERMISSIONS.length);
    const money = PERMISSIONS.filter((p) => /^(billing|accounting|payroll|pricing)\./.test(p) || ["employees.compensation", "maintenance.costs"].includes(p));
    for (const p of money) expect(MONEY_PERMISSIONS as readonly string[]).toContain(p);
  });
});

describe("recovery codes for money access (owner 2026-11-10)", () => {
  it("are pending for a verified person with money access until the database reports them ready", () => {
    const money = { money: true, recovery_codes: 10 };
    expect(recoveryCodesPending({ ...money, recovery_ready: false }, "aal2")).toBe(true);
    expect(recoveryCodesPending({ ...money, recovery_ready: true }, "aal2")).toBe(false);
    // Below aal2 the person verifies first; without money access nothing waits for codes.
    expect(recoveryCodesPending({ ...money, recovery_ready: false }, "aal1")).toBe(false);
    expect(recoveryCodesPending({ money: false, recovery_codes: 0, recovery_ready: false }, "aal2")).toBe(false);
    expect(recoveryCodesPending(null, "aal2")).toBe(false);
    // Without the readiness field, unused codes decide.
    expect(recoveryCodesPending({ money: true, recovery_codes: 0 }, "aal2")).toBe(true);
    expect(recoveryCodesPending({ money: true, recovery_codes: 3 }, "aal2")).toBe(false);
  });
});
