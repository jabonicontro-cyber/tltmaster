"use client";

import { useRef, useState, useTransition } from "react";
import { Camera, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { MAX_ORIGINAL_BYTES, MAX_PHOTO_BYTES, PHOTO_SIZE, squareCrop } from "@/lib/people/photo";
import { AVATAR_KEYS, avatarUrl } from "@/lib/people/avatars";
import { removeMyPhoto, uploadMyPhoto } from "@/app/(app)/profile/actions";

/** Scale and crop a picked image to a PHOTO_SIZE square JPEG in the browser (also drops camera metadata such as location). */
async function resize(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const { sx, sy, size } = squareCrop(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_SIZE;
    canvas.height = PHOTO_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
    ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    for (const quality of [0.86, 0.75, 0.6]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
      if (blob && blob.size <= MAX_PHOTO_BYTES) return blob;
    }
    throw new Error("too large");
  } finally {
    bitmap.close();
  }
}

/**
 * The signed-in person's own photo: pick (or take, on a phone) a picture, which
 * is cropped to a square and resized here before upload. One upload at a time;
 * a failed upload keeps the chosen picture so "Try again" needs no re-picking.
 */
export function PhotoUploader({ name, src }: { name: string; src: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const send = (blob: Blob) =>
    start(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("photo", new File([blob], blob.type === "image/png" ? "photo.png" : "photo.jpg", { type: blob.type || "image/jpeg" }));
      try {
        const r = await uploadMyPhoto(fd);
        if (r.ok) {
          setFailed(null);
          toast.success(r.message ?? "Photo saved.");
        } else {
          setFailed(blob);
          setError(r.fieldErrors?.photo ?? r.error);
        }
      } catch {
        setFailed(blob);
        setError("The photo could not be sent — check your connection and try again.");
      }
    });

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) return setError("Choose a photo (JPEG, PNG, WebP or a phone camera picture).");
    if (file.size > MAX_ORIGINAL_BYTES) return setError("That file is larger than 15 MB. Choose a smaller photo.");
    try {
      const blob = await resize(file);
      setPreview(URL.createObjectURL(blob));
      send(blob);
    } catch {
      setError("That picture could not be read. Try a JPEG or PNG photo.");
    } finally {
      if (input.current) input.current.value = "";
    }
  };

  const remove = () => {
    if (!window.confirm("Remove your profile photo? Your initials are shown instead.")) return;
    start(async () => {
      const r = await removeMyPhoto();
      if (r.ok) {
        setPreview(null);
        toast.success(r.message ?? "Photo removed.");
      } else setError(r.error);
    });
  };

  /** An illustrated avatar is saved exactly like a photo (same checks), so nothing else needs to know the difference. */
  const chooseAvatar = (key: string) =>
    start(async () => {
      setError(null);
      try {
        const res = await fetch(avatarUrl(key));
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        setPreview(avatarUrl(key));
        send(blob);
      } catch {
        setError("That avatar could not be loaded. Check your connection and try again.");
      }
    });

  const shown = preview ?? src;
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <Avatar name={name} src={shown} size={96} label={shown ? "Your profile photo" : `No photo — initials of ${name}`} />
      <div className="space-y-2">
        <input ref={input} type="file" accept="image/*" className="sr-only" id="photo" aria-describedby="photo-help" onChange={(e) => pick(e.target.files?.[0])} disabled={pending} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => input.current?.click()} disabled={pending} icon={<Camera className="size-4" />} className="min-h-11">
            {pending ? "Saving…" : shown ? "Change photo" : "Add a photo"}
          </Button>
          {failed && !pending && (
            <Button type="button" variant="secondary" onClick={() => send(failed)} icon={<RotateCcw className="size-4" />} className="min-h-11">Try again</Button>
          )}
          {shown && !failed && (
            <Button type="button" variant="secondary" onClick={remove} disabled={pending} icon={<Trash2 className="size-4" />} className="min-h-11">Remove</Button>
          )}
        </div>
        <p id="photo-help" className="text-sm text-muted">Shown to people in your company. It is cropped to a square and made small before it is sent.</p>
        {pending && <p role="status" className="text-sm text-muted">Uploading…</p>}
        {error && <p role="alert" className="text-sm font-medium text-critical">{error}</p>}
        <fieldset className="pt-2">
          <legend className="mb-2 text-sm font-semibold text-ink">Or choose an avatar</legend>
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
            {AVATAR_KEYS.map((key, i) => (
              <button
                key={key}
                type="button"
                onClick={() => chooseAvatar(key)}
                disabled={pending}
                aria-label={`Use avatar ${i + 1}`}
                aria-pressed={preview === avatarUrl(key)}
                className="rounded-full ring-offset-2 ring-offset-card hover:ring-2 hover:ring-line focus-visible:ring-2 focus-visible:ring-strong aria-pressed:ring-2 aria-pressed:ring-strong disabled:opacity-60"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- static illustration */}
                <img src={avatarUrl(key)} alt="" width={44} height={44} className="size-11 rounded-full" />
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  );
}
