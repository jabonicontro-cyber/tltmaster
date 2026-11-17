"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, Send } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { MAX_REPORT_PHOTOS as MAX_PHOTOS, REPORT_KINDS, REPORT_KIND_HELP, REPORT_KIND_LABELS, defaultReportEquipment, reportNeedsEquipment, reportSentMessage, type ReportKind } from "@/lib/driver/rules";
import { submitFieldReport } from "@/app/(app)/driver/actions";
import { toJpeg } from "@/lib/files/to-jpeg";
import { photoForPhone } from "@/lib/files/phone-photo";
import { announceOutbox, enqueueWithPhotos, isNetworkError, outboxTime } from "@/lib/offline/store";
import { cn } from "@/lib/cn";
import { Choice } from "./choice";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string } | { kind: "queued"; photos: number };

/**
 * The Send/Back bar stays in view at the bottom, and above the phone's tab bar when there is one (walkthrough P6:
 * after an error scrolled the form, the buttons sat under the tabs).
 */
export const STICKY_ACTIONS = "sticky bottom-0 max-md:[:root:has(nav[aria-label$=tabs])_&]:bottom-[calc(env(safe-area-inset-bottom)+5.25rem)]";

/** Scrolls a message to the middle of the screen, clear of the sticky Send bar (motion follows the phone's setting). */
export function showAbove(el: HTMLElement | null) {
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  window.requestAnimationFrame(() => el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }));
}

export function FieldReportForm({ assignmentId, truck, trailer, ticket = null, queue, onQueued, onBack }: {
  assignmentId: string; truck: string | null; trailer: string | null;
  /** A sent ticket this report is about ("Something wrong? Tell the office"). */
  ticket?: string | null;
  /**
   * Offline driver app (walkthrough P1): who is signed in and which load, so a report made without signal (a breakdown
   * where there is no coverage) waits on the phone and sends itself once there is signal, like a ticket.
   */
  queue?: { userId: string; label: string; timeZone?: string | null };
  /** After the report is saved on the phone (the offline page returns to its list). */
  onQueued?: () => void;
  /** Replaces the Back link (the offline page closes the form instead of opening My Day). */
  onBack?: () => void;
}) {
  const router = useRouter();
  const [submissionKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<ReportKind | "">("");
  // Only a truck on this load: it is the one choice, so it is chosen for the driver.
  const [equipment, setEquipment] = useState<"" | "truck" | "trailer">(defaultReportEquipment(truck, trailer));
  const prefill = ticket ? `About ticket ${ticket}: ` : "";
  const [description, setDescription] = useState(prefill);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<State>({ kind: "idle" });
  const needsEquipment = kind !== "" && reportNeedsEquipment(kind);
  // The answer to Send is brought into view above the Send bar (it would otherwise sit behind it on a phone).
  const answer = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (state.kind === "queued" || state.kind === "failed" || error) showAbove(answer.current); }, [state.kind, error]);

  /** Saved on the phone with its photos; false when the phone cannot keep it (no queue, storage full). */
  async function keep(): Promise<boolean> {
    if (!queue || !kind) return false;
    const at = new Date().toISOString();
    // The office sees when it was written, not only when the signal came back.
    const written = `(Written at ${outboxTime(at, queue.timeZone)} with no signal; sent once the phone had signal.)`;
    const text = `${description.trim().slice(0, 2000 - written.length - 2)}\n\n${written}`;
    let photos: Array<{ key: string; data: string }> = [];
    try {
      photos = await Promise.all(files.slice(0, MAX_PHOTOS).map(async (f) => ({ key: crypto.randomUUID(), data: await photoForPhone(f) })));
    } catch {
      photos = [];
    }
    const label = `${kind ? REPORT_KIND_LABELS[kind] : "Report"} · ${queue.label}`;
    const item = { id: submissionKey, userId: queue.userId, kind: "report" as const, label, createdAt: at,
      payload: { assignmentId, kind, equipment: needsEquipment ? equipment : "", description: text, submissionKey } };
    // The phone may refuse to keep the photos (storage full): the report itself is what matters, so it is kept alone.
    const kept = enqueueWithPhotos(item, photos) ? photos.length : enqueueWithPhotos(item, []) ? -1 : null;
    if (kept === null) return false;
    announceOutbox();
    setState({ kind: "queued", photos: kept });
    onQueued?.();
    return true;
  }

  async function send() {
    if (!kind) return setError("Choose what you are reporting.");
    if (needsEquipment && !equipment) return setError("Choose the truck or the trailer.");
    if (description.trim().length < 3 || (prefill && description.trim() === prefill.trim())) return setError(ticket ? "Say what is wrong with the ticket." : "Say in a few words what happened.");
    setError(null);
    setState({ kind: "sending" });
    if (typeof navigator !== "undefined" && navigator.onLine === false && (await keep())) return;
    try {
      const r = await submitFieldReport({ assignmentId, kind, equipment: needsEquipment ? equipment : "", description, submissionKey });
      if (r.ok) {
        // Photos go one by one after the report is saved, so a failed photo never loses the report.
        let failed = 0;
        let unavailable = false;
        for (const file of files.slice(0, MAX_PHOTOS)) {
          let blob: Blob = file;
          try { blob = await toJpeg(file); } catch { /* send as is; the server checks the bytes */ }
          const body = new FormData();
          body.set("report", r.data.reportId);
          body.set("file", new File([blob], "report.jpg", { type: blob.type || file.type }));
          const res = await fetch("/field-reports/photos", { method: "POST", body }).catch(() => null);
          if (res?.status === 501) { unavailable = true; break; }
          if (!res?.ok) failed++;
        }
        router.push(`/driver?sent=${encodeURIComponent(reportSentMessage(Math.min(files.length, MAX_PHOTOS), failed, unavailable))}`);
        return;
      }
      setState({ kind: "failed", message: r.error });
    } catch (e) {
      if (isNetworkError(e) && (await keep())) return;
      setState({ kind: "failed", message: "Not sent: no connection to the office. Nothing was saved on this phone. Check your signal and tap Send again, or call dispatch." });
    }
  }

  const sending = state.kind === "sending";
  const queued = state.kind === "queued";
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!sending && !queued) void send(); }} className="space-y-5" noValidate>
      {ticket && <p className="rounded-xl bg-surface px-4 py-3 text-sm"><strong>About ticket {ticket}.</strong> Choose what fits best below and say what is wrong (quantity, unit, material, time). The office sees the ticket number and checks it.</p>}
      <p className="rounded-xl bg-surface px-4 py-3 text-sm">This sends a message to the office. It does not take the truck out of service or change your loads. <strong>In an emergency, call 911 and dispatch first.</strong></p>
      <fieldset>
        <legend className="mb-2 text-base font-bold">What is happening?</legend>
        <div className="space-y-2">
          {REPORT_KINDS.map((k) => (
            <Choice key={k} name="kind" value={k} checked={kind === k} onChange={(v) => { setKind(v as ReportKind); setError(null); }} hint={REPORT_KIND_HELP[k]}>{REPORT_KIND_LABELS[k]}</Choice>
          ))}
        </div>
      </fieldset>
      {needsEquipment && (
        <fieldset>
          <legend className="mb-2 text-base font-bold">Which equipment?</legend>
          <div className="grid grid-cols-2 gap-2">
            <Choice name="equipment" value="truck" checked={equipment === "truck"} onChange={() => { setEquipment("truck"); setError(null); }}>{truck ? `Truck ${truck}` : "Truck"}</Choice>
            {trailer && <Choice name="equipment" value="trailer" checked={equipment === "trailer"} onChange={() => { setEquipment("trailer"); setError(null); }}>Trailer {trailer}</Choice>}
          </div>
        </fieldset>
      )}
      <div>
        <label htmlFor="r-desc" className="mb-2 block text-base font-bold">What happened?</label>
        <textarea id="r-desc" rows={4} maxLength={2000} value={description} onChange={(e) => { setDescription(e.target.value); setError(null); }} className="w-full rounded-2xl border-2 border-line bg-card px-4 py-3 text-lg focus:border-strong focus:outline-none" />
      </div>
      <div>
        <label htmlFor="r-photos" className="mb-2 block text-base font-bold">Photos (optional, up to {MAX_PHOTOS})</label>
        <label htmlFor="r-photos" className="flex min-h-14 cursor-pointer items-center gap-2 rounded-2xl border-2 border-dashed border-line bg-surface px-4 text-base text-muted hover:border-strong">
          <Camera className="size-5" aria-hidden />
          {files.length ? `${files.length} photo${files.length === 1 ? "" : "s"} chosen` : "Take or choose photos"}
        </label>
        <input id="r-photos" type="file" accept="image/jpeg,image/png,image/webp" multiple capture="environment" className="sr-only" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, MAX_PHOTOS))} />
      </div>
      {(error || state.kind === "failed") && (
        <p ref={answer} role="alert" className="rounded-xl bg-red-50 px-4 py-3 font-semibold text-red-900 ring-1 ring-red-200">{error ?? (state.kind === "failed" ? state.message : "")}</p>
      )}
      {state.kind === "queued" && (
        <p ref={answer} role="status" className="rounded-xl bg-amber-50 px-4 py-3 font-semibold text-amber-950 ring-1 ring-amber-200">
          Saved on this phone{state.photos > 0 ? ` with ${state.photos === 1 ? "its photo" : `its ${state.photos} photos`}` : ""}, not sent yet. It sends by itself when you have signal; My Day shows it under Waiting to send.
          {state.photos < 0 ? " The phone had no room for the photos: show them to the office later." : ""} If anyone is in danger or the road is blocked, call 911 and dispatch now.
        </p>
      )}
      <div className={cn(STICKY_ACTIONS, "-mx-4 flex gap-2 border-t border-line bg-card/95 px-4 py-3 backdrop-blur")}>
        {onBack
          ? <button type="button" onClick={onBack} className={buttonClasses("secondary", "md", "min-h-14 flex-1 justify-center text-base")}>Back</button>
          : <Link href="/driver" className={buttonClasses("secondary", "md", "min-h-14 flex-1 justify-center text-base")}>Back</Link>}
        <button type="submit" disabled={sending || queued} className={buttonClasses("primary", "md", "min-h-14 flex-[2] justify-center text-lg")}>
          {sending ? <><Loader2 className="size-5 animate-spin" aria-hidden /> Sending…</> : <><Send className="size-5" aria-hidden /> {state.kind === "failed" ? "Send again" : "Send report"}</>}
        </button>
      </div>
    </form>
  );
}
