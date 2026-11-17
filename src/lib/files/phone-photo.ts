// Browser only. Photos kept on a driver's phone while there is no signal (walkthrough P2, 2026-11-16): a ticket or a
// problem report saved on the phone keeps its photos in browser storage until it is sent, so they are shrunk first and
// stored as text (a data URL). Shared helper: anything that keeps a photo on the phone should use it.

/** Long side and JPEG quality for a photo kept on the phone: a paper ticket stays readable at about 150–300 KB. */
export const KEPT_PHOTO_MAX_SIDE = 1600;
export const KEPT_PHOTO_QUALITY = 0.72;

/** Re-encode an image as a smaller JPEG for keeping on the phone (EXIF, such as GPS, is dropped). */
export async function shrinkPhoto(file: Blob, maxSide = KEPT_PHOTO_MAX_SIDE, quality = KEPT_PHOTO_QUALITY): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", quality));
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read"));
    r.readAsDataURL(blob);
  });
}

/** The photo back as a file to upload, decoded on the phone (no network, no service worker). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) throw new Error("Not a photo.");
  const type = m[1] || "image/jpeg";
  if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type });
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** A photo ready to keep on the phone: shrunk when the phone can (otherwise as taken), as a data URL. */
export async function photoForPhone(blob: Blob): Promise<string> {
  let small = blob;
  try {
    small = await shrinkPhoto(blob);
  } catch {
    /* kept as it is; the server checks the bytes when it is sent */
  }
  return blobToDataUrl(small);
}
