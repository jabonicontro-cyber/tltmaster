import { UPLOAD_MAX_BYTES } from "./images";

// Browser only. Re-encode an image to JPEG, at most 2000 px on the long side (quality 0.82), smaller only when needed
// to fit `maxBytes`. Keeps uploads small on a phone connection, under the hosting platform's request limit (about
// 4.5 MB per request on Vercel), and drops EXIF data (GPS, device). Rejects when the image cannot be read or still
// does not fit.
const STEPS: Array<{ edge: number; quality: number }> = [
  { edge: 2000, quality: 0.82 },
  { edge: 2000, quality: 0.7 },
  { edge: 1600, quality: 0.7 },
  { edge: 1280, quality: 0.65 },
];

export async function toJpeg(file: Blob, maxBytes: number = UPLOAD_MAX_BYTES): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    for (const step of STEPS) {
      const scale = Math.min(1, step.edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", step.quality));
      if (blob.size <= maxBytes) return blob;
    }
  } finally {
    bitmap.close();
  }
  throw new Error("too-large");
}
