"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Camera, Loader2, Send } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { MAX_REPORT_PHOTOS as MAX_PHOTOS, REPORT_KINDS, REPORT_KIND_HELP, REPORT_KIND_LABELS, defaultReportEquipment, reportNeedsEquipment, reportSentMessage, type ReportKind } from "@/lib/driver/rules";
import { submitFieldReport } from "@/app/(app)/driver/actions";
import { toJpeg } from "@/lib/files/to-jpeg";
import { Choice } from "./choice";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string };

export function FieldReportForm({ assignmentId, truck, trailer, ticket = null }: { assignmentId: string; truck: string | null; trailer: string | null; /** A sent ticket this report is about ("Something wrong? Tell the office"). */ ticket?: string | null }) {
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

  async function send() {
    if (!kind) return setError("Choose what you are reporting.");
    if (needsEquipment && !equipment) return setError("Choose the truck or the trailer.");
    if (description.trim().length < 3 || (prefill && description.trim() === prefill.trim())) return setError(ticket ? "Say what is wrong with the ticket." : "Say in a few words what happened.");
    setError(null);
    setState({ kind: "sending" });
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
    } catch {
      setState({ kind: "failed", message: "Not sent: no connection to the office. Nothing was saved on this phone. Check your signal and tap Send again, or call dispatch." });
    }
  }

  const sending = state.kind === "sending";
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!sending) void send(); }} className="space-y-5" noValidate>
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
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 font-semibold text-red-900 ring-1 ring-red-200">{error ?? (state.kind === "failed" ? state.message : "")}</p>
      )}
      <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-line bg-card/95 px-4 py-3 backdrop-blur">
        <Link href="/driver" className={buttonClasses("secondary", "md", "min-h-14 flex-1 justify-center text-base")}>Back</Link>
        <button type="submit" disabled={sending} className={buttonClasses("primary", "md", "min-h-14 flex-[2] justify-center text-lg")}>
          {sending ? <><Loader2 className="size-5 animate-spin" aria-hidden /> Sending…</> : <><Send className="size-5" aria-hidden /> {state.kind === "failed" ? "Send again" : "Send report"}</>}
        </button>
      </div>
    </form>
  );
}
