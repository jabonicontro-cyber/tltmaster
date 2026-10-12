import { describe, expect, it } from "vitest";
import { initialsOf, squareCrop } from "@/lib/people/photo";

describe("profile photo helpers", () => {
  it("makes up to two initials, never from an email domain", () => {
    expect(initialsOf("Pat Example")).toBe("PE");
    expect(initialsOf("Mary Ann van Dyke")).toBe("MD");
    expect(initialsOf("Émile")).toBe("É");
    expect(initialsOf("dana.dispatch@toplinetest.example")).toBe("DD");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("—")).toBe("?");
  });

  it("crops the centered square so photos are not stretched", () => {
    expect(squareCrop(400, 300)).toEqual({ sx: 50, sy: 0, size: 300 });
    expect(squareCrop(300, 500)).toEqual({ sx: 0, sy: 100, size: 300 });
    expect(squareCrop(256, 256)).toEqual({ sx: 0, sy: 0, size: 256 });
  });
});

describe("personPhoto", () => {
  it("prefers the person's own profile photo, then the employee avatar, then initials", async () => {
    const { personPhoto } = await import("@/lib/people/avatars");
    expect(personPhoto("u1", "2026-10-12T00:00:00Z", "avatar-03")).toEqual({ src: "/people/photo/u1?v=2026-10-12T00%3A00%3A00Z", fallbackSrc: "/avatars/avatar-03.png" });
    expect(personPhoto("u1", null, "avatar-03")).toEqual({ src: "", fallbackSrc: "/avatars/avatar-03.png" });
    expect(personPhoto(null, null, "")).toEqual({ src: "", fallbackSrc: "" });
  });
});
