"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
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
import { addPartWait, cancelPartWait, partsIn, receivePartWait, setPartWaitDate, waitForPartsOnOrder, waitingParts, type WaitingPart } from "@/app/(app)/maintenance/part-wait-actions";
import { cn } from "@/lib/cn";
import { refreshAfterAction } from "@/lib/refresh-after-action";
import type { PartWait } from "@/server/data/parts";

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** The job's parts still on order, read when `open` turns on (null while reading). */
export function useWaitingParts(workOrderId: string, open: boolean): WaitingPart[] | null {
  const [parts, setParts] = useState<{ for: string; rows: WaitingPart[] } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    waitingParts(workOrderId).then((r) => { if (live) setParts({ for: workOrderId, rows: r.ok ? r.data : [] }); }).catch(() => { if (live) setParts({ for: workOrderId, rows: [] }); });
    return () => { live = false; setParts(null); };
  }, [workOrderId, open]);
  return parts && parts.for === workOrderId ? parts.rows : null;
}

const partName = (p: WaitingPart) => `${p.description}${p.quantity !== 1 ? ` × ${p.quantity}` : ""}`;

/**
 * "Waiting for parts" when parts are already on order (walkthrough P11): the job can wait for those, so the same part
 * is not entered a second time. Nothing shows when none is on order.
 */
export function AlreadyOnOrder({ workOrderId, editSeq = null, parts, onDone, big = true }: { workOrderId: string; editSeq?: number | null; parts: WaitingPart[]; onDone: () => void; big?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!parts.length) return null;
  return (
    <div className="space-y-2 rounded-2xl bg-card px-4 py-3 text-sm ring-1 ring-line/60" data-testid="already-on-order">
      <p className="font-semibold text-ink">Already on order for this job</p>
      <ul className="list-disc space-y-0.5 pl-5 text-ink">{parts.map((p) => <li key={p.id}>{partName(p)}</li>)}</ul>
      <Button type="button" variant="secondary" className={big ? "min-h-12" : "min-h-12 sm:min-h-0"} loading={pending} onClick={() => start(async () => {
        const r = await waitForPartsOnOrder({ workOrderId, editSeq });
        if (!r.ok) { toast.error(r.error); return; }
        toast.success(r.message ?? "Waiting for parts.");
        onDone();
        router.refresh();
      })}>
        Wait for {parts.length === 1 ? "this part" : "these parts"}
      </Button>
      <p className="text-muted">Or name another part that is missing below.</p>
    </div>
  );
}

/**
 * "Part is in" from the job's next step (walkthrough P11): the parts on order are listed with a tick each (all ticked),
 * received together, and the job starts again (My jobs) or goes back to the shop queue (the work order). With nothing
 * on order it does that straight away.
 */
export function PartsInButton({ workOrderId, editSeq, then, label, size = "lg", className, onOpenChange }: {
  workOrderId: string; editSeq: number; then: "start" | "queue"; label: string; size?: "sm" | "md" | "lg"; className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [unticked, setUnticked] = useState<string[]>([]);
  const parts = useWaitingParts(workOrderId, asking);
  // Done: said here until the page is read again (walkthrough P9), so the step is not offered twice.
  const [done, setDone] = useState(false);
  const run = (ids: string[]) => start(async () => {
    const r = await partsIn({ workOrderId, waitIds: ids, then, editSeq });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(r.message ?? "Saved.");
    setAsking(false);
    setDone(true);
    refreshAfterAction(router);
  });
  const show = (o: boolean) => { setAsking(o); setUnticked([]); onOpenChange?.(o); };
  // Nothing on order: no question to ask.
  useEffect(() => {
    if (asking && parts && parts.length === 0 && !pending) run([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once when the list arrives empty
  }, [asking, parts]);
  if (done) return <p role="status" className="text-sm font-semibold text-ink">{then === "start" ? "Parts in. The job has started again." : "Parts in. The job is back in the shop queue."}</p>;
  if (!asking || !parts || parts.length === 0) {
    return <Button size={size} className={className} loading={pending || (asking && !parts)} onClick={() => show(true)} icon={<PackageCheck className="size-4" aria-hidden />}>{label}</Button>;
  }
  const chosen = parts.filter((p) => !unticked.includes(p.id));
  return (
    <form aria-label="Which parts are in?" className="basis-full space-y-2 rounded-xl bg-surface p-3 ring-1 ring-line/60" onSubmit={(e) => { e.preventDefault(); run(chosen.map((p) => p.id)); }}>
      <p className="text-sm font-semibold text-ink">Which parts are in?</p>
      {parts.map((p) => (
        <label key={p.id} className="flex min-h-12 items-center gap-3 rounded-xl bg-card px-3 text-sm text-ink ring-1 ring-line/60">
          <input type="checkbox" className="size-5" checked={!unticked.includes(p.id)} onChange={(e) => setUnticked((u) => (e.target.checked ? u.filter((x) => x !== p.id) : [...u, p.id]))} />
          {partName(p)}
        </label>
      ))}
      <p className="text-xs text-muted">Ticked parts are marked received{then === "start" ? " and the job starts again" : " and the job goes back to the shop queue"}. Parts left unticked stay on order.</p>
      <div className={cn("flex flex-wrap gap-2")}>
        <Button type="submit" className="min-h-12" loading={pending}>{then === "start" ? "Received, start again" : "Received, back to the queue"}</Button>
        <Button type="button" variant="ghost" className="min-h-12" disabled={pending} onClick={() => show(false)}>Cancel</Button>
      </div>
    </form>
  );
}

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
  // One key per part: a retry of the same form is not saved twice, and the next part gets a new key (the dialog stays
  // mounted, so a key kept from the last part would make the database return that part instead of adding the new one).
  const [key, setKey] = useState(() => crypto.randomUUID());
  const { pending, onSubmit, fieldError, formError } = useFormAction(addPartWait.bind(null, workOrderId, setWaiting), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      setKey(crypto.randomUUID());
      setFormKey((k) => k + 1);
      onOpenChange(false);
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `wait-${name}`, name, ...describedBy(`wait-${name}`, fieldError(name)) });
  // Parts already on order are offered first (walkthrough P11), so the same part is not added twice.
  const onOrder = useWaitingParts(workOrderId, open && setWaiting);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm"
      title={setWaiting ? "Waiting for parts" : "Add a part on order"}
      description={setWaiting ? "The job pauses until the part is in. The part you name shows on the job card." : "Record a part ordered for this job."}>
      {setWaiting && onOrder && onOrder.length > 0 && (
        <div className="mb-3"><AlreadyOnOrder workOrderId={workOrderId} parts={onOrder} big={false} onDone={() => onOpenChange(false)} /></div>
      )}
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
        {setWaiting && (
          // A note with the status change (WK1): it shows in the job's Activity next to "Waiting for parts".
          <Field label="Note (optional)" htmlFor="wait-note" hint="For the shop: what is waiting, who ordered it.">
            <Textarea id="wait-note" name="note" rows={2} maxLength={2000} />
          </Field>
        )}
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
