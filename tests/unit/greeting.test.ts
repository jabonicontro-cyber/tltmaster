import { describe, expect, it } from "vitest";
import { firstNameOf, greeting } from "@/lib/people/greeting";

describe("greeting", () => {
  it("greets by the first word of the profile name", () => {
    expect(greeting("Pat Example")).toBe("Hi, Pat!");
    expect(greeting("  María José García ")).toBe("Hi, María!");
    expect(greeting("O'Neil, Sam")).toBe("Hi, O'Neil!");
  });

  it("falls back to a neutral greeting rather than guessing", () => {
    for (const v of [null, undefined, "", "   ", "pat@example.com", "1234", "—"]) expect(greeting(v)).toBe("Welcome back!");
    expect(firstNameOf("x".repeat(41))).toBeNull();
  });
});
