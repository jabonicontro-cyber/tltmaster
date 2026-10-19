"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Camera, Check, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { MAX_ORIGINAL_BYTES, MAX_PHOTO_BYTES, PHOTO_SIZE, framedCrop } from "@/lib/people/photo";
import { AVATAR_KEYS, avatarUrl } from "@/lib/people/avatars";
import { removeMyPhoto, uploadMyPhoto } from "@/app/(app)/profile/actions";

interface Framing { zoom: number; x: number; y: number }
const CENTERED: Framing = { zoom: 1, x: 0, y: 0 };

/** Draw the framed square of a picked image onto a canvas of `px` pixels (white behind transparent PNGs). */
function draw(canvas: HTMLCanvasElement, bitmap: ImageBitmap, f: Framing, px: number) {
  const { sx, sy, size } = framedCrop(bitmap.width, bitmap.height, f.zoom, f.x, f.y);
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);
  ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, px, px);
}

/** The framed square as a PHOTO_SIZE JPEG (re-encoding also drops camera metadata such as location). */
async function encode(bitmap: ImageBitmap, f: Framing): Promise<Blob> {
  const canvas = document.createElement("canvas");
  draw(canvas, bitmap, f, PHOTO_SIZE);
  for (const quality of [0.86, 0.75, 0.6]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (blob && blob.size <= MAX_PHOTO_BYTES) return blob;
  }
  throw new Error("too large");
}

/**
 * The signed-in person's own photo: pick (or take, on a phone) a picture, frame it (zoom and position, previewed as it
 * will look), then save — nothing is sent before Save. The square is resized here before upload. One upload at a time;
 * a failed upload keeps the framed picture so "Try again" needs no re-picking.
 */
export function PhotoUploader({ name, src }: { name: string; src: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ bitmap: ImageBitmap; framing: Framing } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  // The live preview of the framing (the same square that will be saved).
  useEffect(() => {
    if (draft && canvas.current) draw(canvas.current, draft.bitmap, draft.framing, 192);
  }, [draft]);
  useEffect(() => () => draft?.bitmap.close(), [draft?.bitmap]);

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
      setError(null);
      setDraft({ bitmap: await createImageBitmap(file), framing: CENTERED });
    } catch {
      setError("That picture could not be read. Try a JPEG or PNG photo.");
    } finally {
      if (input.current) input.current.value = "";
    }
  };

  const save = async () => {
    if (!draft) return;
    try {
      const blob = await encode(draft.bitmap, draft.framing);
      setPreview(URL.createObjectURL(blob));
      setDraft(null);
      send(blob);
    } catch {
      setError("That picture could not be prepared. Try a smaller JPEG or PNG photo.");
    }
  };
  const frame = (k: keyof Framing, v: number) => setDraft((d) => (d ? { ...d, framing: { ...d.framing, [k]: v } } : d));

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
  if (draft) {
    const slider = (k: keyof Framing, label: string, min: number, max: number) => (
      <label className="grid gap-1 text-sm font-medium text-ink">
        {label}
        <input type="range" min={min} max={max} step={0.01} value={draft.framing[k]} onChange={(e) => frame(k, Number(e.target.value))} className="accent-brand" />
      </label>
    );
    return (
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start" role="group" aria-label="Frame your photo">
        <canvas ref={canvas} width={192} height={192} className="size-48 shrink-0 rounded-full border border-line bg-surface" aria-label="Preview of your new photo" role="img" />
        <div className="w-full max-w-xs space-y-3">
          <p className="text-sm text-muted">This is how your photo will look. Zoom and move it, then save. Nothing is sent before you save.</p>
          {slider("zoom", "Zoom", 1, 4)}
          {slider("x", "Left – right", -1, 1)}
          {slider("y", "Up – down", -1, 1)}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" onClick={save} icon={<Check className="size-4" />} className="min-h-11">Save photo</Button>
            <Button type="button" variant="secondary" onClick={() => setDraft(null)} icon={<X className="size-4" />} className="min-h-11">Cancel</Button>
          </div>
          {error && <p role="alert" className="text-sm font-medium text-critical">{error}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <Avatar name={name} src={shown} size={96} label={shown ? "Your profile photo" : `No photo — initials of ${name}`} />
      <div className="space-y-2">
        <input ref={input} type="file" accept="image/*" className="sr-only" id="photo" aria-label="Choose a profile photo" tabIndex={-1} aria-describedby="photo-help" onChange={(e) => pick(e.target.files?.[0])} disabled={pending} />
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
        <p id="photo-help" className="text-sm text-muted">Shown to people in your company. You can zoom and position it before saving; it is made small before it is sent.</p>
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
