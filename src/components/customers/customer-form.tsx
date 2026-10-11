"use client";

import { PhoneInput } from "@/components/ui/phone-input";
import { Button, ButtonLink } from "@/components/ui/button";
import { Checkbox, Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import { PAYMENT_TERMS_SUGGESTIONS } from "@/lib/schemas/customer";

export interface CustomerFormValues {
  name: string;
  customer_type: "commercial" | "residential";
  email: string;
  phone: string;
  billing_line1: string;
  billing_line2: string;
  billing_city: string;
  billing_state: string;
  billing_postal_code: string;
  po_required: boolean;
  po_instructions: string;
  payment_terms: string;
  price_list_id: string | null;
  tax_exempt: boolean;
  notes: string;
}

export const EMPTY_CUSTOMER: CustomerFormValues = {
  name: "",
  customer_type: "commercial",
  email: "",
  phone: "",
  billing_line1: "",
  billing_line2: "",
  billing_city: "",
  billing_state: "IN",
  billing_postal_code: "",
  po_required: false,
  po_instructions: "",
  payment_terms: "",
  price_list_id: null,
  tax_exempt: false,
  notes: "",
};

interface Props<T> {
  initial: CustomerFormValues;
  priceLists: Array<{ id: string; name: string }>;
  action: (formData: FormData) => Promise<ActionResult<T>>;
  submitLabel: string;
  cancelHref?: string;
  onCancel?: () => void;
  /** Ask for a first contact (new customers). */
  withContact?: boolean;
  compact?: boolean;
  onSuccess?: (data: T, message?: string) => void;
}

export function CustomerForm<T>({ initial, priceLists, action, submitLabel, cancelHref, onCancel, withContact, compact, onSuccess }: Props<T>) {
  const { pending, onSubmit, fieldError, formError } = useFormAction(action, { onSuccess: (r) => onSuccess?.(r.data, r.message) });
  const f = (name: keyof CustomerFormValues | string) => ({ id: name, name, ...describedBy(name, fieldError(name)) });

  return (
    <form data-guard-unsaved onSubmit={onSubmit} className="space-y-6" noValidate>
      <FormError message={formError} />

      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <legend className="mb-2 text-sm font-bold tracking-wide text-muted uppercase sm:col-span-6">Customer</legend>
        <Field label="Customer name" htmlFor="name" required error={fieldError("name")} className="sm:col-span-4">
          <Input {...f("name")} defaultValue={initial.name} required maxLength={160} autoFocus={!compact} />
        </Field>
        <Field label="Type" htmlFor="customer_type" error={fieldError("customer_type")} className="sm:col-span-2">
          <Select {...f("customer_type")} defaultValue={initial.customer_type}>
            <option value="commercial">Commercial</option>
            <option value="residential">Residential</option>
          </Select>
        </Field>
        <Field label="Main email" htmlFor="email" error={fieldError("email")} className="sm:col-span-3">
          <Input {...f("email")} type="email" defaultValue={initial.email} autoComplete="off" />
        </Field>
        <Field label="Main phone" htmlFor="phone" error={fieldError("phone")} className="sm:col-span-3">
          <PhoneInput {...f("phone")} defaultValue={initial.phone} autoComplete="off" />
        </Field>
      </fieldset>

      {withContact && (
        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
          <legend className="mb-2 text-sm font-bold tracking-wide text-muted uppercase sm:col-span-6">Primary contact (optional)</legend>
          <Field label="Contact name" htmlFor="contact_name" error={fieldError("contact_name")} className="sm:col-span-2">
            <Input {...f("contact_name")} />
          </Field>
          <Field label="Contact email" htmlFor="contact_email" error={fieldError("contact_email")} className="sm:col-span-2">
            <Input {...f("contact_email")} type="email" />
          </Field>
          <Field label="Contact phone" htmlFor="contact_phone" error={fieldError("contact_phone")} className="sm:col-span-2">
            <PhoneInput {...f("contact_phone")} />
          </Field>
        </fieldset>
      )}

      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <legend className="mb-2 text-sm font-bold tracking-wide text-muted uppercase sm:col-span-6">Billing address</legend>
        <Field label="Street address" htmlFor="billing_line1" error={fieldError("billing_line1")} className="sm:col-span-4">
          <Input {...f("billing_line1")} defaultValue={initial.billing_line1} />
        </Field>
        <Field label="Suite / unit" htmlFor="billing_line2" error={fieldError("billing_line2")} className="sm:col-span-2">
          <Input {...f("billing_line2")} defaultValue={initial.billing_line2} />
        </Field>
        <Field label="City" htmlFor="billing_city" error={fieldError("billing_city")} className="sm:col-span-3">
          <Input {...f("billing_city")} defaultValue={initial.billing_city} />
        </Field>
        <Field label="State" htmlFor="billing_state" error={fieldError("billing_state")} className="sm:col-span-1">
          <Input {...f("billing_state")} defaultValue={initial.billing_state} maxLength={2} className="uppercase" />
        </Field>
        <Field label="ZIP" htmlFor="billing_postal_code" error={fieldError("billing_postal_code")} className="sm:col-span-2">
          <Input {...f("billing_postal_code")} defaultValue={initial.billing_postal_code} inputMode="numeric" maxLength={10} />
        </Field>
      </fieldset>

      {!compact && (
        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
          <legend className="mb-2 text-sm font-bold tracking-wide text-muted uppercase sm:col-span-6">Billing and pricing</legend>
          <Field label="Payment terms" htmlFor="payment_terms" error={fieldError("payment_terms")} className="sm:col-span-2" hint="Informational — invoices are issued in your accounting system.">
            <Input {...f("payment_terms")} defaultValue={initial.payment_terms} list="payment-terms" />
            <datalist id="payment-terms">
              {PAYMENT_TERMS_SUGGESTIONS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
          <Field label="Customer price list" htmlFor="price_list_id" error={fieldError("price_list_id")} className="sm:col-span-4" hint="Rates on this list are used before standard rates when quoting.">
            <Select {...f("price_list_id")} defaultValue={initial.price_list_id ?? ""}>
              <option value="">Standard rates only</option>
              {priceLists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col gap-3 sm:col-span-6 sm:flex-row sm:gap-8">
            <Checkbox name="po_required" defaultChecked={initial.po_required} label="Purchase order number required" />
            <Checkbox name="tax_exempt" defaultChecked={initial.tax_exempt} label="Tax exempt (quotes will not charge tax)" />
          </div>
          <Field label="PO instructions" htmlFor="po_instructions" error={fieldError("po_instructions")} className="sm:col-span-6">
            <Input {...f("po_instructions")} defaultValue={initial.po_instructions} placeholder="e.g. PO number on every ticket and invoice" />
          </Field>
          <Field label="Internal notes" htmlFor="notes" error={fieldError("notes")} className="sm:col-span-6" hint="Visible to staff only. Do not store sensitive personal information.">
            <Textarea {...f("notes")} defaultValue={initial.notes} rows={3} />
          </Field>
        </fieldset>
      )}

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        {cancelHref && (
          <ButtonLink href={cancelHref} variant="secondary">
            Cancel
          </ButtonLink>
        )}
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
