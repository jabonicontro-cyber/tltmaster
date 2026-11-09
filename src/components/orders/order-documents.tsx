"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { removeOrderDocument } from "@/app/(app)/orders/document-actions";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { formatDateTime } from "@/lib/dates";
import { SUPPORT_ACCEPT, SUPPORT_MAX_BYTES } from "@/lib/support";

// Order documents (MK2): rate confirmation, bills of lading and proofs of delivery, optionally for one stop. The
// server checks the file's real content and the database checks who may add it; files open through a one-minute link.

export const DOCUMENT_KINDS = {
  rate_confirmation: "Rate confirmation",
  bill_of_lading: "Bill of lading",
  proof_of_delivery: "Proof of delivery",
  other: "Other",
} as const;
type Kind = keyof typeof DOCUMENT_KINDS;

export interface DocumentRow { id: string; kind: Kind; stop_id: string | null; file_name: string; size_bytes: number; created_at: string; uploaded_by: string | null }
export interface StopOption { id: string; label: string }

const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function OrderDocuments({ orderId, documents, stops, names, canEdit }: { orderId: string; documents: DocumentRow[]; stops: StopOption[]; names: Record<string, string>; canEdit: boolean }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("rate_confirmation");
  const [stop, setStop] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopLabel = (id: string | null) => (id ? stops.find((s) => s.id === id)?.label ?? "A removed stop" : null);

  async function upload(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!SUPPORT_ACCEPT.split(",").includes(file.type)) return setError("Add photos (JPEG, PNG, WebP) or PDFs only.");
    if (file.size > SUPPORT_MAX_BYTES) return setError("Each file can be at most 10 MB.");
    setBusy(true);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("kind", kind);
      if (stop) body.set("stop", stop);
      const res = await fetch(`/orders/${orderId}/documents`, { method: "POST", body });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setError(out.error ?? "The document could not be added. Try again.");
      toast.success(`${DOCUMENT_KINDS[kind]} added.`);
      router.refresh();
    } catch {
      setError("The server could not be reached. The document was not added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 px-5 pb-5">
      {documents.length === 0 ? (
        <p className="text-sm text-muted">No documents yet.{canEdit ? " Add the rate confirmation when the load is booked, and the signed bill of lading or proof of delivery after each stop." : ""}</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Order documents">
          {documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
              <FileText className="size-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <a href={`/order-documents/${d.id}`} target="_blank" rel="noreferrer" className="font-medium text-brand-fg underline-offset-2 hover:underline">{DOCUMENT_KINDS[d.kind]}{stopLabel(d.stop_id) ? ` · ${stopLabel(d.stop_id)}` : ""}</a>
                <p className="truncate text-muted">{d.file_name} · {size(d.size_bytes)} · added {formatDateTime(d.created_at)}{d.uploaded_by && names[d.uploaded_by] ? ` by ${names[d.uploaded_by]}` : ""}</p>
              </div>
              {canEdit && <RemoveDocument orderId={orderId} documentId={d.id} name={DOCUMENT_KINDS[d.kind]} />}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,14rem)_minmax(0,1fr)] sm:items-end">
          <Field label="Document" htmlFor="od-kind">
            <Select id="od-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {(Object.keys(DOCUMENT_KINDS) as Kind[]).map((k) => <option key={k} value={k}>{DOCUMENT_KINDS[k]}</option>)}
            </Select>
          </Field>
          <Field label="For" htmlFor="od-stop">
            <Select id="od-stop" value={stop} onChange={(e) => setStop(e.target.value)}>
              <option value="">The whole order</option>
              {stops.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
          </Field>
          <Field label="File (photo or PDF, up to 10 MB)" htmlFor="od-file">
            <input id="od-file" type="file" accept={SUPPORT_ACCEPT} disabled={busy} className="block w-full text-sm text-muted file:mr-3 file:rounded-full file:border file:border-line file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
          </Field>
        </div>
      )}
      {busy && <p className="text-sm text-muted" role="status">Adding the document…</p>}
      <FormError message={error} />
    </div>
  );
}

function RemoveDocument({ orderId, documentId, name }: { orderId: string; documentId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { pending, onSubmit, formError } = useFormAction(removeOrderDocument, {
    onSuccess: (res) => { toast.success(res.message ?? "Removed."); setOpen(false); router.refresh(); },
  });
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Remove ${name}`}>Remove</Button>;
  return (
    <form onSubmit={onSubmit} className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <input type="hidden" name="order" value={orderId} />
      <input type="hidden" name="document" value={documentId} />
      <label className="sr-only" htmlFor={`od-r-${documentId}`}>Reason to remove the document</label>
      <Input id={`od-r-${documentId}`} name="reason" placeholder="Reason, like wrong load" maxLength={300} className="h-8 w-52 text-sm" required autoFocus />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>Remove document</Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      <FormError message={formError} />
    </form>
  );
}
