"use client";

// The mechanic and dispatcher decisions of 2026-11-09 (master plan MD1) where people act on them: putting a unit back
// in service once its shop work is done, marking a wrong reading, and checking a certificate the shop recorded. Each
// button calls a server action; the database checks the permission, the company and the dispatch base again.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CheckCircle2, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { formatDate } from "@/lib/dates";
import { markReadingWrong, returnUnitAfterShop, verifyVehicleDocument } from "@/app/(app)/fleet/actions";

export interface BackFromShopUnit {
  kind: "truck" | "trailer";
  id: string;
  unit_number: string;
  out_of_service_reason: string;
  work_order_id: string | null;
  work_order_number: string | null;
}

/**
 * "All shop work on truck 104 is done. Put it back in service?" with one tap (fleet.service, fleet.edit or
 * maintenance.manage). Never returns a unit by itself. People who cannot return it are told who can.
 */
export function BackFromShopPrompt({ units, canReturn }: { units: BackFromShopUnit[]; canReturn: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  if (!units.length) return null;
  const put = (u: BackFromShopUnit) => {
    setBusy(u.id);
    start(async () => {
      const r = await returnUnitAfterShop({ kind: u.kind, id: u.id });
      setBusy(null);
      if (!r.ok) toast.error(r.error);
      else { toast.success(r.message ?? "Back in service."); router.refresh(); }
    });
  };
  return (
    <section aria-label="Shop work done" className="mb-5 space-y-2" data-testid="back-from-shop">
      {units.map((u) => {
        const name = `${u.kind === "truck" ? "truck" : "trailer"} ${u.unit_number}`;
        return (
          <div key={u.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-card px-4 py-3.5 text-sm text-ink shadow-card ring-1 ring-line/60">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-light text-brand-fg" aria-hidden><Truck className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">All shop work on {name} is done. Put it back in service?</p>
              <p className="text-muted">
                A person took it out of service{u.out_of_service_reason ? ` (${u.out_of_service_reason})` : ""}, so it does not come back by itself.
                {u.work_order_id && u.work_order_number ? <> Last job: <Link href={`/maintenance/work-orders/${u.work_order_id}`} className="underline">{u.work_order_number}</Link>.</> : null}
                {!canReturn ? " Ask the office or the shop to put it back in service." : ""}
              </p>
            </div>
            {canReturn && (
              <Button size="sm" loading={pending && busy === u.id} disabled={pending} icon={<CheckCircle2 className="size-4" />} onClick={() => put(u)}
                aria-label={`Put ${name} back in service`}>
                Put back in service
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** "Mark as wrong" on one reading: asks why, then sets it aside (kept in the history, never the current reading). */
export function MarkReadingWrong({ truckId, readingId, label }: { truckId: string; readingId: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open) {
    return <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Mark the reading ${label} as wrong`}>Mark as wrong</Button>;
  }
  const save = () => start(async () => {
    const r = await markReadingWrong({ truckId, readingId, reason });
    if (!r.ok) { setError(r.fieldErrors?.reason ?? r.error); return; }
    toast.success(r.message ?? "Reading set aside.");
    setOpen(false);
    setReason("");
    setError(null);
    router.refresh();
  });
  const id = `wrong-${readingId}`;
  return (
    <div className="mt-2 w-full rounded-xl border border-line p-3">
      <p className="text-sm">The reading {label} is set aside: it stays in the history but no longer counts. The last good reading becomes the current one, and the next correct reading counts again.</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <Field label="Why is it wrong?" htmlFor={id} error={error ?? undefined} className="min-w-56 flex-1">
          <Input id={id} value={reason} maxLength={300} placeholder="For example: typo on the fuel slip" onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Button size="sm" loading={pending} onClick={save}>Set it aside</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setOpen(false); setError(null); }}>Cancel</Button>
      </div>
    </div>
  );
}

/** "Mark checked" on a certificate the shop recorded (fleet.edit, the existing verify step). */
export function CheckCertificateButton({ vehicle, documentId, unit, expiresOn }: { vehicle: { kind: "truck" | "trailer"; id: string }; documentId: string; unit: string; expiresOn: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="secondary" loading={pending} icon={<CheckCircle2 className="size-4" />} aria-label={`Mark the inspection certificate of ${unit} checked`} onClick={() => {
      if (!window.confirm(`Check the paper certificate first: the inspection date${expiresOn ? ` and the expiry date (${formatDate(expiresOn)})` : ""} must match. Mark it checked?`)) return;
      start(async () => {
        const r = await verifyVehicleDocument(vehicle, documentId);
        if (!r.ok) toast.error(r.error);
        else { toast.success("Certificate checked."); router.refresh(); }
      });
    }}>
      Mark checked
    </Button>
  );
}
