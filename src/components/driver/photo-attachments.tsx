"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { MAX_PHOTOS_PER_TICKET } from "@/lib/files/images";
import { toJpeg } from "@/lib/files/to-jpeg";

type Photo = {
  key: string;
  blob: Blob;
  preview: string;
  status: "uploading" | "uploaded" | "failed";
  progress: number;
  attachmentId?: string;
  error?: string;
};

export interface PhotoState {
  ids: string[];
  busy: boolean;
  failed: boolean;
}

export function PhotoAttachments({ assignmentId, onChange, disabled }: { assignmentId: string; onChange: (s: PhotoState) => void; disabled?: boolean }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => {
    onChange({
      ids: photos.filter((p) => p.status === "uploaded" && p.attachmentId).map((p) => p.attachmentId!),
      busy: photos.some((p) => p.status === "uploading"),
      failed: photos.some((p) => p.status === "failed"),
    });
  }, [photos, onChange]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const update = (key: string, patch: Partial<Photo>) => setPhotos((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  function upload(p: Pick<Photo, "key" | "blob">) {
    update(p.key, { status: "uploading", progress: 0, error: undefined });
    const body = new FormData();
    body.set("file", new File([p.blob], "ticket.jpg", { type: p.blob.type }));
    body.set("assignment_id", assignmentId);
    body.set("upload_key", p.key); // same key on retry: never a second copy
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/driver/photos");
    xhr.upload.onprogress = (e) => e.lengthComputable && update(p.key, { progress: Math.round((e.loaded / e.total) * 95) });
    xhr.onload = () => {
      let json: { attachmentId?: string; error?: string } = {};
      try { json = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 200 && json.attachmentId) update(p.key, { status: "uploaded", progress: 100, attachmentId: json.attachmentId });
      else update(p.key, { status: "failed", error: json.error ?? "The photo was not saved. Try again." });
    };
    xhr.onerror = () => update(p.key, { status: "failed", error: "Not uploaded — no connection. Nothing was saved. Tap Retry when you have signal." });
    xhr.send(body);
  }

  async function add(file: File | undefined) {
    if (!file) return;
    setError(null);
    let blob: Blob;
    try {
      blob = await toJpeg(file);
    } catch {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        setError("This photo format cannot be read here. Take the photo with the camera button.");
        return;
      }
      blob = file;
    }
    const key = crypto.randomUUID();
    const preview = URL.createObjectURL(blob);
    urls.current.push(preview);
    setPhotos((ps) => [...ps, { key, blob, preview, status: "uploading", progress: 0 }]);
    upload({ key, blob });
  }

  return (
    <div>
      <p className="mb-2 text-base font-bold">Photo of the paper ticket (optional)</p>
      <ul className="space-y-2" aria-label="Ticket photos">
        {photos.map((p, i) => (
          <li key={p.key} className={cn("flex items-center gap-3 rounded-2xl border-2 bg-card p-2", p.status === "failed" ? "border-red-300" : "border-line")} aria-label={`Photo ${i + 1}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- local preview of the photo being sent */}
            <img src={p.preview} alt={`Photo ${i + 1} preview`} className="size-16 rounded object-cover" />
            <div className="min-w-0 flex-1 text-sm">
              {p.status === "uploading" && (
                <>
                  <p className="flex items-center gap-1 font-semibold"><Loader2 className="size-4 animate-spin" aria-hidden /> Uploading… {p.progress}%</p>
                  <div className="mt-1 h-2 rounded bg-surface" role="progressbar" aria-label={`Photo ${i + 1} upload`} aria-valuenow={p.progress} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-2 rounded bg-strong" style={{ width: `${p.progress}%` }} />
                  </div>
                </>
              )}
              {p.status === "uploaded" && <p className="flex items-center gap-1 font-semibold text-green-800"><CheckCircle2 className="size-4" aria-hidden /> Uploaded</p>}
              {p.status === "failed" && <p role="alert" className="font-semibold text-red-800">{p.error}</p>}
            </div>
            {p.status === "failed" && (
              <button type="button" onClick={() => upload(p)} className={buttonClasses("secondary", "sm", "min-h-11")}><RotateCcw className="size-4" aria-hidden /> Retry</button>
            )}
            {p.status !== "uploading" && (
              <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => setPhotos((ps) => ps.filter((x) => x.key !== p.key))} className={buttonClasses("ghost", "sm", "min-h-11")}><Trash2 className="size-4" aria-hidden /></button>
            )}
          </li>
        ))}
      </ul>
      {photos.length < MAX_PHOTOS_PER_TICKET && (
        <>
          <input ref={input} id="ticket-photo" type="file" accept="image/jpeg,image/png,image/webp,image/*" capture="environment" className="sr-only"
            onChange={(e) => { void add(e.target.files?.[0]); e.target.value = ""; }} disabled={disabled} />
          <label htmlFor="ticket-photo" className={buttonClasses("secondary", "md", cn("mt-2 min-h-14 w-full cursor-pointer justify-center text-base", disabled && "pointer-events-none opacity-50"))}>
            <Camera className="size-5" aria-hidden /> {photos.length ? "Add another photo" : "Take a photo"}
          </label>
        </>
      )}
      {error && <p role="alert" className="mt-1 font-semibold text-red-700">{error}</p>}
      <p className="mt-1 text-sm text-muted">Up to {MAX_PHOTOS_PER_TICKET} photos. Keep the paper ticket for the office too.</p>
    </div>
  );
}
