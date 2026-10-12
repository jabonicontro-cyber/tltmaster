import { describe, expect, it } from "vitest";
import { displayLogin, isUsernameEmail, isValidUsername, signInAddress, usernameEmail } from "@/lib/usernames";

describe("username sign-in", () => {
  it("accepts simple lowercase usernames and rejects everything else", () => {
    for (const ok of ["colbychapman", "colby.chapman", "c-chapman", "abc", "a1b"]) expect(isValidUsername(ok), ok).toBe(true);
    for (const bad of ["ab", ".colby", "colby.", "col..by", "colby chapman", "colby_chapman", "colby@x", "a".repeat(33), ""]) expect(isValidUsername(bad), bad).toBe(false);
    expect(isValidUsername("  ColbyChapman ")).toBe(true); // normalized
  });

  it("maps a username to its internal sign-in address and back", () => {
    expect(usernameEmail("ColbyChapman")).toBe("colbychapman@users.mytaviron.com");
    expect(isUsernameEmail("colbychapman@users.mytaviron.com")).toBe(true);
    expect(isUsernameEmail("colby@example.com")).toBe(false);
    expect(displayLogin("colbychapman@users.mytaviron.com")).toBe("colbychapman");
    expect(displayLogin("owner@example.com")).toBe("owner@example.com");
  });

  it("turns what was typed into the address to sign in with", () => {
    expect(signInAddress("colbychapman")).toEqual({ ok: true, email: "colbychapman@users.mytaviron.com" });
    expect(signInAddress(" owner@example.com ")).toEqual({ ok: true, email: "owner@example.com" });
    expect(signInAddress("colbychapman@users.mytaviron.com")).toMatchObject({ ok: false });
    expect(signInAddress("not valid!")).toMatchObject({ ok: false });
    expect(signInAddress("")).toMatchObject({ ok: false });
  });
});
