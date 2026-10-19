import { describe, expect, it } from "vitest";
import { generateTemporaryPassword, homePathFor, instructionsText, passwordProblem, usernameCandidates, usernameFromName } from "@/lib/accounts";
import { cookiePersistence } from "@/lib/shared-device";
import { isValidUsername } from "@/lib/usernames";

describe("account helpers", () => {
  it("temporary passwords are readable, mixed and differ each time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(p).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
      expect(p.toLowerCase()).not.toMatch(/[01ilo]/); // no characters that are easy to misread
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[2-9]/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });

  it("usernames are generated from names and stay valid", () => {
    expect(usernameFromName("Sam O'Neil")).toBe("sam.oneil");
    expect(usernameFromName("José María Núñez")).toBe("jose.nunez");
    expect(usernameFromName("Cher")).toBe("cher");
    expect(usernameFromName("  ")).toBe("");
    const long = usernameFromName("Bartholomew-Alexander Montgomery-Fitzwilliamson");
    expect(isValidUsername(long)).toBe(true);
  });

  it("username candidates are base, base2 … and each one is valid and at most 32 characters", () => {
    const c = usernameCandidates("sam.oneil", 5);
    expect(c).toEqual(["sam.oneil", "sam.oneil2", "sam.oneil3", "sam.oneil4", "sam.oneil5"]);
    for (const x of usernameCandidates("a".repeat(32), 20)) {
      expect(x.length).toBeLessThanOrEqual(32);
      expect(isValidUsername(x)).toBe(true);
    }
    for (const x of usernameCandidates("jo")) expect(isValidUsername(x)).toBe(true);
  });

  it("people land on the page for their role, only with its permission", () => {
    expect(homePathFor("driver", ["driver.portal"])).toBe("/driver");
    expect(homePathFor("mechanic", ["maintenance.view"])).toBe("/maintenance");
    expect(homePathFor("dispatcher", ["dispatch.view"])).toBe("/dispatch");
    expect(homePathFor("office", ["orders.view"])).toBe("/command-center");
    expect(homePathFor("driver", [])).toBe("/command-center");
    expect(homePathFor(null, [])).toBe("/command-center");
  });

  it("password rules", () => {
    expect(passwordProblem("short", "short", "sam")).toMatch(/10 characters/);
    expect(passwordProblem("sam.oneil-rocks-2026", "sam.oneil-rocks-2026", "sam.oneil")).toMatch(/username/);
    expect(passwordProblem("Gravel-Road-2026!", "Gravel-Road-2027!", "sam")).toMatch(/match/);
    expect(passwordProblem("Gravel-Road-2026!", "Gravel-Road-2026!", "sam")).toBeNull();
  });

  it("copied instructions include the password only when asked", () => {
    const base = { personName: "Sam", companyName: "Acme Haul", username: "sam.oneil", loginUrl: "https://example.test/login", kind: "employee" as const, expiresAt: "2026-10-20T00:00:00Z" };
    expect(instructionsText({ ...base }, "tomorrow")).not.toMatch(/Temporary password: [A-Za-z0-9]{4}-/);
    expect(instructionsText({ ...base, temporaryPassword: "Abcd-efgh-2345" }, "tomorrow")).toContain("Abcd-efgh-2345");
  });

  it("a shared computer gets browser-session cookies", () => {
    const opts = { maxAge: 3600, expires: new Date(), path: "/", httpOnly: true };
    expect(cookiePersistence(opts, false)).toBe(opts);
    expect(cookiePersistence(opts, true)).toEqual({ path: "/", httpOnly: true });
    expect(cookiePersistence(undefined, true)).toBeUndefined();
  });
});
