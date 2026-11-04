"use client";

import { Camera } from "lucide-react";

/**
 * The shared "take or choose photos" control (UX9): one camera-first file picker used wherever a person adds photos
 * (inspection defects, work orders). Files are sent after the record is saved with uploadPhotos(); the server checks
 * type, size and who may add them.
 */
export function PhotoPicker({ id, label = "Photos (optional)", files, onChange, max = 8, hint, accept = "image/jpeg,image/png,image/webp", camera = true, empty = "Take or choose photos" }: {
  id: string; label?: string; files: File[]; onChange: (files: File[]) => void; max?: number; hint?: string;
  /** Other file types (e.g. PDFs for support attachments); the camera opens only when `camera` is true. */
  accept?: string; camera?: boolean; empty?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="flex min-h-12 cursor-pointer items-center gap-2 rounded-control border border-dashed border-line bg-surface px-3 text-sm text-muted hover:border-strong/40">
        <Camera className="size-5 shrink-0" aria-hidden />
        <span><span className="font-semibold text-ink">{label}</span> · {files.length ? `${files.length} file${files.length === 1 ? "" : "s"} chosen` : empty}</span>
      </label>
      <input id={id} type="file" accept={accept} multiple {...(camera ? { capture: "environment" as const } : {})} className="sr-only"
        onChange={(e) => onChange(Array.from(e.target.files ?? []).slice(0, max))} />
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

/** Sends each photo to `url` with the given form fields; returns how many could not be sent. */
export async function uploadPhotos(url: string, fields: Record<string, string>, files: File[]): Promise<number> {
  let failed = 0;
  for (const file of files) {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    body.set("file", file);
    const res = await fetch(url, { method: "POST", body }).catch(() => null);
    if (!res?.ok) failed++;
  }
  return failed;
}
