// Photo validation shared by the upload route and tests. The file's own bytes
// decide its type; the browser's filename and declared type are only checked
// against them, never trusted.

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_PHOTOS_PER_TICKET = 3;
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

/** Detect JPEG, PNG or WebP from the first bytes; null for anything else. */
export function detectImageType(bytes: Uint8Array): PhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export type PhotoCheck = { ok: true; type: PhotoType } | { ok: false; status: 400 | 413 | 415; error: string };

/** Size, real content type, and agreement with the declared type. */
export function checkPhoto(bytes: Uint8Array, declaredType: string): PhotoCheck {
  if (bytes.length === 0) return { ok: false, status: 400, error: "The photo is empty. Take it again." };
  if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, status: 413, error: "The photo is larger than 5 MB." };
  const type = detectImageType(bytes);
  if (!type) return { ok: false, status: 415, error: "Only JPEG, PNG or WebP photos can be attached." };
  if (declaredType && declaredType !== type) return { ok: false, status: 415, error: "The file's content does not match its type." };
  return { ok: true, type };
}
