"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, CheckCircle2, FileUp, Loader2, RotateCcw } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { toJpeg } from "@/lib/files/to-jpeg";

// Proof of delivery from the phone at a delivery stop (MK2, 20261120020800): a photo of the signed paperwork, or a PDF,
// for the driver's own load. Photos need signal (docs/COMPANION_APP.md §4): without it nothing is sent, the driver is
// told so where they are looking, and the photo waits on this screen to be sent with Retry or as soon as the phone is
// back online. A retry reuses the upload key, so Taviron never keeps a second copy.

export interface SentProof { id: string; name: string; at: string }

/** Proof-of-delivery limits shown and checked before anything is sent (the database checks the same). */
export const POD_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
export const POD_MAX_BYTES = 10 * 1024 * 1024;

type Waiting = { key: string; blob: Blob; name: string; reason: string };

const NO_SIGNAL = "Not sent: no signal. It sends when you tap Retry with signal. Keep this screen open, or keep the paper copy for the office.";

export function StopProof({ assignmentId, stopId, stopName, sent, timeZone }: { assignmentId: string; stopId: string; stopName: string; sent: SentProof[]; timeZone: string }) {
  const router = useRouter();
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const time = (iso: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));

  async function send(w: Waiting) {
    setError(null);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setWaiting({ ...w, reason: NO_SIGNAL });
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.set("file", new File([w.blob], w.name, { type: w.blob.type }));
      body.set("assignment_id", assignmentId);
      body.set("stop_id", stopId);
      body.set("upload_key", w.key);
      const res = await fetch("/driver/proof", { method: "POST", body });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        // Taviron answered: a retry is a new upload (the refused one was not kept).
        setWaiting(null);
        setError(out.error ?? "The proof of delivery was not saved. Try again.");
        return;
      }
      setWaiting(null);
      toast.success(`Proof of delivery sent for ${stopName}.`);
      router.refresh();
    } catch {
      // No answer: it may or may not have arrived. The same key on Retry never adds a second copy.
      setWaiting({ ...w, reason: NO_SIGNAL });
    } finally {
      setBusy(false);
    }
  }

  // Back online with a photo waiting: send it.
  useEffect(() => {
    if (!waiting) return;
    const retry = () => void send(waiting);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send reads the latest props; re-subscribing per waiting item is enough
  }, [waiting]);

  async function add(file: File | undefined) {
    if (!file) return;
    setError(null);
    let blob: Blob = file;
    let name = file.name || "proof-of-delivery";
    if (file.type !== "application/pdf") {
      try {
        blob = await toJpeg(file);
        name = "proof-of-delivery.jpg";
      } catch {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
          setError("This photo format cannot be read here. Take the photo with the camera button.");
          return;
        }
      }
    }
    if (!POD_ACCEPT.split(",").includes(blob.type)) return setError("Send a photo (JPEG, PNG, WebP) or a PDF.");
    if (blob.size > POD_MAX_BYTES) return setError("The file is larger than 10 MB. Take a photo instead.");
    await send({ key: crypto.randomUUID(), blob, name, reason: "" });
  }

  const label = `proof of delivery for ${stopName}`;
  return (
    <div className="mt-2 space-y-2" aria-label={`Proof of delivery, ${stopName}`}>
      {sent.length > 0 && (
        <ul className="space-y-1" aria-label={`Proof of delivery sent, ${stopName}`}>
          {sent.map((p) => (
            <li key={p.id} className="flex items-center gap-1.5 text-sm font-semibold text-green-800">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden /> Proof of delivery sent {time(p.at)}
            </li>
          ))}
        </ul>
      )}
      {waiting ? (
        <div role="alert" className="space-y-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-950 ring-1 ring-amber-300">
          <p className="font-semibold">{waiting.reason}</p>
          <button type="button" onClick={() => void send(waiting)} disabled={busy} className={buttonClasses("secondary", "md", "min-h-12 w-full justify-center text-base")}>
            {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <RotateCcw className="size-5" aria-hidden />} Retry sending
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={camera} type="file" accept="image/jpeg,image/png,image/webp,image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden
            onChange={(e) => { void add(e.target.files?.[0]); e.target.value = ""; }} disabled={busy} data-testid={`pod-camera-${stopId}`} />
          <input ref={picker} type="file" accept={POD_ACCEPT} className="sr-only" tabIndex={-1} aria-label={`Choose a file as ${label}`}
            onChange={(e) => { void add(e.target.files?.[0]); e.target.value = ""; }} disabled={busy} />
          {/* Glove-size target (UX6): at least 48 px tall. */}
          <button type="button" onClick={() => camera.current?.click()} disabled={busy} className={buttonClasses(sent.length ? "secondary" : "primary", "md", cn("min-h-12 flex-1 justify-center text-base sm:flex-none", busy && "opacity-70"))}>
            {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Camera className="size-5" aria-hidden />}
            {busy ? "Sending…" : sent.length ? "Add another photo" : "Add proof of delivery"}<span className="sr-only"> for {stopName}</span>
          </button>
          <button type="button" onClick={() => picker.current?.click()} disabled={busy} className={buttonClasses("ghost", "md", "min-h-12 text-base")}>
            <FileUp className="size-5" aria-hidden /> Choose a file<span className="sr-only"> for {stopName}</span>
          </button>
        </div>
      )}
      <FormError message={error} />
      {sent.length === 0 && !waiting && <p className="text-xs text-muted">A photo of the signed delivery receipt or bill of lading. The office sees it on the order.</p>}
    </div>
  );
}
