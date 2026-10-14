"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ClipboardCheck, ShieldCheck, ShieldX, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { COST_KINDS, nextStatuses, STATUS_ACTION_LABELS, type WoStatus } from "@/lib/maintenance";
import { addCost, generateDueWorkOrders, recordClearance, removeCost, setWorkOrderStatus, startInspection } from "@/app/(app)/maintenance/actions";

/** Lifecycle buttons: only the moves the database allows from here. Cancel asks for a reason. */
export function StatusActions({ id, status, safetyCritical, editSeq, canClear, unit = "truck" }: { id: string; status: WoStatus; safetyCritical: boolean; editSeq: number; canClear: boolean; unit?: "truck" | "trailer" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<WoStatus | null>(null);
  const [note, setNote] = useState("");
  const options = nextStatuses(status, safetyCritical).filter((s) => !(s === "canceled" && safetyCritical && !canClear));

  const go = (to: WoStatus, n = "") =>
    setWorkOrderStatus({ id, status: to, note: n, editSeq }).then((r) => {
      if (!r.ok) return r.error;
      toast.success(r.message ?? "Saved.");
      router.refresh();
    });

  if (status === "awaiting_inspection") return <p className="text-sm text-muted">Waiting for an authorized inspection (clearance queue).</p>;
  if (!options.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((to) => (
        <Button
          key={to}
          variant={to === "canceled" ? "ghost" : to === "awaiting_inspection" || to === "completed" || to === "in_progress" ? "primary" : "secondary"}
          disabled={pending}
          onClick={() => {
            if (to === "canceled" || to === "in_progress" && status === "completed") {
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
          {to === "in_progress" && status === "completed" ? "Reopen" : STATUS_ACTION_LABELS[to]}
        </Button>
      ))}
      {safetyCritical && status === "in_progress" && (
        <p className="basis-full text-sm text-muted">Safety-critical: completing goes through an inspection by someone authorized to clear the {unit}.</p>
      )}
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
        <Button variant="secondary" disabled={pending} icon={<ClipboardCheck className="size-4" />} onClick={() => start(async () => {
          const r = await startInspection(id);
          if (!r.ok) toast.error(r.error);
          else { toast.success(r.message ?? "Started."); router.refresh(); }
        })}>Start inspection</Button>
      )}
      <Button icon={<ShieldCheck className="size-4" />} onClick={() => { setNotes(""); setOutcome("passed"); }}>Passed — clear for service</Button>
      <Button variant="secondary" icon={<ShieldX className="size-4" />} onClick={() => { setNotes(""); setOutcome("failed"); }}>Failed</Button>
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
  const { pending, onSubmit, fieldError, formError } = useFormAction(addCost.bind(null, workOrderId), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      setFormKey((k) => k + 1);
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `cost-${name}`, name, ...describedBy(`cost-${name}`, fieldError(name)) });
  return (
    <form key={formKey} onSubmit={onSubmit} className="grid grid-cols-2 gap-3 sm:grid-cols-6" noValidate>
      <div className="col-span-2 sm:col-span-6"><FormError message={formError} /></div>
      <Field label="Kind" htmlFor="cost-kind" className="sm:col-span-1">
        <Select {...f("kind")} defaultValue="part">{Object.entries(COST_KINDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
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
