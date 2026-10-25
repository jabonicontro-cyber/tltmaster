"use client";

import Link from "next/link";
import { DateInput } from "@/components/ui/date-input";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { quantityError } from "@/lib/tickets/rules";
import { submitDriverTicket } from "@/app/(app)/driver/actions";
import { Choice } from "./choice";
import { PhotoAttachments, type PhotoState } from "./photo-attachments";

interface Props {
  assignmentId: string;
  loadDate: string;
  defaultTime: string;
  lines: Array<{ id: string; description: string; unit_code: string }>;
  units: Array<{ code: string; label: string }>;
  existing: Array<{ number: string }>;
}

type State = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string; offline: boolean } | { kind: "confirm"; message: string };

const field = "min-h-12 w-full rounded-2xl border-2 border-line bg-card px-4 text-lg focus:border-strong focus:outline-none";

export function DriverTicketForm({ assignmentId, loadDate, defaultTime, lines, units, existing }: Props) {
  const router = useRouter();
  // One key for this form: retries and double taps can never create a second ticket.
  const [submissionKey] = useState(() => crypto.randomUUID());
  const [lineId, setLineId] = useState(lines.length === 1 ? lines[0].id : "");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [date, setDate] = useState(loadDate);
  const [time, setTime] = useState(defaultTime);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<State>({ kind: "idle" });
  const [photos, setPhotos] = useState<PhotoState>({ ids: [], busy: false, failed: false });
  const onPhotos = useCallback((p: PhotoState) => setPhotos(p), []);
  const line = lines.find((l) => l.id === lineId);
  // The order line's unit first (marked), never preselected.
  const orderedUnits = line ? [...units].sort((a, b) => (a.code === line.unit_code ? -1 : b.code === line.unit_code ? 1 : 0)) : units;

  async function send() {
    const e: Record<string, string> = {};
    if (!lineId) e.line = "Choose what you delivered.";
    if (!unit) e.unit = "Tap the unit on the paper ticket.";
    const q = quantity.trim() ? quantityError(quantity, unit || "ton") : "Enter the quantity.";
    if (q) e.quantity = q;
    if (!time) e.time = "Enter the delivery time.";
    if (photos.busy) e.photos = "Wait until the photo has uploaded.";
    else if (photos.failed) e.photos = "A photo did not upload. Tap Retry, or remove it.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setState({ kind: "sending" });
    try {
      const r = await submitDriverTicket({
        assignmentId, orderLineId: lineId, deliveredDate: date, deliveredTime: time, quantity, unitCode: unit,
        externalReference: reference, notes, submissionKey, confirmDuplicate: confirmed, photoIds: photos.ids,
      });
      if (r.ok) {
        // Only now, after the server confirmed it.
        router.push(`/driver?sent=${encodeURIComponent(`Ticket ${r.data.ticketNumber} sent to the office.`)}`);
        return;
      }
      if ("needsConfirmation" in r) { setState({ kind: "confirm", message: r.error }); return; }
      setErrors(r.fieldErrors ?? {});
      setState({ kind: "failed", message: r.error, offline: false });
    } catch {
      setState({ kind: "failed", message: "Not sent — no connection to the office. Nothing was saved on this phone. Check your signal and tap Send again.", offline: true });
    }
  }

  const sending = state.kind === "sending";
  return (
    <form onSubmit={(ev) => { ev.preventDefault(); if (!sending) void send(); }} className="space-y-5" noValidate>
      {existing.length > 0 && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950 ring-1 ring-amber-200">
          This load already has ticket {existing.map((t) => t.number).join(", ")}. Only add one if this is a separate delivery.
        </p>
      )}

      <fieldset>
        <legend className="mb-2 text-base font-bold">What did you deliver?</legend>
        <div className="space-y-2">
          {lines.map((l) => (
            <Choice key={l.id} name="line" value={l.id} checked={lineId === l.id} onChange={setLineId}>{l.description}</Choice>
          ))}
        </div>
        {errors.line && <p className="mt-1 font-semibold text-red-700">{errors.line}</p>}
      </fieldset>

      <div>
        <label htmlFor="d-qty" className="mb-2 block text-base font-bold">Quantity on the ticket</label>
        <input id="d-qty" inputMode="decimal" autoComplete="off" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={cn(field, "text-right text-2xl font-bold tabular")} aria-invalid={Boolean(errors.quantity)} />
        {errors.quantity && <p className="mt-1 font-semibold text-red-700">{errors.quantity}</p>}
      </div>

      <fieldset>
        <legend className="mb-2 text-base font-bold">Unit</legend>
        <div className="grid grid-cols-2 gap-2">
          {orderedUnits.map((u) => (
            <Choice key={u.code} name="unit" value={u.code} checked={unit === u.code} onChange={setUnit} hint={line && u.code === line.unit_code ? "Order unit" : undefined}>{u.label}</Choice>
          ))}
        </div>
        {line && unit && unit !== line.unit_code && <p className="mt-2 text-sm text-amber-900">Different from the order unit — the office will check it. No conversion is made.</p>}
        {errors.unit && <p className="mt-1 font-semibold text-red-700">{errors.unit}</p>}
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="d-date" className="mb-2 block text-base font-bold">Date</label>
          <DateInput id="d-date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="d-time" className="mb-2 block text-base font-bold">Delivery time</label>
          <input id="d-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className={field} />
          {errors.time && <p className="mt-1 font-semibold text-red-700">{errors.time}</p>}
        </div>
      </div>

      <div>
        <label htmlFor="d-ref" className="mb-2 block text-base font-bold">Paper / scale ticket number</label>
        <input id="d-ref" autoComplete="off" maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} className={field} />
      </div>

      <div>
        <PhotoAttachments assignmentId={assignmentId} onChange={onPhotos} disabled={sending} />
        {errors.photos && <p className="mt-1 font-semibold text-red-700">{errors.photos}</p>}
      </div>

      <div>
        <label htmlFor="d-notes" className="mb-2 block text-base font-bold">Notes (optional)</label>
        <textarea id="d-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} className={cn(field, "py-3")} />
      </div>

      {state.kind === "confirm" && (
        <div role="alert" className="space-y-2 rounded-xl bg-amber-50 px-4 py-3 text-amber-950 ring-1 ring-amber-300">
          <p className="font-semibold">{state.message}</p>
          <label className="flex min-h-12 items-center gap-3 font-semibold">
            <input type="checkbox" className="size-6 accent-brand" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Yes, this is a separate delivery
          </label>
        </div>
      )}
      {state.kind === "failed" && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 font-semibold text-red-900 ring-1 ring-red-200">{state.message}</p>
      )}

      <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-line bg-card/95 px-4 py-3 backdrop-blur">
        <Link href="/driver" className={buttonClasses("secondary", "md", "min-h-14 flex-1 justify-center text-base")}>Back</Link>
        <button type="submit" disabled={sending || photos.busy || (state.kind === "confirm" && !confirmed)} className={buttonClasses("primary", "md", "min-h-14 flex-[2] justify-center text-lg")}>
          {sending ? <><Loader2 className="size-5 animate-spin" aria-hidden /> Sending…</> : <><Send className="size-5" aria-hidden /> {state.kind === "failed" ? "Send again" : "Send ticket"}</>}
        </button>
      </div>
    </form>
  );
}
