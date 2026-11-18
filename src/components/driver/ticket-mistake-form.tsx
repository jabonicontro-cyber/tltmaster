"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, Send } from "lucide-react";
import { reportTicketMistake } from "@/app/(app)/driver/actions";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { photoForPhone } from "@/lib/files/phone-photo";
import { toJpeg } from "@/lib/files/to-jpeg";
import { announceOutbox, enqueueWithPhotos, isNetworkError, outboxTime } from "@/lib/offline/store";
import { MISTAKE_FIELDS, MISTAKE_FIELD_LABELS, MISTAKE_VALUE_LABELS, mistakeError, mistakeSentMessage, type MistakeField } from "@/lib/tickets/mistakes";
import { Choice } from "./choice";
import { STICKY_ACTIONS, showAbove } from "./field-report-form";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string } | { kind: "queued"; photo: boolean };

/**
 * "Mistake on my ticket" (owner decision 2026-11-17, TM1): the driver says what is wrong on a ticket they already sent.
 * It goes to the office's ticket review, which corrects the ticket; the driver never changes it. Without signal it waits
 * on the phone and sends itself later, like a ticket or a problem report (src/lib/offline).
 */
export function TicketMistakeForm({ ticketId, ticketNumber, queue, onQueued, onBack }: {
  ticketId: string;
  ticketNumber: string;
  queue: { userId: string; timeZone?: string | null };
  /** After it is saved on the phone (the offline page returns to its list). */
  onQueued?: () => void;
  /** Replaces the Back link (the offline page closes the form instead of opening My Day). */
  onBack?: () => void;
}) {
  const router = useRouter();
  const [submissionKey] = useState(() => crypto.randomUUID());
  const [field, setField] = useState<MistakeField | "">("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const answer = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (state.kind === "queued" || state.kind === "failed" || error) showAbove(answer.current); }, [state.kind, error]);

  const payload = () => ({ ticketId, field: field as MistakeField, correctValue: value.trim(), note: note.trim(), submissionKey });

  /** Saved on the phone with its photo; false when the phone cannot keep it. */
  async function keep(): Promise<boolean> {
    const at = new Date().toISOString();
    const written = `(Written at ${outboxTime(at, queue.timeZone)} with no signal.)`;
    const p = { ...payload(), note: `${note.trim().slice(0, 1000 - written.length - 2)}\n\n${written}`.trim() };
    let photos: Array<{ key: string; data: string }> = [];
    try {
      photos = file ? [{ key: crypto.randomUUID(), data: await photoForPhone(file) }] : [];
    } catch {
      photos = [];
    }
    const item = { id: submissionKey, userId: queue.userId, kind: "mistake" as const, label: `Mistake on ticket ${ticketNumber}`, createdAt: at, payload: p };
    const kept = enqueueWithPhotos(item, photos) ? photos.length > 0 : enqueueWithPhotos(item, []) ? false : null;
    if (kept === null) return false;
    announceOutbox();
    setState({ kind: "queued", photo: kept });
    onQueued?.();
    return true;
  }

  async function send() {
    const problem = mistakeError(field, value, note);
    if (problem) return setError(problem);
    setError(null);
    setState({ kind: "sending" });
    if (typeof navigator !== "undefined" && navigator.onLine === false && (await keep())) return;
    try {
      const r = await reportTicketMistake(payload());
      if (!r.ok) return setState({ kind: "failed", message: r.error });
      let photo: "none" | "sent" | "failed" = "none";
      if (file) {
        let blob: Blob = file;
        try { blob = await toJpeg(file); } catch { /* sent as is; the server checks the bytes */ }
        const body = new FormData();
        body.set("report", r.data.reportId);
        body.set("file", new File([blob], "ticket.jpg", { type: blob.type || file.type }));
        const res = await fetch("/driver/mistake-photo", { method: "POST", body }).catch(() => null);
        photo = res?.ok ? "sent" : "failed";
      }
      router.push(`/driver?sent=${encodeURIComponent(mistakeSentMessage(ticketNumber, photo))}`);
    } catch (e) {
      if (isNetworkError(e) && (await keep())) return;
      setState({ kind: "failed", message: "Not sent: no connection to the office. Nothing was saved on this phone. Check your signal and tap Send again, or call the office." });
    }
  }

  const sending = state.kind === "sending";
  const queued = state.kind === "queued";
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!sending && !queued) void send(); }} className="space-y-5" noValidate aria-label="Mistake on my ticket">
      <p className="rounded-xl bg-surface px-4 py-3 text-sm">The office checks the paper ticket and corrects ticket <strong>{ticketNumber}</strong>. You do not need to send it again.</p>
      <fieldset>
        <legend className="mb-2 text-base font-bold">What is wrong?</legend>
        <div className="space-y-2">
          {MISTAKE_FIELDS.map((k) => (
            <Choice key={k} name="field" value={k} checked={field === k} onChange={(v) => { setField(v as MistakeField); setError(null); }}>{MISTAKE_FIELD_LABELS[k]}</Choice>
          ))}
        </div>
      </fieldset>
      {field && (
        <div>
          <label htmlFor="m-value" className="mb-2 block text-base font-bold">{MISTAKE_VALUE_LABELS[field]}</label>
          <input id="m-value" value={value} maxLength={200} inputMode={field === "quantity" ? "decimal" : "text"} onChange={(e) => { setValue(e.target.value); setError(null); }}
            className="h-14 w-full rounded-2xl border-2 border-line bg-card px-4 text-lg focus:border-strong focus:outline-none" />
        </div>
      )}
      <div>
        <label htmlFor="m-note" className="mb-2 block text-base font-bold">Note for the office (optional)</label>
        <textarea id="m-note" rows={3} maxLength={900} value={note} onChange={(e) => { setNote(e.target.value); setError(null); }} className="w-full rounded-2xl border-2 border-line bg-card px-4 py-3 text-lg focus:border-strong focus:outline-none" />
      </div>
      <div>
        <label htmlFor="m-photo" className="mb-2 block text-base font-bold">Photo of the paper ticket (optional)</label>
        <label htmlFor="m-photo" className="flex min-h-14 cursor-pointer items-center gap-2 rounded-2xl border-2 border-dashed border-line bg-surface px-4 text-base text-muted hover:border-strong">
          <Camera className="size-5" aria-hidden />
          {file ? "1 photo chosen" : "Take or choose a photo"}
        </label>
        <input id="m-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      {(error || state.kind === "failed") && (
        <p ref={answer} role="alert" className="rounded-xl bg-red-50 px-4 py-3 font-semibold text-red-900 ring-1 ring-red-200">{error ?? (state.kind === "failed" ? state.message : "")}</p>
      )}
      {queued && (
        <p ref={answer} role="status" className="rounded-xl bg-amber-50 px-4 py-3 font-semibold text-amber-950 ring-1 ring-amber-200" data-testid="mistake-queued">
          Saved on this phone{state.photo ? " with its photo" : ""}, not sent yet. It sends by itself when you have signal; My Day shows it under Waiting to send. Keep the paper ticket.
        </p>
      )}
      <div className={cn(STICKY_ACTIONS, "-mx-4 flex gap-2 border-t border-line bg-card/95 px-4 py-3 backdrop-blur")}>
        {onBack
          ? <button type="button" onClick={onBack} className={buttonClasses("secondary", "md", "min-h-14 flex-1 justify-center text-base")}>Back</button>
          : <Link href="/driver" className={buttonClasses("secondary", "md", "min-h-14 flex-1 justify-center text-base")}>Back</Link>}
        <button type="submit" disabled={sending || queued} className={buttonClasses("primary", "md", "min-h-14 flex-[2] justify-center text-lg")}>
          {sending ? <><Loader2 className="size-5 animate-spin" aria-hidden /> Sending…</> : <><Send className="size-5" aria-hidden /> {state.kind === "failed" ? "Send again" : "Send to the office"}</>}
        </button>
      </div>
    </form>
  );
}
