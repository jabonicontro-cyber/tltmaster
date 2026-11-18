"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { PhotoPicker, uploadPhotos } from "@/components/ui/photo-picker";
import { toJpeg } from "@/lib/files/to-jpeg";
import { trimNumber } from "@/lib/fleet/labels";
import { centsToInput } from "@/lib/money";
import { quantityError, unitRequiresWhole } from "@/lib/tickets/rules";
import { submitTicketWithoutDispatch, createTicketJob, ticketJobPrice } from "@/app/(app)/tickets/job-actions";
import type { TicketEntryWithoutDispatch, TicketJob } from "@/server/data/ticket-jobs";
import { adaptWording } from "@/lib/industry";

/**
 * Enter a delivery ticket without dispatch (MOD1 (2), docs/MODULES.md §5): customer → job (or a new job in one step)
 * → what the paper ticket says → optional truck and driver → photo. The database checks everything again and records
 * the delivery with the ticket; billing prices it from the job.
 */
export function TicketJobForm({ data, canCreateJob, canGoAheadForJob = false, initialCustomerId = "", industry }: { data: TicketEntryWithoutDispatch; canCreateJob: boolean; /** May create a job for a customer on credit hold, with a reason (orders.edit, as for a new order). */ canGoAheadForJob?: boolean; initialCustomerId?: string; /** A freight carrier reads "BOL" and "commodity" (T3). */ industry?: string }) {
  const router = useRouter();
  const say = (text: string) => adaptWording(text, industry);
  const [jobs, setJobs] = useState<TicketJob[]>(data.jobs);
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const customerJobs = useMemo(() => jobs.filter((j) => j.customer_id === customerId), [jobs, customerId]);
  const [orderId, setOrderId] = useState("");
  const job = jobs.find((j) => j.id === orderId) ?? null;
  const [lineId, setLineId] = useState("");
  const [v, setV] = useState({ deliveredDate: data.today, deliveredTime: "", quantity: "", unitCode: "", externalReference: "", notes: "", truckId: "", trailerId: "", driverId: "" });
  const [photos, setPhotos] = useState<File[]>([]);
  const [submissionKey] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [newJob, setNewJob] = useState<null | { siteLabel: string; materialId: string; unitCode: string; price: string; priceNote: string; quantity: string }>(null);
  const [jobPending, setJobPending] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);
  // Credit hold (B128): known when the page loaded, or reported by the server when it was put on hold since.
  const [heldSince, setHeldSince] = useState<Record<string, string>>({});
  const [creditReason, setCreditReason] = useState("");
  const hold = customerId ? (data.creditHolds[customerId] ?? heldSince[customerId] ?? null) : null;
  const reasonMissing = Boolean(hold) && creditReason.trim().length < 3;

  const unitLabel = (code: string | null | undefined) => data.units.find((u) => u.code === code)?.label ?? code ?? "";
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setV((x) => ({ ...x, [k]: value }));
    if (k === "externalReference") { setConfirmMessage(null); setConfirmed(false); }
  };
  const chooseJob = (id: string) => {
    setOrderId(id);
    const j = jobs.find((x) => x.id === id);
    const only = j && j.lines.length === 1 ? j.lines[0] : null;
    setLineId(only?.id ?? "");
    if (only?.unit_code) setV((x) => ({ ...x, unitCode: only.unit_code! }));
  };
  const chooseLine = (id: string) => {
    setLineId(id);
    const l = job?.lines.find((x) => x.id === id);
    if (l?.unit_code) setV((x) => ({ ...x, unitCode: l.unit_code! }));
  };
  const line = job?.lines.find((l) => l.id === lineId) ?? null;
  const qError = v.quantity ? quantityError(v.quantity, v.unitCode || null) : null;

  async function lookUpPrice(materialId: string, unitCode: string) {
    if (!customerId || !materialId || !unitCode) return;
    const r = await ticketJobPrice(customerId, materialId, unitCode, v.deliveredDate || data.today);
    setNewJob((x) => {
      if (!x || x.materialId !== materialId) return x;
      if (r.ok && r.data.cents !== null) return { ...x, price: centsToInput(r.data.cents), priceNote: r.data.source === "customer" ? "From this customer's price list." : "From your standard price list." };
      return { ...x, priceNote: "No price on file for this customer: enter the agreed price." };
    });
  }

  async function saveJob() {
    if (!newJob) return;
    const customer = data.customers.find((c) => c.id === customerId);
    const material = data.materials.find((m) => m.id === newJob.materialId);
    setJobError(null);
    if (!customer) return setJobError("Choose the customer first.");
    if (!material) return setJobError("Choose the material.");
    setJobPending(true);
    const r = await createTicketJob({
      customerId,
      siteLabel: newJob.siteLabel,
      materialId: material.id,
      description: material.name,
      unitCode: newJob.unitCode,
      price: newJob.price,
      quantity: newJob.quantity || v.quantity,
      taxable: material.taxable_default,
      taxRateBp: customer.tax_exempt ? 0 : data.defaultTaxRateBp,
      deliveredDate: v.deliveredDate,
      creditReason: hold ? creditReason : undefined,
    });
    setJobPending(false);
    if (!r.ok) {
      if (r.fieldErrors?.creditReason) {
        setHeldSince((h) => ({ ...h, [customerId]: r.fieldErrors!.creditReason }));
        return setJobError("This customer is on credit hold: give the reason for going ahead above, then create the job.");
      }
      return setJobError(r.error);
    }
    const created: TicketJob = {
      id: r.data.orderId, order_number: r.data.orderNumber, customer_id: customerId, customer_name: customer.name, label: newJob.siteLabel, status: "in_progress",
      lines: [{ id: r.data.orderLineId, description: material.name, unit_code: newJob.unitCode, quantity: newJob.quantity || v.quantity }],
    };
    setJobs((js) => [created, ...js]);
    setOrderId(created.id);
    setLineId(r.data.orderLineId);
    setV((x) => ({ ...x, unitCode: newJob.unitCode }));
    setNewJob(null);
    toast.success(r.message ?? "Job created.");
  }

  async function submit() {
    setPending(true);
    setError(null);
    setFieldErrors({});
    const r = await submitTicketWithoutDispatch({
      orderId, orderLineId: lineId, deliveredDate: v.deliveredDate, deliveredTime: v.deliveredTime, quantity: v.quantity, unitCode: v.unitCode,
      externalReference: v.externalReference, notes: v.notes, truckId: v.truckId || null, trailerId: v.trailerId || null, driverId: v.driverId || null,
      submissionKey, confirmDuplicate: confirmed, creditReason: hold ? creditReason : undefined,
    });
    if (!r.ok) {
      setPending(false);
      if ("needsConfirmation" in r) return setConfirmMessage(r.error);
      if (r.fieldErrors?.creditReason) {
        setHeldSince((h) => ({ ...h, [customerId]: r.fieldErrors!.creditReason }));
        return setError("This customer is on credit hold: give the reason for going ahead, then submit again.");
      }
      setError(r.error);
      setFieldErrors(r.fieldErrors ?? {});
      return;
    }
    let photo = "";
    if (photos.length) {
      let failed = 0;
      for (const file of photos) {
        let blob: Blob;
        try {
          blob = await toJpeg(file);
        } catch {
          failed++;
          continue;
        }
        failed += await uploadPhotos(`/tickets/${r.data.ticketId}/scans`, { upload_key: crypto.randomUUID() }, [new File([blob], "ticket.jpg", { type: blob.type })]);
      }
      photo = failed ? `&photo=failed&failed=${failed}` : `&photo=attached&count=${photos.length}`;
    }
    router.push(`/tickets/${r.data.ticketId}?saved=submitted${photo}`);
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />
      <Card>
        <CardHeader title="Customer and job" description="The job holds the material and the agreed price. Billing prices the ticket from it." />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Customer" htmlFor="j-customer" required>
            <Select id="j-customer" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setOrderId(""); setLineId(""); setNewJob(null); }}>
              <option value="">Choose the customer…</option>
              {data.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Job" htmlFor="j-job" required error={fieldErrors.orderId} hint={customerId && !customerJobs.length ? "No open job for this customer yet." : undefined}>
            <Select id="j-job" value={orderId} onChange={(e) => chooseJob(e.target.value)} disabled={!customerId}>
              <option value="">{customerId ? "Choose the job…" : "Choose the customer first"}</option>
              {customerJobs.map((j) => <option key={j.id} value={j.id}>{j.order_number}{j.label ? ` · ${j.label}` : ""}</option>)}
            </Select>
          </Field>
          {hold && (
            <div role="alert" className="space-y-2 rounded-xl border border-critical/40 bg-critical/5 p-3 sm:col-span-2">
              <p className="text-sm font-semibold text-critical">{hold}</p>
              <p className="text-sm text-ink">
                Billing decides on credit holds and can release this one on the customer&apos;s page. To enter this ticket now anyway, give a reason; it is recorded with the ticket{canCreateJob && canGoAheadForJob ? " (and with the job if you create a new one)" : ""}.
              </p>
              <Field label="Reason for going ahead" htmlFor="j-credit-reason" required hint="At least 3 characters.">
                <Input id="j-credit-reason" value={creditReason} maxLength={500} onChange={(e) => setCreditReason(e.target.value)} placeholder="e.g. Owner approved; payment promised Friday" />
              </Field>
            </div>
          )}
          {customerId && canCreateJob && !newJob && (
            <div className="sm:col-span-2">
              <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setNewJob({ siteLabel: "", materialId: "", unitCode: "", price: "", priceNote: "", quantity: "" })}>
                <Plus className="size-4" aria-hidden /> New job for this customer
              </button>
            </div>
          )}
          {newJob && (
            <div className="space-y-4 rounded-xl border border-line p-4 sm:col-span-2" role="group" aria-label="New job">
              <p className="text-sm font-semibold text-ink">New job</p>
              <FormError message={jobError} />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Job or site name" htmlFor="nj-site" required hint="Where it delivers, as people call it.">
                  <Input id="nj-site" maxLength={200} value={newJob.siteLabel} onChange={(e) => setNewJob({ ...newJob, siteLabel: e.target.value })} placeholder="e.g. Miller driveway, 14 Elm St" />
                </Field>
                <Field label={say("Material")} htmlFor="nj-material" required>
                  <Select id="nj-material" value={newJob.materialId} onChange={(e) => {
                    const m = data.materials.find((x) => x.id === e.target.value);
                    const unit = m?.default_unit_code && data.units.some((u) => u.code === m.default_unit_code) ? m.default_unit_code : newJob.unitCode;
                    setNewJob({ ...newJob, materialId: e.target.value, unitCode: unit, price: "", priceNote: "" });
                    if (m) void lookUpPrice(m.id, unit);
                  }}>
                    <option value="">Choose…</option>
                    {data.materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Select>
                </Field>
                <Field label="Unit" htmlFor="nj-unit" required>
                  <Select id="nj-unit" value={newJob.unitCode} onChange={(e) => { setNewJob({ ...newJob, unitCode: e.target.value, price: "", priceNote: "" }); void lookUpPrice(newJob.materialId, e.target.value); }}>
                    <option value="">Choose…</option>
                    {data.units.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
                  </Select>
                </Field>
                <Field label={`Agreed price${newJob.unitCode ? ` per ${unitLabel(newJob.unitCode).toLowerCase()}` : ""}`} htmlFor="nj-price" required hint={newJob.priceNote || "A price other than the price list is checked by someone who may set prices."}>
                  <Input id="nj-price" inputMode="decimal" className="text-right tabular" value={newJob.price} onChange={(e) => setNewJob({ ...newJob, price: e.target.value })} />
                </Field>
                <Field label="Expected quantity for the job" htmlFor="nj-qty" required hint="Leave it as this ticket's quantity if you don't know yet.">
                  <Input id="nj-qty" inputMode="decimal" className="text-right tabular" value={newJob.quantity || v.quantity} onChange={(e) => setNewJob({ ...newJob, quantity: e.target.value })} />
                </Field>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveJob} loading={jobPending} disabled={canGoAheadForJob && reasonMissing}>Create job</Button>
                <Button size="sm" variant="ghost" onClick={() => { setNewJob(null); setJobError(null); }}>Cancel</Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={say("What the ticket says")} description={say("Copy the figures from the paper or scale ticket.")} />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-6">
          {job && job.lines.length > 1 && (
            <Field label={say("Material")} htmlFor="t-line" required error={fieldErrors.orderLineId} className="sm:col-span-6">
              <Select id="t-line" value={lineId} onChange={(e) => chooseLine(e.target.value)}>
                <option value="">Choose what was delivered…</option>
                {job.lines.map((l) => <option key={l.id} value={l.id}>{l.description}{l.quantity !== null ? `, job ${trimNumber(l.quantity)} ${unitLabel(l.unit_code).toLowerCase()}` : ""}</option>)}
              </Select>
            </Field>
          )}
          {job && job.lines.length === 1 && <p className="text-sm text-muted sm:col-span-6">Material: <span className="font-medium text-ink">{job.lines[0].description}</span></p>}
          <Field label={say("Ticket number")} htmlFor="t-ref" required={data.referenceRequired} error={fieldErrors.externalReference} className="sm:col-span-2" hint={data.referenceRequired ? say("The number printed on the paper ticket.") : undefined}>
            <Input id="t-ref" maxLength={60} value={v.externalReference} onChange={set("externalReference")} autoComplete="off" />
          </Field>
          <Field label="Delivery date" htmlFor="t-date" required error={fieldErrors.deliveredDate} className="sm:col-span-2">
            <DateInput id="t-date" value={v.deliveredDate} onChange={set("deliveredDate")} />
          </Field>
          <Field label="Time (optional)" htmlFor="t-time" error={fieldErrors.deliveredTime} className="sm:col-span-2" hint={say("Only if the ticket shows one.")}>
            <Input id="t-time" type="time" value={v.deliveredTime} onChange={set("deliveredTime")} />
          </Field>
          <Field label="Quantity" htmlFor="t-qty" required error={fieldErrors.quantity ?? qError ?? undefined} className="sm:col-span-2">
            <Input id="t-qty" inputMode="decimal" className="text-right tabular" value={v.quantity} onChange={set("quantity")} autoComplete="off" />
          </Field>
          <Field label="Unit" htmlFor="t-unit" required error={fieldErrors.unitCode} className="sm:col-span-2" hint={line?.unit_code ? `The job is in ${unitLabel(line.unit_code).toLowerCase()}` : undefined}>
            <Select id="t-unit" value={v.unitCode} onChange={set("unitCode")}>
              <option value="">Choose…</option>
              {data.units.map((u) => <option key={u.code} value={u.code}>{u.label}{unitRequiresWhole(u.code) ? " (whole numbers)" : ""}</option>)}
            </Select>
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Truck and driver (optional)" description={say("Pick them if the ticket shows them. Driver pay counts only tickets that name a driver.")} />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Truck" htmlFor="t-truck">
            <Select id="t-truck" value={v.truckId} onChange={set("truckId")}>
              <option value="">Not recorded</option>
              {data.trucks.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}
            </Select>
          </Field>
          <Field label="Trailer" htmlFor="t-trailer">
            <Select id="t-trailer" value={v.trailerId} onChange={set("trailerId")}>
              <option value="">Not recorded</option>
              {data.trailers.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}
            </Select>
          </Field>
          <Field label="Driver" htmlFor="t-driver">
            <Select id="t-driver" value={v.driverId} onChange={set("driverId")}>
              <option value="">Not recorded</option>
              {data.drivers.map((d) => <option key={d.id} value={d.id}>{d.display_name}</option>)}
            </Select>
          </Field>
          <Field label="Notes" htmlFor="t-notes" className="sm:col-span-3">
            <Textarea id="t-notes" rows={2} maxLength={2000} value={v.notes} onChange={set("notes")} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <PhotoPicker
            id="t-photos"
            label={say("Photo of the paper ticket")}
            files={photos}
            onChange={setPhotos}
            max={4}
            accept="image/jpeg,image/png,image/webp,image/heic"
            empty={say("Take or choose a photo of the paper ticket")}
            hint={say("Attached right after you submit (location data removed). If it cannot be attached, the ticket is still saved and says so.")}
          />
        </CardBody>
      </Card>

      {confirmMessage && (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
          <p className="flex items-start gap-2 font-semibold"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {confirmMessage}</p>
          <Checkbox className="mt-2" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} label="Yes, this is a separate delivery, record it (it will be flagged for review)" />
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Link href="/tickets" className={buttonClasses("ghost")}>Cancel</Link>
        <Button onClick={submit} loading={pending} disabled={!orderId || !lineId || Boolean(confirmMessage && !confirmed) || reasonMissing}>{say("Submit ticket")}</Button>
      </div>
    </div>
  );
}
