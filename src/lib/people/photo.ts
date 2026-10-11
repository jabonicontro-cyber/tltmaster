/** Largest photo accepted after the browser's resize (the database allows 200 KB). */
export const MAX_PHOTO_BYTES = 200 * 1024;
/** Photos are stored as a square of this many pixels. */
export const PHOTO_SIZE = 256;
/** Largest original file a person may pick before it is resized in the browser. */
export const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024;

/** Up to two initials from a name (or an email's local part), "?" when there is nothing to use. */
export function initialsOf(name: string | null | undefined): string {
  const base = (name ?? "").trim().replace(/@.*$/, "").replace(/[._-]+/g, " ");
  const letters = base.split(/\s+/).filter(Boolean).map((w) => Array.from(w)[0]?.toUpperCase() ?? "");
  const out = (letters.length > 1 ? letters[0] + letters[letters.length - 1] : letters[0] ?? "").replace(/[^\p{L}\p{N}]/gu, "");
  return out || "?";
}

/** The centered square to crop from a w×h image, so faces are not stretched. */
export function squareCrop(w: number, h: number): { sx: number; sy: number; size: number } {
  const size = Math.min(w, h);
  return { sx: Math.floor((w - size) / 2), sy: Math.floor((h - size) / 2), size };
}
