import { describe, expect, it } from "vitest";
import { MONEY_MFA_REASON, MONEY_PERMISSIONS, memberMfaStatuses, mfaReason, mfaSetUpSummary, recoveryCodesPending, type MemberMfaRow } from "@/lib/mfa-policy";
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

describe("who has set up two-step verification (SEC4b, owner 2026-11-12)", () => {
  const people = [
    { id: "a", name: "Avery Owner", role: "owner", active: true },
    { id: "b", name: "Blake Office", role: "office", active: true },
    { id: "c", name: "Casey Office", role: "office", active: true },
    { id: "d", name: "Drew Driver", role: "driver", active: true },
    { id: "e", name: "Eli Former", role: "office", active: false },
  ];
  const rows: MemberMfaRow[] = [
    { user_id: "a", money: true, set_up: true, recovery_ready: true },
    { user_id: "b", money: true, set_up: false, recovery_ready: false },
    { user_id: "c", money: true, set_up: true, recovery_ready: false },
    { user_id: "d", money: false, set_up: false, recovery_ready: null },
    { user_id: "e", money: true, set_up: false, recovery_ready: false },
  ];

  it("says each person's state in plain words, those who must first, the ones still to do on top", () => {
    const s = memberMfaStatuses(people, rows, { companyRule: false, demo: false, moneyRoles: ["owner", "office"] });
    expect(s.map((x) => [x.name, x.label, x.detail])).toEqual([
      ["Blake Office", "Not set up yet", "Will be asked at next sign-in"],
      ["Casey Office", "Recovery codes not saved", "Will be asked to save them the next time they open Taviron"],
      ["Avery Owner", "Set up", null],
      ["Drew Driver", "Not required", null],
    ]);
    // People who left are not listed; nothing in the words is a code or an internal term.
    expect(s.map((x) => x.id)).not.toContain("e");
    for (const x of s) expect(`${x.label} ${x.detail ?? ""}`).not.toMatch(/[a-z]+[._][a-z]+|aal|factor|mfa/i);
    expect(mfaSetUpSummary(s)).toBe("1 of 3 people who must use two-step have set it up");
  });

  it("the company rule makes everyone a must; someone who chose it is set up without being counted", () => {
    const ruled = memberMfaStatuses(people, rows, { companyRule: true, demo: false, moneyRoles: [] });
    expect(ruled.find((x) => x.id === "d")).toMatchObject({ reason: "Company rule", label: "Not set up yet" });
    expect(mfaSetUpSummary(ruled)).toBe("1 of 4 people who must use two-step have set it up");
    const chose = memberMfaStatuses(people, [{ user_id: "d", money: false, set_up: true, recovery_ready: null }], { companyRule: false, demo: false, moneyRoles: [] });
    expect(chose).toEqual([expect.objectContaining({ label: "Set up", detail: "Not required here", reason: null })]);
    expect(mfaSetUpSummary(chose)).toBeNull();
    expect(mfaSetUpSummary(memberMfaStatuses(people.slice(0, 1), rows.slice(0, 1), { companyRule: false, demo: false, moneyRoles: [] }))).toBe("1 of 1 person who must use two-step has set it up");
  });

  it("in a demo company money roles are not needed (the database reports no money access there)", () => {
    const demoRows = rows.map((r) => ({ ...r, money: false, set_up: false, recovery_ready: null }));
    const s = memberMfaStatuses(people, demoRows, { companyRule: false, demo: true, moneyRoles: ["owner", "office"] });
    expect(s.find((x) => x.id === "a")).toMatchObject({ label: "Not needed in a demo", reason: null });
    expect(s.find((x) => x.id === "d")).toMatchObject({ label: "Not required" });
    expect(mfaSetUpSummary(s)).toBeNull();
  });
});
