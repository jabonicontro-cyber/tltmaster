"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { countPart, receivePart, savePart, usePart } from "@/app/(app)/maintenance/parts/actions";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";

type PartLite = { id: string; part_number: string; name: string; unit: string; location: string; on_hand: number; reorder_point: number };

function useAction(action: (f: FormData) => Promise<ActionResult>, done: () => void) {
  const router = useRouter();
  return useFormAction(action, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      done();
      router.refresh();
    },
  });
}

/** Add a part, or edit one (name, number, unit, shelf, reorder point). Stock changes go through Receive and Count. */
export function PartDialogButton({ part, label = "Add part", variant = "primary" }: { part?: PartLite; label?: string; variant?: "primary" | "secondary" | "ghost" }) {
  const [open, setOpen] = useState(false);
  const { pending, onSubmit, formError } = useAction(savePart, () => setOpen(false));
  return (
    <>
      <Button size={part ? "sm" : "md"} variant={variant} onClick={() => setOpen(true)} aria-label={part ? `Edit ${part.name}` : undefined}>{label}</Button>
      <Dialog open={open} onOpenChange={setOpen} title={part ? `Edit ${part.name}` : "Add a part"} size="sm">
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          {part && <input type="hidden" name="id" value={part.id} />}
          <FormError message={formError} />
          <Field label="Name" htmlFor="pt-name" required><Input id="pt-name" name="name" maxLength={160} defaultValue={part?.name} required /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Part number" htmlFor="pt-number"><Input id="pt-number" name="part_number" maxLength={60} defaultValue={part?.part_number} /></Field>
            <Field label="Unit" htmlFor="pt-unit" hint="each, kit, gal…"><Input id="pt-unit" name="unit" maxLength={20} defaultValue={part?.unit ?? "each"} /></Field>
            <Field label="Shelf or location" htmlFor="pt-loc"><Input id="pt-loc" name="location" maxLength={80} defaultValue={part?.location} /></Field>
            <Field label="Reorder at" htmlFor="pt-reorder" hint="0 = no low-stock flag"><Input id="pt-reorder" name="reorder_point" inputMode="decimal" defaultValue={part ? String(part.reorder_point) : "0"} /></Field>
          </div>
          <Button type="submit" loading={pending}>{part ? "Save part" : "Add part"}</Button>
        </form>
      </Dialog>
    </>
  );
}

export function ReceiveButton({ part, canCosts }: { part: PartLite; canCosts: boolean }) {
  const [open, setOpen] = useState(false);
  const { pending, onSubmit, formError } = useAction(receivePart, () => setOpen(false));
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} aria-label={`Receive ${part.name}`}>Receive</Button>
      <Dialog open={open} onOpenChange={setOpen} title={`Receive ${part.name}`} description={`${part.on_hand} ${part.unit} on hand now.`} size="sm">
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <input type="hidden" name="id" value={part.id} />
          <FormError message={formError} />
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Quantity (${part.unit})`} htmlFor="rc-qty" required><Input id="rc-qty" name="quantity" inputMode="decimal" required /></Field>
            {canCosts && <Field label="Unit cost ($)" htmlFor="rc-cost" hint="Optional"><Input id="rc-cost" name="unit_cost" inputMode="decimal" /></Field>}
          </div>
          <Field label="Note" htmlFor="rc-note" hint="Supplier, PO or invoice number"><Input id="rc-note" name="note" maxLength={300} /></Field>
          <Button type="submit" loading={pending}>Receive</Button>
        </form>
      </Dialog>
    </>
  );
}

export function CountButton({ part }: { part: PartLite }) {
  const [open, setOpen] = useState(false);
  const { pending, onSubmit, formError } = useAction(countPart, () => setOpen(false));
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Count ${part.name}`}>Count</Button>
      <Dialog open={open} onOpenChange={setOpen} title={`Count ${part.name}`} description={`Taviron shows ${part.on_hand} ${part.unit} on hand. Enter what is on the shelf.`} size="sm">
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <input type="hidden" name="id" value={part.id} />
          <FormError message={formError} />
          <Field label={`Counted (${part.unit})`} htmlFor="ct-qty" required><Input id="ct-qty" name="counted" inputMode="decimal" defaultValue={String(part.on_hand)} required /></Field>
          <Field label="Reason" htmlFor="ct-reason" required hint="e.g. monthly count, damaged, found"><Input id="ct-reason" name="reason" maxLength={300} required /></Field>
          <Button type="submit" loading={pending}>Record count</Button>
        </form>
      </Dialog>
    </>
  );
}

/** Use parts from stock on a work order (mechanics and the owner). */
export function UsePartForm({ workOrderId, parts }: { workOrderId: string; parts: PartLite[] }) {
  const [key, setKey] = useState(0);
  const { pending, onSubmit, formError } = useAction(usePart, () => setKey((k) => k + 1));
  const inStock = parts.filter((p) => p.on_hand > 0);
  if (!inStock.length) return <p className="text-sm text-muted">No parts in stock. Receive parts under Maintenance → Parts.</p>;
  return (
    <form key={key} onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end" noValidate aria-label="Use a part">
      <input type="hidden" name="work_order" value={workOrderId} />
      <div className="sm:col-span-3"><FormError message={formError} /></div>
      <Field label="Part" htmlFor="use-part">
        <Select id="use-part" name="part" defaultValue="">
          <option value="" disabled>Choose a part…</option>
          {inStock.map((p) => <option key={p.id} value={p.id}>{p.name}{p.part_number ? ` · ${p.part_number}` : ""} ({p.on_hand} {p.unit} on hand)</option>)}
        </Select>
      </Field>
      <Field label="Quantity" htmlFor="use-qty"><Input id="use-qty" name="quantity" inputMode="decimal" defaultValue="1" /></Field>
      <Button type="submit" variant="secondary" loading={pending}>Use part</Button>
    </form>
  );
}
