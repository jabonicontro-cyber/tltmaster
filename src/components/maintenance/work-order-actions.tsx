"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ClipboardCheck, ShieldCheck, ShieldX, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { DateInput } from "@/components/ui/date-input";
import { useFormAction } from "@/components/ui/use-form-action";
import { COMPLETED_VS_CLOSED, COST_KINDS, nextStatuses, STATUS_ACTION_LABELS, type WoStatus } from "@/lib/maintenance";
import { addCost, generateDueWorkOrders, recordClearance, removeCost, setWorkOrderStatus, startInspection } from "@/app/(app)/maintenance/actions";
import { startJob } from "@/app/(app)/maintenance/crew-actions";
import { cn } from "@/lib/cn";
import { PartOnOrderDialog } from "@/components/maintenance/parts-on-order";

/** Lifecycle buttons: only the moves the database allows from here. Cancel asks for a reason. */
export function StatusActions({ id, status, safetyCritical, editSeq, canClear, unit = "truck", canCosts = false }: { id: string; status: WoStatus; safetyCritical: boolean; editSeq: number; canClear: boolean; unit?: "truck" | "trailer"; canCosts?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<WoStatus | null>(null);
  const [note, setNote] = useState("");
  // "Waiting for parts" records what is on order (part, vendor, PO, expected date), 20261120012300.
  const [waiting, setWaiting] = useState(false);
  const options = nextStatuses(status, safetyCritical).filter((s) => !(s === "canceled" && safetyCritical && !canClear));

  // Buttons are big enough for gloved hands on a phone (B5) and the usual size from a tablet up.
  // One start rule (I1): "Start work" here is "Start this job" on My jobs: whoever starts a job nobody leads becomes
  // its lead, and their timer starts. Reopening a completed job stays a plain status change.
  const go = (to: WoStatus, n = "") =>
    (to === "in_progress" && status !== "completed" ? startJob({ workOrderId: id, editSeq }) : setWorkOrderStatus({ id, status: to, note: n, editSeq })).then((r) => {
      if (!r.ok) return r.error;
      toast.success(r.message ?? "Saved.");
      router.refresh();
    });

  if (status === "awaiting_inspection") return <p className="text-sm text-muted">Waiting for an authorized inspection. Someone allowed to clear vehicles for service records the result.</p>;
  if (!options.length) return null;
  // Cancel sits on its own line, away from the step that moves the job forward (first-day review 2026-11-09).
  // The step that moves the job forward comes first.
  const primary = (s: WoStatus) => (s === "in_progress" || s === "awaiting_inspection" || s === "completed" ? 0 : 1);
  const forward = options.filter((s) => s !== "canceled").sort((a, b) => primary(a) - primary(b));
  const button = (to: WoStatus) => (
    <Button
      key={to}
      variant={to === "canceled" ? "ghost" : to === "awaiting_inspection" || to === "completed" || to === "in_progress" ? "primary" : "secondary"}
      className={cn("min-h-12 sm:min-h-0", to === "canceled" && "text-muted")}
      disabled={pending}
      onClick={() => {
        // Cancel asks why, reopening asks for an optional note, and "Waiting for parts" asks which part.
        if (to === "awaiting_parts") {
          setWaiting(true);
        } else if (to === "canceled" || to === "in_progress" && status === "completed") {
          setNote("");
          setConfirm(to);
        } else {
          start(async () => {
            const err = await go(to);
            if (err) toast.error(err);
          });
        }
      }}
    >
      {to === "in_progress" && status === "completed" ? "Reopen" : to === "triaged" && status === "awaiting_parts" ? "Parts are in: back to the queue" : STATUS_ACTION_LABELS[to]}
    </Button>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {forward.map(button)}
      {safetyCritical && status === "in_progress" && (
        <p className="basis-full text-sm text-muted">Safety-critical: completing goes through an inspection by someone authorized to clear the {unit}.</p>
      )}
      {status === "completed" && <p className="basis-full text-sm text-muted">{COMPLETED_VS_CLOSED} Reopen it if more work is needed.</p>}
      {options.includes("canceled") && <div className="mt-1 basis-full border-t border-line/70 pt-3">{button("canceled")}</div>}
      <PartOnOrderDialog workOrderId={id} open={waiting} onOpenChange={setWaiting} setWaiting canCosts={canCosts} />
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "canceled" ? "Cancel the work order" : "Reopen the work order"}
        description={confirm === "canceled"
          ? (unit === "trailer" ? "The driver whose truck usually pulls this trailer sees the cancellation on My Day if it was scheduled." : "The driver of this truck sees the cancellation on My Day if it was scheduled.")
          : safetyCritical ? `The ${unit} goes out of service again until a new inspection clears it.` : "The work order goes back to in progress."}
        confirmLabel={confirm === "canceled" ? "Cancel work order" : "Reopen"}
        tone={confirm === "canceled" ? "danger" : "primary"}
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm === "canceled" && !note.trim()) return "Enter a reason for canceling.";
          return go(confirm, note);
        }}
      >
        <Field label={confirm === "canceled" ? "Reason" : "Note (optional)"} htmlFor="status-note" required={confirm === "canceled"}>
          <Textarea id="status-note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

/** Inspection and clearance (maintenance.clear). */
export function ClearanceActions({ id, clearance, unit = "truck" }: { id: string; clearance: "awaiting" | "in_progress"; unit?: "truck" | "trailer" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<"passed" | "failed" | null>(null);
  const [notes, setNotes] = useState("");
  return (
    <div className="flex flex-wrap gap-2">
      {clearance === "awaiting" && (
        <Button variant="secondary" className="min-h-12 sm:min-h-0" disabled={pending} icon={<ClipboardCheck className="size-4" />} onClick={() => start(async () => {
          const r = await startInspection(id);
          if (!r.ok) toast.error(r.error);
          else { toast.success(r.message ?? "Started."); router.refresh(); }
        })}>Start inspection</Button>
      )}
      <Button className="min-h-12 sm:min-h-0" icon={<ShieldCheck className="size-4" />} onClick={() => { setNotes(""); setOutcome("passed"); }}>Passed, clear for service</Button>
      <Button variant="secondary" className="min-h-12 sm:min-h-0" icon={<ShieldX className="size-4" />} onClick={() => { setNotes(""); setOutcome("failed"); }}>Failed</Button>
      <ConfirmDialog
        open={Boolean(outcome)}
        onOpenChange={(o) => !o && setOutcome(null)}
        title={outcome === "passed" ? "Record a passed inspection" : "Record a failed inspection"}
        description={outcome === "passed"
          ? `Completes the repair under your name. If this work order restricted the ${unit} and nothing else does, the ${unit} returns to service.`
          : `The work order goes back to in progress and the ${unit} stays out of service.`}
        confirmLabel={outcome === "passed" ? "Clear for service" : "Record failure"}
        onConfirm={async () => {
          if (!outcome) return;
          if (outcome === "failed" && !notes.trim()) return "Describe what failed so the shop knows what to fix.";
          const r = await recordClearance({ id, outcome, notes });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved.");
          router.refresh();
        }}
      >
        <Field label={outcome === "failed" ? "What failed" : "Inspection notes (optional)"} htmlFor="clearance-notes" required={outcome === "failed"}>
          <Textarea id="clearance-notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

export function CostForm({ workOrderId }: { workOrderId: string }) {
  const router = useRouter();
  const [formKey, setFormKey] = useState(0);
  // An outside repair (vendor line) also records the vendor's invoice and warranty (20261120012500).
  const [kind, setKind] = useState("part");
  const { pending, onSubmit, fieldError, formError } = useFormAction(addCost.bind(null, workOrderId), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      setFormKey((k) => k + 1);
      setKind("part");
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `cost-${name}`, name, ...describedBy(`cost-${name}`, fieldError(name)) });
  return (
    <form key={formKey} onSubmit={onSubmit} className="grid grid-cols-2 gap-3 sm:grid-cols-6" noValidate>
      <div className="col-span-2 sm:col-span-6"><FormError message={formError} /></div>
      <Field label="Kind" htmlFor="cost-kind" className="sm:col-span-1">
        <Select {...f("kind")} value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(COST_KINDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
      </Field>
      <Field label="Description" htmlFor="cost-description" required error={fieldError("description")} className="col-span-2 sm:col-span-2">
        <Input {...f("description")} maxLength={200} />
      </Field>
      <Field label="Part number" htmlFor="cost-part_number" error={fieldError("part_number")} className="sm:col-span-1">
        <Input {...f("part_number")} maxLength={60} />
      </Field>
      <Field label="Vendor" htmlFor="cost-vendor_name" error={fieldError("vendor_name")} className="sm:col-span-2">
        <Input {...f("vendor_name")} maxLength={120} />
      </Field>
      <Field label="Quantity" htmlFor="cost-quantity" error={fieldError("quantity")} className="sm:col-span-1">
        <Input {...f("quantity")} inputMode="decimal" defaultValue="1" />
      </Field>
      <Field label="Unit cost ($)" htmlFor="cost-unit_cost" required error={fieldError("unit_cost")} className="sm:col-span-1">
        <Input {...f("unit_cost")} inputMode="decimal" placeholder="0.00" />
      </Field>
      {kind === "vendor" && (
        <>
          <Field label="Vendor invoice number" htmlFor="cost-invoice_number" error={fieldError("invoice_number")} className="sm:col-span-2">
            <Input {...f("invoice_number")} maxLength={60} />
          </Field>
          <Field label="Invoice date" htmlFor="cost-invoice_date" error={fieldError("invoice_date")} className="sm:col-span-2">
            <DateInput {...f("invoice_date")} />
          </Field>
          <Field label="Warranty until" htmlFor="cost-warranty_until" error={fieldError("warranty_until")} hint="Leave empty when there is no warranty." className="col-span-2 sm:col-span-2">
            <DateInput {...f("warranty_until")} />
          </Field>
        </>
      )}
      <div className="col-span-2 flex items-end sm:col-span-4">
        <Button type="submit" variant="secondary" loading={pending}>Add cost</Button>
      </div>
    </form>
  );
}

export function RemoveCostButton({ workOrderId, costId, label }: { workOrderId: string; costId: string; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      disabled={pending}
      className="rounded p-1 text-muted hover:bg-surface hover:text-ink disabled:opacity-50"
      onClick={() => {
        if (!window.confirm(`Remove “${label}”?`)) return;
        start(async () => {
          const r = await removeCost(workOrderId, costId);
          if (!r.ok) toast.error(r.error);
          else { toast.success(r.message ?? "Removed."); router.refresh(); }
        });
      }}
    >
      <Trash2 className="size-4" />
    </button>
  );
}

export function GenerateDueButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="secondary" loading={pending} onClick={() => start(async () => {
      const r = await generateDueWorkOrders();
      if (!r.ok) toast.error(r.error);
      else { toast.success(r.message ?? "Done."); router.refresh(); }
    })}>Create work orders for due services</Button>
  );
}
