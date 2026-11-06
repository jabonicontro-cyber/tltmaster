"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { addOrderCharge } from "@/app/(app)/billing/actions";

export interface ExtraChargeOption { id: string; name: string; unit: string }

/**
 * Extra charges after the work (MK2): lumper, truck ordered not used, layover and other charges billed per occurrence.
 * Only charges marked "not billed from delivery tickets" in Rates and pricing are offered; the line goes out with the
 * order's invoice.
 */
export function ExtraChargeForm({ orderId, options }: { orderId: string; options: ExtraChargeOption[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [item, setItem] = useState(options[0]?.id ?? "");
  const [quantity, setQuantity] = useState("1");
  const [rate, setRate] = useState("");
  const [note, setNote] = useState("");
  const unit = options.find((o) => o.id === item)?.unit ?? "";
  return (
    <Card>
      <CardHeader title="Add a charge" description="Charges billed per occurrence, such as lumper or truck ordered not used. Added before the billing handoff; recorded in the history." />
      <CardBody>
        <form
          aria-label="Add a charge"
          className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await addOrderCharge({ orderId, chargeItemId: item, quantity, rate, note });
              if (!r.ok) return void toast.error(r.error ?? "Not added.");
              toast.success(r.message ?? "Added.");
              setRate("");
              setNote("");
              router.refresh();
            });
          }}
        >
          <Field label="Charge" htmlFor="xc-item" className="sm:col-span-4">
            <Select id="xc-item" value={item} onChange={(e) => setItem(e.target.value)}>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          <Field label={unit ? `Quantity (${unit})` : "Quantity"} htmlFor="xc-qty" className="sm:col-span-2">
            <Input id="xc-qty" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="text-right tabular" />
          </Field>
          <Field label="Rate ($)" htmlFor="xc-rate" className="sm:col-span-2">
            <Input id="xc-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 85" className="text-right tabular" />
          </Field>
          <Field label="Note (on the invoice)" htmlFor="xc-note" className="sm:col-span-3">
            <Input id="xc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Receiver unload fee" />
          </Field>
          <div className="sm:col-span-1"><Button type="submit" disabled={busy || !item || !rate}>Add</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}
