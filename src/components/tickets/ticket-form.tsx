"use client";

import Link from "next/link";
import { DateInput } from "@/components/ui/date-input";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import { trimNumber } from "@/lib/fleet/labels";
import { quantityError, unitRequiresWhole } from "@/lib/tickets/rules";
import type { UnitRow } from "@/server/data/types";
import { correctTicket, submitTicket, type TicketInput } from "@/app/(app)/tickets/actions";

export interface TicketFormValues {
  orderLineId: string;
  deliveredDate: string;
  deliveredTime: string;
  quantity: string;
  unitCode: string;
  externalReference: string;
  notes: string;
  truckId: string;
  trailerId: string;
  driverId: string;
}

interface Props {
  mode: "new" | "correct";
  /** Ticket being corrected (mode "correct"). */
  ticketId?: string;
  loadId: string;
  orderId: string;
  initial: TicketFormValues;
  lines: Array<{ id: string; description: string; quantity: number | string | null; unit_code: string | null; kind: string }>;
  units: UnitRow[];
  trucks: Array<{ id: string; unit_number: string; active: boolean }>;
  trailers: Array<{ id: string; unit_number: string; active: boolean }>;
  drivers: Array<{ id: string; display_name: string; active: boolean }>;
  /** Assignment at the time of the form, for the "differs" hint. */
  assignment: { truckId: string; trailerId: string; driverId: string } | null;
  cancelHref: string;
}

export function TicketForm({ mode, ticketId, loadId, orderId, initial, lines, units, trucks, trailers, drivers, assignment, cancelHref }: Props) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [reason, setReason] = useState("");
  // One key per form: a double click or retry returns the same ticket.
  const [submissionKey] = useState(() => (mode === "new" ? crypto.randomUUID() : null));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const set = (k: keyof TicketFormValues) => (e: { target: { value: string } }) => {
    setV((x) => ({ ...x, [k]: e.target.value }));
    if (k === "externalReference") {
      setConfirmMessage(null);
      setConfirmed(false);
    }
  };

  const line = lines.find((l) => l.id === v.orderLineId);
  const unitLabel = (code: string | null | undefined) => units.find((u) => u.code === code)?.label ?? code ?? "";
  const qError = v.quantity ? quantityError(v.quantity, v.unitCode || null) : null;
  const differs = assignment && (assignment.truckId !== v.truckId || assignment.trailerId !== v.trailerId || assignment.driverId !== v.driverId);

  async function submit() {
    setPending(true);
    setError(null);
    setFieldErrors({});
    const input: TicketInput & { orderId: string } = {
      loadId,
      orderId,
      orderLineId: v.orderLineId,
      deliveredDate: v.deliveredDate,
      deliveredTime: v.deliveredTime,
      quantity: v.quantity,
      unitCode: v.unitCode,
      externalReference: v.externalReference,
      notes: v.notes,
      truckId: v.truckId,
      trailerId: v.trailerId || null,
      driverId: v.driverId,
      submissionKey,
      confirmDuplicate: confirmed,
    };
    const r = mode === "new" ? await submitTicket(input) : await correctTicket(ticketId!, { ...input, reason });
    setPending(false);
    if (!r.ok) {
      if ("needsConfirmation" in r) {
        setConfirmMessage(r.error);
        return;
      }
      setError(r.error);
      setFieldErrors(r.fieldErrors ?? {});
      return;
    }
    toast.success(r.message ?? "Saved");
    router.push(`/tickets/${r.data.ticketId}`);
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />
      <Card>
        <CardHeader title="What was delivered" description="Enter the figures from the paper or scale ticket. Nothing is filled in from the plan." />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-6">
          <Field label="Order line" htmlFor="t-line" required error={fieldErrors.orderLineId} className="sm:col-span-6">
            <Select id="t-line" value={v.orderLineId} onChange={set("orderLineId")}>
              <option value="">Choose the material or hauling line…</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.description}
                  {l.quantity !== null ? ` — ordered ${trimNumber(l.quantity)} ${unitLabel(l.unit_code).toLowerCase()}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Delivered quantity" htmlFor="t-qty" required error={fieldErrors.quantity ?? qError ?? undefined} className="sm:col-span-2">
            <Input id="t-qty" inputMode="decimal" className="text-right tabular" value={v.quantity} onChange={set("quantity")} autoComplete="off" />
          </Field>
          <Field
            label="Unit"
            htmlFor="t-unit"
            required
            error={fieldErrors.unitCode}
            className="sm:col-span-2"
            hint={line?.unit_code ? `Order line is in ${unitLabel(line.unit_code).toLowerCase()}` : undefined}
          >
            <Select id="t-unit" value={v.unitCode} onChange={set("unitCode")}>
              <option value="">Choose…</option>
              {units.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.label}
                  {unitRequiresWhole(u.code) ? " (whole numbers)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2" />
          {line?.unit_code && v.unitCode && v.unitCode !== line.unit_code && (
            <div className="sm:col-span-6">
              <Notice tone="warning" title="Different unit">
                The order line is in {unitLabel(line.unit_code).toLowerCase()}; this ticket is in {unitLabel(v.unitCode).toLowerCase()}. No conversion is made — the ticket will be
                flagged for office review.
              </Notice>
            </div>
          )}
          <Field label="Delivery date" htmlFor="t-date" required error={fieldErrors.deliveredDate} className="sm:col-span-2">
            <DateInput id="t-date" value={v.deliveredDate} onChange={set("deliveredDate")} />
          </Field>
          <Field label="Delivery time" htmlFor="t-time" required error={fieldErrors.deliveredTime} className="sm:col-span-2">
            <Input id="t-time" type="time" value={v.deliveredTime} onChange={set("deliveredTime")} />
          </Field>
          <Field label="Paper / scale ticket #" htmlFor="t-ref" error={fieldErrors.externalReference} className="sm:col-span-2" hint="Leave blank only if there is none — it will be flagged.">
            <Input id="t-ref" maxLength={60} value={v.externalReference} onChange={set("externalReference")} autoComplete="off" />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Truck and driver" description="From the dispatch assignment. Change only if the paper ticket shows a different truck or driver." />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Truck" htmlFor="t-truck" required error={fieldErrors.truckId}>
            <Select id="t-truck" value={v.truckId} onChange={set("truckId")}>
              <option value="">Choose…</option>
              {trucks.map((t) => (
                <option key={t.id} value={t.id}>{t.unit_number}{t.active ? "" : " (inactive)"}</option>
              ))}
            </Select>
          </Field>
          <Field label="Trailer" htmlFor="t-trailer">
            <Select id="t-trailer" value={v.trailerId} onChange={set("trailerId")}>
              <option value="">No trailer</option>
              {trailers.map((t) => (
                <option key={t.id} value={t.id}>{t.unit_number}{t.active ? "" : " (inactive)"}</option>
              ))}
            </Select>
          </Field>
          <Field label="Driver" htmlFor="t-driver" required error={fieldErrors.driverId}>
            <Select id="t-driver" value={v.driverId} onChange={set("driverId")}>
              <option value="">Choose…</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>{d.display_name}{d.active ? "" : " (inactive)"}</option>
              ))}
            </Select>
          </Field>
          {differs && <p className="text-sm text-amber-900 sm:col-span-3">Differs from the dispatch assignment — the ticket will be flagged for review.</p>}
          <Field label="Notes" htmlFor="t-notes" error={fieldErrors.notes} className="sm:col-span-3">
            <Textarea id="t-notes" rows={2} maxLength={2000} value={v.notes} onChange={set("notes")} />
          </Field>
        </CardBody>
      </Card>

      {mode === "correct" && (
        <Card>
          <CardBody>
            <Field label="Reason for the correction" htmlFor="t-reason" required error={fieldErrors.reason} hint="Kept in the ticket history. The current revision stays on record.">
              <Input id="t-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Scale ticket reads 21.74, not 21.47" />
            </Field>
          </CardBody>
        </Card>
      )}

      {confirmMessage && (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
          <p className="flex items-start gap-2 font-semibold">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {confirmMessage}
          </p>
          <Checkbox className="mt-2" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} label="Yes, this is a separate delivery — record it (it will be flagged for review)" />
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Link href={cancelHref} className={buttonClasses("ghost")}>Cancel</Link>
        <Button onClick={submit} loading={pending} disabled={Boolean(confirmMessage && !confirmed)}>
          {mode === "new" ? "Submit ticket" : "Save correction"}
        </Button>
      </div>
    </div>
  );
}
