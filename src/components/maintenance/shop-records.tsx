"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { recordInspection, returnPart } from "@/app/(app)/maintenance/shop-record-actions";

/**
 * The annual (DOT) inspection, recorded from its completed inspection work order onto the unit's inspection
 * certificate (20261120012400): the day, who inspected, when it expires and the sticker or certificate number.
 */
export function InspectionCertificateForm({ workOrderId, today, defaultExpires, unitWord }: { workOrderId: string; today: string; defaultExpires: string; unitWord: string }) {
  const router = useRouter();
  const { pending, onSubmit, fieldError, formError } = useFormAction(recordInspection.bind(null, workOrderId), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `insp-${name}`, name, ...describedBy(`insp-${name}`, fieldError(name)) });
  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2" noValidate>
      <FormError message={formError} />
      <Field label="Inspected on" htmlFor="insp-inspected_on" required error={fieldError("inspected_on")}>
        <DateInput {...f("inspected_on")} defaultValue={today} max={today} className="min-h-12 sm:min-h-0" />
      </Field>
      <Field label="Expires on" htmlFor="insp-expires_on" required error={fieldError("expires_on")} hint="Usually one year after the inspection.">
        <DateInput {...f("expires_on")} defaultValue={defaultExpires} className="min-h-12 sm:min-h-0" />
      </Field>
      <Field label="Inspector" htmlFor="insp-inspector" required error={fieldError("inspector")}>
        <Input {...f("inspector")} maxLength={120} autoComplete="name" className="min-h-12 sm:min-h-0" />
      </Field>
      <Field label="Sticker or certificate number" htmlFor="insp-reference" error={fieldError("reference")}>
        <Input {...f("reference")} maxLength={80} className="min-h-12 sm:min-h-0" />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" className="min-h-12 sm:min-h-0" loading={pending}>Update the {unitWord.toLowerCase()}&apos;s inspection</Button>
        <p className="text-sm text-muted">Add a photo of the report under Photos.</p>
      </div>
    </form>
  );
}

/** Put a part used on this job back in stock (20261120012600): how many and why; the use stays in the history. */
export function ReturnPartButton({ useId, workOrderId, name, unit, left }: { useId: number; workOrderId: string; name: string; unit: string; left: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(left));
  const [reason, setReason] = useState("");
  return (
    <>
      <Button variant="ghost" className="min-h-11 sm:min-h-0" icon={<Undo2 className="size-4" />} onClick={() => { setQty(String(left)); setReason(""); setOpen(true); }}>Return to stock</Button>
      <ConfirmDialog open={open} onOpenChange={setOpen} title={`Return ${name} to stock`} description="The part goes back on the shelf. Its use stays in the history, and its cost comes off this job." confirmLabel="Return to stock"
        onConfirm={async () => {
          if (reason.trim().length < 2) return "Say why the part goes back to stock.";
          const r = await returnPart({ useId, workOrderId, quantity: qty, reason });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Back in stock.");
          router.refresh();
        }}>
        <Field label={`How many (${unit})`} htmlFor={`ret-${useId}-qty`} hint={`At most ${left}.`}>
          <Input id={`ret-${useId}-qty`} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} className="min-h-12 sm:min-h-0" />
        </Field>
        <Field label="Why?" htmlFor={`ret-${useId}-why`} required>
          <Textarea id={`ret-${useId}-why`} rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: not needed, still sealed" />
        </Field>
      </ConfirmDialog>
    </>
  );
}
