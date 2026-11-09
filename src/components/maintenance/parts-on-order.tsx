"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PackageCheck, PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { formatDateTime } from "@/lib/dates";
import { expectedText } from "@/lib/maintenance/parts-waiting";
import { addPartWait, cancelPartWait, receivePartWait, setPartWaitDate } from "@/app/(app)/maintenance/part-wait-actions";
import type { PartWait } from "@/server/data/parts";

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * "Waiting for parts" with what is on order (20261120012300): the part, how many, vendor, PO number, expected date and,
 * for people who see costs, the price. With setWaiting the job also moves to Waiting for parts. Big targets for a
 * phone; only the part is required.
 */
export function PartOnOrderDialog({ workOrderId, open, onOpenChange, setWaiting, canCosts }: {
  workOrderId: string; open: boolean; onOpenChange: (o: boolean) => void; setWaiting: boolean; canCosts: boolean;
}) {
  const router = useRouter();
  const [formKey, setFormKey] = useState(0);
  const [key] = useState(() => crypto.randomUUID());
  const { pending, onSubmit, fieldError, formError } = useFormAction(addPartWait.bind(null, workOrderId, setWaiting), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      setFormKey((k) => k + 1);
      onOpenChange(false);
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `wait-${name}`, name, ...describedBy(`wait-${name}`, fieldError(name)) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm"
      title={setWaiting ? "Waiting for parts" : "Add a part on order"}
      description={setWaiting ? "The job pauses until the part is in. The part you name shows on the job card." : "Record a part ordered for this job."}>
      <form key={formKey} onSubmit={onSubmit} className="space-y-3" noValidate>
        <input type="hidden" name="submission_key" value={key} />
        <Field label="Which part?" htmlFor="wait-description" required error={fieldError("description")}>
          <Input {...f("description")} maxLength={160} placeholder="For example: DEF level sensor" className="min-h-12 sm:min-h-0" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="How many" htmlFor="wait-quantity" error={fieldError("quantity")}>
            <Input {...f("quantity")} inputMode="decimal" defaultValue="1" className="min-h-12 sm:min-h-0" />
          </Field>
          <Field label="Expected" htmlFor="wait-expected_on" error={fieldError("expected_on")}>
            <DateInput {...f("expected_on")} className="min-h-12 sm:min-h-0" />
          </Field>
        </div>
        <details className="rounded-2xl bg-surface px-4 py-2 text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center font-medium text-ink">Vendor, PO number{canCosts ? " and price" : ""} (optional)</summary>
          <div className="space-y-3 pt-2 pb-2">
            <Field label="Vendor" htmlFor="wait-vendor_name" error={fieldError("vendor_name")}>
              <Input {...f("vendor_name")} maxLength={120} className="min-h-12 sm:min-h-0" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="PO number" htmlFor="wait-po_number" error={fieldError("po_number")}>
                <Input {...f("po_number")} maxLength={60} className="min-h-12 sm:min-h-0" />
              </Field>
              <Field label="Part number" htmlFor="wait-part_number" error={fieldError("part_number")}>
                <Input {...f("part_number")} maxLength={60} className="min-h-12 sm:min-h-0" />
              </Field>
            </div>
            {canCosts && (
              <Field label="Price each ($)" htmlFor="wait-unit_cost" error={fieldError("unit_cost")} hint="Added to the job's costs when the part is in.">
                <Input {...f("unit_cost")} inputMode="decimal" placeholder="0.00" className="min-h-12 sm:min-h-0" />
              </Field>
            )}
          </div>
        </details>
        <FormError message={formError} />
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" className="min-h-12 sm:min-h-0" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button type="submit" className="min-h-12 sm:min-h-0" loading={pending}>{setWaiting ? "Mark waiting for parts" : "Save part on order"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The work order's parts on order: what, from whom, when; received offers to put the job back in the queue. */
export function PartsOnOrder({ workOrderId, rows, status, today, timezone, canManage, canCosts, who }: {
  workOrderId: string; rows: PartWait[]; status: string; today: string; timezone: string; canManage: boolean; canCosts: boolean;
  who: Record<string, string>;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState<PartWait | null>(null);
  const [toQueue, setToQueue] = useState(true);
  const [canceling, setCanceling] = useState<PartWait | null>(null);
  const [reason, setReason] = useState("");
  const [moving, setMoving] = useState<PartWait | null>(null);
  const [date, setDate] = useState("");
  const open = !["completed", "closed", "canceled", "awaiting_inspection"].includes(status);
  const waiting = rows.filter((r) => r.status === "waiting");
  const lastWaiting = waiting.length === 1;
  const done = (r: { ok: boolean; error?: string; message?: string }) => {
    if (!r.ok) return r.error ?? "Something went wrong.";
    toast.success(r.message ?? "Saved.");
    router.refresh();
  };

  return (
    <div className="space-y-3">
      {rows.length === 0 ? <p className="text-sm text-muted">No parts on order for this job.</p> : (
        <ul className="divide-y divide-line rounded-2xl ring-1 ring-line/60" aria-label="Parts on order">
          {rows.map((r) => {
            const exp = expectedText(r.expected_on, today);
            return (
              <li key={r.id} className="space-y-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-semibold text-ink">{r.description}</span>
                  {r.quantity !== 1 && <span className="tabular text-muted">× {r.quantity}</span>}
                  {r.status === "waiting"
                    ? <Badge tone={exp.late ? "amber" : "gray"}>{exp.text}</Badge>
                    : r.status === "received" ? <Badge tone="green">Received</Badge> : <Badge tone="gray">No longer on order</Badge>}
                </div>
                <p className="text-muted">
                  {[r.vendor_name && `From ${r.vendor_name}`, r.po_number && `PO ${r.po_number}`, r.part_number && `Part number ${r.part_number}`,
                    canCosts && r.unit_cost_cents !== null && `${money(r.unit_cost_cents)} each`].filter(Boolean).join(" · ") || "No vendor or PO number recorded."}
                </p>
                {r.status === "received" && r.received_at && <p className="text-xs text-muted">Received by {r.received_by ? who[r.received_by] ?? "a former member" : "–"} · {formatDateTime(r.received_at, timezone)}</p>}
                {r.status === "canceled" && r.cancel_reason && <p className="text-xs text-muted">Why: {r.cancel_reason}</p>}
                {canManage && open && r.status === "waiting" && (
                  <div className="flex flex-wrap gap-2">
                    <Button className="min-h-12 sm:min-h-0" icon={<PackageCheck className="size-4" />} onClick={() => { setToQueue(status === "awaiting_parts"); setReceiving(r); }}>Part is in</Button>
                    <Button variant="secondary" className="min-h-12 sm:min-h-0" onClick={() => { setDate(r.expected_on ?? ""); setMoving(r); }}>Change expected date</Button>
                    <Button variant="ghost" className="min-h-12 text-muted sm:min-h-0" onClick={() => { setReason(""); setCanceling(r); }}>No longer on order</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canManage && open && (
        <Button variant="secondary" className="min-h-12 sm:min-h-0" icon={<PackagePlus className="size-4" />} onClick={() => setAdding(true)}>Add a part on order</Button>
      )}
      <PartOnOrderDialog workOrderId={workOrderId} open={adding} onOpenChange={setAdding} setWaiting={false} canCosts={canCosts} />
      <ConfirmDialog open={Boolean(receiving)} onOpenChange={(o) => !o && setReceiving(null)} title="The part is in"
        description={receiving?.part_id ? "It is recorded in the parts stock and used on this job." : "It is recorded on this job."}
        confirmLabel="Mark received"
        onConfirm={async () => receiving ? done(await receivePartWait({ id: receiving.id, workOrderId, toQueue: toQueue && lastWaiting })) : null}>
        {status === "awaiting_parts" && lastWaiting && (
          <label className="flex min-h-12 items-center gap-3 rounded-2xl bg-surface px-4 py-2 text-sm text-ink">
            <input type="checkbox" className="size-5" checked={toQueue} onChange={(e) => setToQueue(e.target.checked)} />
            Put the job back in the shop queue
          </label>
        )}
        {status === "awaiting_parts" && !lastWaiting && <p className="text-sm text-muted">Other parts are still on order, so the job keeps waiting.</p>}
      </ConfirmDialog>
      <ConfirmDialog open={Boolean(moving)} onOpenChange={(o) => !o && setMoving(null)} title="Change the expected date" confirmLabel="Save date"
        onConfirm={async () => moving ? done(await setPartWaitDate({ id: moving.id, workOrderId, expectedOn: date })) : null}>
        <Field label="Expected" htmlFor="wait-move-date" hint="Leave empty when the vendor has not said.">
          <DateInput id="wait-move-date" value={date} onChange={(e) => setDate(e.target.value)} className="min-h-12 sm:min-h-0" />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog open={Boolean(canceling)} onOpenChange={(o) => !o && setCanceling(null)} title="No longer on order" confirmLabel="Save" tone="danger"
        onConfirm={async () => {
          if (!canceling) return null;
          if (reason.trim().length < 2) return "Say why the part is no longer on order.";
          return done(await cancelPartWait({ id: canceling.id, workOrderId, reason }));
        }}>
        <Field label="Why?" htmlFor="wait-cancel-reason" required>
          <Textarea id="wait-cancel-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
