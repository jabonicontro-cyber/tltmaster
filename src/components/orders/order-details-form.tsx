"use client";

import { PhoneInput } from "@/components/ui/phone-input";
import Link from "next/link";
import { DateInput } from "@/components/ui/date-input";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import type { ContactRow, SiteRow } from "@/server/data/types";
import { updateOrderDetails } from "@/app/(app)/orders/actions";

interface DetailsState {
  id: string;
  editSeq: number;
  orderDate: string;
  fromQuote: boolean;
  contactId: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  siteId: string; // "" = none, "new" = typed address
  siteLabel: string;
  siteLine1: string;
  siteLine2: string;
  siteCity: string;
  siteState: string;
  sitePostalCode: string;
  projectName: string;
  customerPo: string;
  jobInstructions: string;
  internalNotes: string;
  requestedDate: string;
}

interface Props {
  order: DetailsState;
  customer: { name: string; poRequired: boolean; poInstructions: string };
  contacts: ContactRow[];
  sites: SiteRow[];
  canEditCustomers: boolean;
}

/**
 * Details of a confirmed or quote-linked order. Lines, prices, terms and the
 * customer are not part of this form — the database refuses those changes.
 */
export function OrderDetailsForm({ order, customer, contacts, sites, canEditCustomers }: Props) {
  const router = useRouter();
  const [state, setState] = useState(order);
  const [saveSite, setSaveSite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startSaving] = useTransition();
  const update = (patch: Partial<DetailsState>) => setState((s) => ({ ...s, ...patch }));
  // The order may point at a contact or site that was archived since.
  const knownSite = !state.siteId || state.siteId === "new" || sites.some((s) => s.id === state.siteId);
  const knownContact = !state.contactId || contacts.some((c) => c.id === state.contactId);

  function selectContact(contactId: string) {
    const c = contacts.find((x) => x.id === contactId);
    update(c ? { contactId, contactName: c.name, contactEmail: c.email, contactPhone: c.phone } : { contactId: "" });
  }

  function selectSite(siteId: string) {
    const s = sites.find((x) => x.id === siteId);
    if (s) update({ siteId, siteLabel: s.label, siteLine1: s.line1, siteLine2: s.line2, siteCity: s.city, siteState: s.state, sitePostalCode: s.postal_code });
    else if (siteId === order.siteId) update({ siteId, siteLabel: order.siteLabel, siteLine1: order.siteLine1, siteLine2: order.siteLine2, siteCity: order.siteCity, siteState: order.siteState, sitePostalCode: order.sitePostalCode });
    else if (siteId === "new") update({ siteId: "new", siteLabel: "", siteLine1: "", siteLine2: "", siteCity: "", siteState: "IN", sitePostalCode: "" });
    else update({ siteId: "", siteLabel: "", siteLine1: "", siteLine2: "", siteCity: "", siteState: "IN", sitePostalCode: "" });
  }

  function save() {
    setError(null);
    setFieldErrors({});
    startSaving(async () => {
      const r = await updateOrderDetails({
        orderId: state.id,
        expectedEditSeq: state.editSeq,
        contactId: state.contactId || null,
        contactName: state.contactName,
        contactEmail: state.contactEmail,
        contactPhone: state.contactPhone,
        siteId: state.siteId && state.siteId !== "new" ? state.siteId : null,
        siteLabel: state.siteLabel,
        siteLine1: state.siteLine1,
        siteLine2: state.siteLine2,
        siteCity: state.siteCity,
        siteState: state.siteState,
        sitePostalCode: state.sitePostalCode,
        saveSite: state.siteId === "new" && saveSite,
        projectName: state.projectName,
        customerPo: state.customerPo,
        jobInstructions: state.jobInstructions,
        internalNotes: state.internalNotes,
        requestedDate: state.requestedDate,
      });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      toast.success(r.message ?? "Saved");
      router.push(`/orders/${state.id}`);
    });
  }

  return (
    <div className="space-y-5" data-guard-unsaved>
      <Notice title={state.fromQuote ? "Prices are as accepted on the quote" : "Prices are locked"}>
        You can update the contact, job site, PO, requested delivery date, instructions and notes. Lines, prices, terms and the customer cannot be changed
        {state.fromQuote ? " on an order created from a quote." : " after the order is confirmed."} Every change is recorded in the order history.
      </Notice>
      {error && <FormError message={error} />}
      {error?.includes("changed by someone else") && (
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
          Reload latest version (your unsaved changes will be lost)
        </Button>
      )}

      <Card>
        <CardHeader title="Contact and job site" description={customer.name} />
        <CardBody className="grid grid-cols-1 gap-4 md:grid-cols-6">
          <Field label="Contact" htmlFor="contactId" className="md:col-span-2">
            <Select id="contactId" value={state.contactId} onChange={(e) => selectContact(e.target.value)}>
              <option value="">{contacts.length ? "Other / type below" : "No saved contacts — type below"}</option>
              {!knownContact && <option value={state.contactId}>{order.contactName} (archived)</option>}
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.is_primary ? " (primary)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contact name" htmlFor="contactName" error={fieldErrors.contactName} className="md:col-span-2">
            <Input id="contactName" value={state.contactName} onChange={(e) => update({ contactName: e.target.value })} />
          </Field>
          <Field label="Contact email" htmlFor="contactEmail" error={fieldErrors.contactEmail} className="md:col-span-1">
            <Input id="contactEmail" type="email" value={state.contactEmail} onChange={(e) => update({ contactEmail: e.target.value })} />
          </Field>
          <Field label="Contact phone" htmlFor="contactPhone" error={fieldErrors.contactPhone} className="md:col-span-1">
            <PhoneInput id="contactPhone" value={state.contactPhone} onValueChange={(v) => update({ contactPhone: v })} />
          </Field>

          <Field label="Job site / delivery address" htmlFor="siteId" className="md:col-span-3">
            <Select id="siteId" value={state.siteId} onChange={(e) => selectSite(e.target.value)}>
              <option value="">Not specified</option>
              {!knownSite && <option value={state.siteId}>{order.siteLabel || order.siteLine1} (archived)</option>}
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {s.line1}
                </option>
              ))}
              <option value="new">{order.siteId === "new" ? "Address typed on the order" : "New address…"}</option>
            </Select>
          </Field>
          <Field label="Requested delivery" htmlFor="requestedDate" error={fieldErrors.requestedDate} className="md:col-span-1" hint="Optional">
            <DateInput id="requestedDate" min={state.orderDate} value={state.requestedDate} onChange={(e) => update({ requestedDate: e.target.value })} />
          </Field>
          <Field label="Project / job name" htmlFor="projectName" error={fieldErrors.projectName} className="md:col-span-1">
            <Input id="projectName" value={state.projectName} onChange={(e) => update({ projectName: e.target.value })} />
          </Field>
          <Field
            label="Customer PO"
            htmlFor="customerPo"
            error={fieldErrors.customerPo}
            className="md:col-span-1"
            hint={customer.poRequired ? customer.poInstructions || "This customer requires a PO." : undefined}
          >
            <Input id="customerPo" value={state.customerPo} onChange={(e) => update({ customerPo: e.target.value })} />
          </Field>

          {state.siteId === "new" && (
            <div className="grid grid-cols-1 gap-4 rounded-xl border border-line bg-surface/60 p-4 md:col-span-6 md:grid-cols-6">
              <Field label="Site name" htmlFor="siteLabel" error={fieldErrors.siteLabel} className="md:col-span-2">
                <Input id="siteLabel" value={state.siteLabel} onChange={(e) => update({ siteLabel: e.target.value })} />
              </Field>
              <Field label="Street address" htmlFor="siteLine1" error={fieldErrors.siteLine1} className="md:col-span-4">
                <Input id="siteLine1" value={state.siteLine1} onChange={(e) => update({ siteLine1: e.target.value })} />
              </Field>
              <Field label="City" htmlFor="siteCity" error={fieldErrors.siteCity} className="md:col-span-3">
                <Input id="siteCity" value={state.siteCity} onChange={(e) => update({ siteCity: e.target.value })} />
              </Field>
              <Field label="State" htmlFor="siteState" error={fieldErrors.siteState} className="md:col-span-1">
                <Input id="siteState" value={state.siteState} maxLength={2} className="uppercase" onChange={(e) => update({ siteState: e.target.value })} />
              </Field>
              <Field label="ZIP" htmlFor="sitePostalCode" error={fieldErrors.sitePostalCode} className="md:col-span-2">
                <Input id="sitePostalCode" value={state.sitePostalCode} inputMode="numeric" onChange={(e) => update({ sitePostalCode: e.target.value })} />
              </Field>
              {canEditCustomers && (
                <Checkbox className="md:col-span-6" checked={saveSite} onChange={(e) => setSaveSite(e.target.checked)} label="Save this address to the customer's job sites" />
              )}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Instructions and notes" />
        <CardBody className="space-y-4">
          <Field label="Job instructions" htmlFor="jobInstructions" error={fieldErrors.jobInstructions}>
            <Textarea id="jobInstructions" rows={3} value={state.jobInstructions} onChange={(e) => update({ jobInstructions: e.target.value })} />
          </Field>
          <Field label="Internal notes (not shown to the customer)" htmlFor="internalNotes" error={fieldErrors.internalNotes}>
            <Textarea id="internalNotes" rows={2} value={state.internalNotes} onChange={(e) => update({ internalNotes: e.target.value })} />
          </Field>
        </CardBody>
      </Card>

      <div className="flex justify-end gap-2">
        <Link href={`/orders/${state.id}`} className={buttonClasses("ghost")}>Cancel</Link>
        <Button onClick={save} loading={saving}>Save details</Button>
      </div>
    </div>
  );
}
