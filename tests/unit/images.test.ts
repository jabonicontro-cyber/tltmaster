import { describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES, checkPhoto, detectImageType } from "@/lib/files/images";

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const WEBP = new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), 0]);

describe("photo type from content", () => {
  it("recognises JPEG, PNG and WebP by their bytes only", () => {
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(WEBP)).toBe("image/webp");
    expect(detectImageType(ascii("GIF89a"))).toBeNull();
    expect(detectImageType(ascii("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectImageType(ascii("%PDF-1.7"))).toBeNull();
    expect(detectImageType(bytes(0xff, 0xd8))).toBeNull(); // truncated
    expect(detectImageType(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]))).toBeNull();
  });

  it("rejects empty, oversized, unknown and mislabelled files", () => {
    expect(checkPhoto(JPEG, "image/jpeg")).toEqual({ ok: true, type: "image/jpeg" });
    expect(checkPhoto(PNG, "")).toEqual({ ok: true, type: "image/png" }); // no declared type: content decides
    expect(checkPhoto(new Uint8Array(0), "image/jpeg")).toMatchObject({ ok: false, status: 400 });
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
    big.set(JPEG);
    expect(checkPhoto(big, "image/jpeg")).toMatchObject({ ok: false, status: 413 });
    expect(checkPhoto(ascii("<svg onload=alert(1)>"), "image/jpeg")).toMatchObject({ ok: false, status: 415 });
    expect(checkPhoto(PNG, "image/jpeg")).toMatchObject({ ok: false, status: 415, error: expect.stringMatching(/does not match/) });
    expect(checkPhoto(JPEG, "image/svg+xml")).toMatchObject({ ok: false, status: 415 });
  });
});
