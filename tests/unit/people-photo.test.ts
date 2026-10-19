import { describe, expect, it } from "vitest";
import { framedCrop, initialsOf, squareCrop } from "@/lib/people/photo";

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

  it("frames a chosen square: centred by default, zoom narrows it, position moves it, always inside the image", () => {
    expect(framedCrop(400, 300, 1, 0, 0)).toEqual(squareCrop(400, 300));
    expect(framedCrop(400, 300, 2, 0, 0)).toEqual({ sx: 125, sy: 75, size: 150 });
    expect(framedCrop(400, 300, 1, -1, 0)).toEqual({ sx: 0, sy: 0, size: 300 });
    expect(framedCrop(400, 300, 1, 1, 0)).toEqual({ sx: 100, sy: 0, size: 300 });
    expect(framedCrop(400, 300, 2, 1, 1)).toEqual({ sx: 250, sy: 150, size: 150 });
    // Out-of-range or broken values are clamped, never outside the picture.
    expect(framedCrop(400, 300, 99, 5, -5)).toEqual({ sx: 325, sy: 0, size: 75 });
    expect(framedCrop(400, 300, Number.NaN, Number.NaN, 0)).toEqual(squareCrop(400, 300));
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

describe("employee photo URL", () => {
  it("is versioned for people with a photo, empty for people without, and unversioned when versions are unknown", async () => {
    const { employeePhotoSrc } = await import("@/lib/people/avatars");
    const u = "11111111-1111-4111-8111-111111111111";
    expect(employeePhotoSrc(null, new Map())).toBe("");
    expect(employeePhotoSrc(u, new Map())).toBe(""); // no photo: no request at all
    expect(employeePhotoSrc(u, new Map([[u, "2026-10-12T10:00:00Z"]]))).toBe(`/people/photo/${u}?v=2026-10-12T10%3A00%3A00Z`);
    expect(employeePhotoSrc(u, null)).toBe(`/people/photo/${u}`); // database function not installed yet
  });
});
