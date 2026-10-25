"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { REPORT_KINDS, REPORT_KIND_HELP, REPORT_KIND_LABELS, reportNeedsEquipment, type ReportKind } from "@/lib/driver/rules";
import { submitFieldReport } from "@/app/(app)/driver/actions";
import { Choice } from "./choice";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string };

export function FieldReportForm({ assignmentId, truck, trailer }: { assignmentId: string; truck: string | null; trailer: string | null }) {
  const router = useRouter();
  const [submissionKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<ReportKind | "">("");
  const [equipment, setEquipment] = useState<"" | "truck" | "trailer">("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const needsEquipment = kind !== "" && reportNeedsEquipment(kind);

  async function send() {
    if (!kind) return setError("Choose what you are reporting.");
    if (needsEquipment && !equipment) return setError("Choose the truck or the trailer.");
    if (description.trim().length < 3) return setError("Say in a few words what happened.");
    setError(null);
    setState({ kind: "sending" });
    try {
      const r = await submitFieldReport({ assignmentId, kind, equipment: needsEquipment ? equipment : "", description, submissionKey });
      if (r.ok) {
        router.push(`/driver?sent=${encodeURIComponent("Report sent to the office. Call dispatch if anyone is in danger.")}`);
        return;
      }
      setState({ kind: "failed", message: r.error });
    } catch {
      setState({ kind: "failed", message: "Not sent — no connection to the office. Nothing was saved on this phone. Check your signal and tap Send again, or call dispatch." });
    }
  }

  const sending = state.kind === "sending";
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!sending) void send(); }} className="space-y-5" noValidate>
      <p className="rounded-xl bg-surface px-4 py-3 text-sm">This sends a message to the office. It does not take the truck out of service or change your loads. <strong>In an emergency, call 911 and dispatch first.</strong></p>
      <fieldset>
        <legend className="mb-2 text-base font-bold">What is happening?</legend>
        <div className="space-y-2">
          {REPORT_KINDS.map((k) => (
            <Choice key={k} name="kind" value={k} checked={kind === k} onChange={(v) => setKind(v as ReportKind)} hint={REPORT_KIND_HELP[k]}>{REPORT_KIND_LABELS[k]}</Choice>
          ))}
        </div>
      </fieldset>
      {needsEquipment && (
        <fieldset>
          <legend className="mb-2 text-base font-bold">Which equipment?</legend>
          <div className="grid grid-cols-2 gap-2">
            <Choice name="equipment" value="truck" checked={equipment === "truck"} onChange={() => setEquipment("truck")}>Truck {truck ?? ""}</Choice>
            {trailer && <Choice name="equipment" value="trailer" checked={equipment === "trailer"} onChange={() => setEquipment("trailer")}>Trailer {trailer}</Choice>}
          </div>
        </fieldset>
      )}
      <div>
        <label htmlFor="r-desc" className="mb-2 block text-base font-bold">What happened?</label>
        <textarea id="r-desc" rows={4} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-2xl border-2 border-line bg-card px-4 py-3 text-lg focus:border-strong focus:outline-none" />
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
