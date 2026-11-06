"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { formatCents } from "@/lib/money";
import { setCustomerDetention } from "@/app/(app)/customers/actions";

/**
 * Detention (DT1): off until set for the customer. When a recorded wait (Arrived to Left) passes the free time, billing
 * sees a proposed charge on the order and decides; nothing is added by itself.
 */
export function DetentionPanel({ customerId, freeMinutes, rateCents, canEdit }: { customerId: string; freeMinutes: number | null; rateCents: number | null; canEdit: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [free, setFree] = useState(freeMinutes === null ? "" : String(freeMinutes));
  const [rate, setRate] = useState(rateCents === null ? "" : (rateCents / 100).toFixed(2));
  const on = freeMinutes !== null && rateCents !== null;
  const save = (f: string, r: string) => start(async () => {
    const res = await setCustomerDetention(customerId, f, r);
    if (!res.ok) return void toast.error(res.error ?? "Not saved.");
    toast.success(res.message ?? "Saved.");
    router.refresh();
  });
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2">Detention{on ? <Badge tone="blue">On</Badge> : <Badge tone="gray">Off</Badge>}</span>}
        description={on
          ? `After ${freeMinutes} min at a stop, waiting is billed at ${formatCents(rateCents!)} per hour. Billing reviews each proposal before it is added to the order.`
          : "Off for this customer. Set the free time and hourly rate to see detention proposals from drivers' Arrived and Left times."}
      />
      {canEdit && (
        <CardBody>
          <form
            className="flex flex-wrap items-end gap-3"
            aria-label="Detention for this customer"
            onSubmit={(e) => { e.preventDefault(); save(free, rate); }}
          >
            <Field label="Free time (minutes)" htmlFor="det-free" className="w-40">
              <Input id="det-free" inputMode="numeric" value={free} onChange={(e) => setFree(e.target.value)} placeholder="e.g. 120" className="text-right tabular" />
            </Field>
            <Field label="Rate per hour ($)" htmlFor="det-rate" className="w-40">
              <Input id="det-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 75" className="text-right tabular" />
            </Field>
            <Button type="submit" variant="secondary" disabled={busy}>Save</Button>
            {on && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setFree(""); setRate(""); save("", ""); }}>Turn off</Button>}
          </form>
        </CardBody>
      )}
    </Card>
  );
}
