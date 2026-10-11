"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ImagePlus, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { toJpeg } from "@/lib/files/to-jpeg";

type State =
  | { kind: "idle" }
  | { kind: "uploading"; progress: number }
  | { kind: "failed"; error: string; blob: Blob; key: string };

/**
 * Add a scan or photo of the paper ticket (office). The image is re-encoded in the
 * browser (EXIF and location removed), sent with one upload key, and shown as
 * added only after the server confirms it is stored and attached. A failed upload
 * keeps the image here with "Try again" (same key: never stored twice).
 */
export function TicketScanUpload({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  function send(blob: Blob, key: string) {
    setState({ kind: "uploading", progress: 0 });
    const body = new FormData();
    body.set("file", new File([blob], "ticket.jpg", { type: blob.type }));
    body.set("upload_key", key);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/tickets/${ticketId}/scans`);
    xhr.upload.onprogress = (e) => e.lengthComputable && setState({ kind: "uploading", progress: Math.round((e.loaded / e.total) * 100) });
    xhr.onload = () => {
      let msg = "The image could not be added. Try again.";
      try {
        const r = JSON.parse(xhr.responseText) as { error?: string };
        if (r.error) msg = r.error;
      } catch { /* keep the generic message */ }
      if (xhr.status === 200) {
        setState({ kind: "idle" });
        toast.success("Scan added to the ticket.");
        router.refresh();
      } else {
        setState({ kind: "failed", error: msg, blob, key });
      }
    };
    xhr.onerror = () => setState({ kind: "failed", error: "No connection. The image is kept here — try again.", blob, key });
    xhr.send(body);
  }

  return (
    <div className="space-y-2">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        className="sr-only"
        aria-label="Choose a scan or photo of the paper ticket"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            send(await toJpeg(file), crypto.randomUUID());
          } catch {
            setState({ kind: "failed", error: "This image could not be read. Use a JPEG, PNG or WebP scan or photo.", blob: file, key: crypto.randomUUID() });
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={cn(buttonClasses("secondary", "sm"))} disabled={state.kind === "uploading"} onClick={() => input.current?.click()}>
          <ImagePlus className="size-4" aria-hidden /> Add a scan or photo
        </button>
        {state.kind === "uploading" && (
          <span role="status" className="inline-flex items-center gap-1.5 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Uploading {state.progress}%
          </span>
        )}
        {state.kind === "failed" && (
          <span role="alert" className="inline-flex flex-wrap items-center gap-2 text-sm text-critical">
            Not added: {state.error}
            <button type="button" className={buttonClasses("ghost", "sm")} onClick={() => send(state.blob, state.key)}>
              <RotateCcw className="size-4" aria-hidden /> Try again
            </button>
          </span>
        )}
      </div>
      <p className="text-xs text-muted">The original image is kept with the ticket and every later revision. It cannot be replaced or deleted.</p>
    </div>
  );
}
