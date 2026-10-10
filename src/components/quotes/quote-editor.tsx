"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Info, Plus, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { CustomerForm, EMPTY_CUSTOMER } from "@/components/customers/customer-form";
import { Badge, SampleBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { addDays } from "@/lib/dates";
import { bpToInput, centsToInput, formatBp, formatCents, parseMoneyToCents, parsePercentToBp, parseQuantityToMilli } from "@/lib/money";
import { calculateQuote, type CalcLine, type CalcMethod, type ChargeKind } from "@/lib/quotes/calc";
import { CHARGE_KIND_LABELS } from "@/lib/schemas/catalog";
import type { QuoteDraftInput } from "@/lib/schemas/quote";
import type { ChargeItemRow, ContactRow, EffectivePrice, MaterialRow, SiteRow, UnitRow } from "@/server/data/types";
import { quickCreateCustomer } from "@/app/(app)/customers/actions";
import { loadCustomerContext, saveQuoteDraft } from "@/app/(app)/quotes/actions";

export interface EditorLine {
  key: string;
  kind: ChargeKind;
  calcMethod: CalcMethod;
  materialId: string | null;
  chargeItemId: string | null;
  description: string;
  unitCode: string | null;
  quantity: string;
  rate: string;
  percent: string;
  taxable: boolean;
  /** A free-form line (no configured charge). */
  isCustom?: boolean;
}

export interface EditorState {
  quoteId: string | null;
  quoteNumber: string | null;
  versionNo: number;
  editSeq: number | null;
  customerId: string;
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
  saveSite: boolean;
  quoteDate: string;
  validUntil: string;
  projectName: string;
  customerPo: string;
  jobInstructions: string;
  terms: string;
  internalNotes: string;
  taxRate: string;
  lines: EditorLine[];
}

export interface CustomerContext {
  customer: { id: string; name: string; customer_number: string; tax_exempt: boolean; po_required: boolean; po_instructions: string; payment_terms: string; is_sample: boolean; active: boolean };
  contacts: ContactRow[];
  sites: SiteRow[];
  prices: EffectivePrice[];
}

interface Props {
  initial: EditorState;
  initialContext: CustomerContext | null;
  customers: Array<{ id: string; name: string; customer_number: string; is_sample: boolean }>;
  materials: MaterialRow[];
  charges: ChargeItemRow[];
  units: UnitRow[];
  defaultTaxRateBp: number;
  validityDays: number;
  canOverride: boolean;
  canEditCustomers: boolean;
  priceLists: Array<{ id: string; name: string }>;
  revisionReason?: string;
}

let keySeq = 0;
const newKey = () => `l${Date.now().toString(36)}${(keySeq++).toString(36)}`;

function priceKey(kind: "material" | "charge", id: string, unit: string | null) {
  return `${kind}:${id}:${unit ?? "%"}`;
}

function toCalcLine(l: EditorLine): CalcLine {
  return {
    kind: l.kind,
    calcMethod: l.calcMethod,
    quantityMilli: l.calcMethod === "per_unit" ? parseQuantityToMilli(l.quantity) : null,
    rateCents: l.calcMethod === "per_unit" ? parseMoneyToCents(l.rate) : null,
    percentBp: l.calcMethod === "percent_of_subtotal" ? parsePercentToBp(l.percent) : null,
    taxable: l.taxable,
  };
}

export function QuoteEditor({ initial, initialContext, customers: initialCustomers, materials, charges, units, defaultTaxRateBp, validityDays, canOverride, canEditCustomers, priceLists, revisionReason }: Props) {
  const router = useRouter();
  const [state, setState] = useState<EditorState>(initial);
  const [context, setContext] = useState<CustomerContext | null>(initialContext);
  const [customers, setCustomers] = useState(initialCustomers);
  const [loadingContext, startContext] = useTransition();
  const [saving, startSaving] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  const activeMaterials = materials.filter((m) => m.active);
  const activeCharges = charges.filter((c) => c.active);
  const unitLabel = (code: string | null) => units.find((u) => u.code === code)?.label ?? code ?? "";

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const prices = useMemo(() => {
    const map = new Map<string, EffectivePrice>();
    for (const p of context?.prices ?? []) {
      if (p.material_id) map.set(priceKey("material", p.material_id, p.unit_code), p);
      if (p.charge_item_id) map.set(priceKey("charge", p.charge_item_id, p.unit_code), p);
    }
    return map;
  }, [context]);

  function catalogFor(l: Pick<EditorLine, "materialId" | "chargeItemId" | "unitCode" | "calcMethod">): EffectivePrice | null {
    const unit = l.calcMethod === "per_unit" ? l.unitCode : null;
    if (l.materialId) return prices.get(priceKey("material", l.materialId, unit)) ?? null;
    if (l.chargeItemId) return prices.get(priceKey("charge", l.chargeItemId, unit)) ?? null;
    return null;
  }

  function isOverride(l: EditorLine): boolean {
    const cat = catalogFor(l);
    if (!cat) return false;
    if (l.calcMethod === "per_unit") return parseMoneyToCents(l.rate) !== cat.rate_cents;
    return parsePercentToBp(l.percent) !== cat.percent_bp;
  }

  function update(patch: Partial<EditorState>) {
    setState((s) => ({ ...s, ...patch }));
    setDirty(true);
  }

  function updateLine(key: string, patch: Partial<EditorLine>) {
    setState((s) => ({ ...s, lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
    setDirty(true);
  }

  // Customer change -----------------------------------------------------------
  function selectCustomer(customerId: string, quoteDate = state.quoteDate) {
    if (!customerId) return;
    const previousCustomerId = state.customerId;
    update({ customerId });
    startContext(async () => {
      const r = await loadCustomerContext(customerId, quoteDate);
      if (!r.ok) {
        setFormError(r.error);
        return;
      }
      const ctx = r.data;
      const previousPrices = prices;
      setContext(ctx);
      const nextPrices = new Map<string, EffectivePrice>();
      for (const p of ctx.prices) {
        if (p.material_id) nextPrices.set(priceKey("material", p.material_id, p.unit_code), p);
        if (p.charge_item_id) nextPrices.set(priceKey("charge", p.charge_item_id, p.unit_code), p);
      }
      setState((s) => {
        const primary = ctx.contacts.find((c) => c.is_primary) ?? ctx.contacts[0];
        const unchanged = previousCustomerId === customerId;
        const sameCustomer = unchanged && (!s.contactId || ctx.contacts.some((c) => c.id === s.contactId));
        // Re-price lines whose rate still equals the old configured price (untouched by the user).
        const lines = s.lines.map((l) => {
          const unit = l.calcMethod === "per_unit" ? l.unitCode : null;
          const k = l.materialId ? priceKey("material", l.materialId, unit) : l.chargeItemId ? priceKey("charge", l.chargeItemId, unit) : null;
          if (!k) return l;
          const oldP = previousPrices.get(k);
          const newP = nextPrices.get(k);
          const untouched = l.calcMethod === "per_unit"
            ? !l.rate || (oldP && parseMoneyToCents(l.rate) === oldP.rate_cents)
            : !l.percent || (oldP && parsePercentToBp(l.percent) === oldP.percent_bp);
          if (!untouched || !newP) return l;
          return l.calcMethod === "per_unit" ? { ...l, rate: centsToInput(newP.rate_cents) } : { ...l, percent: bpToInput(newP.percent_bp) };
        });
        return {
          ...s,
          customerId,
          contactId: sameCustomer ? s.contactId : primary?.id ?? "",
          contactName: sameCustomer ? s.contactName : primary?.name ?? "",
          contactEmail: sameCustomer ? s.contactEmail : primary?.email ?? "",
          contactPhone: sameCustomer ? s.contactPhone : primary?.phone ?? "",
          siteId: unchanged ? s.siteId : "",
          ...(unchanged ? {} : { siteLabel: "", siteLine1: "", siteLine2: "", siteCity: "", siteState: "IN", sitePostalCode: "" }),
          taxRate: ctx.customer.tax_exempt ? "0" : s.taxRate,
          lines,
        };
      });
    });
  }

  function selectContact(contactId: string) {
    const c = context?.contacts.find((x) => x.id === contactId);
    update(c ? { contactId, contactName: c.name, contactEmail: c.email, contactPhone: c.phone } : { contactId: "" });
  }

  function selectSite(siteId: string) {
    const s = context?.sites.find((x) => x.id === siteId);
    if (s) {
      update({ siteId, siteLabel: s.label, siteLine1: s.line1, siteLine2: s.line2, siteCity: s.city, siteState: s.state, sitePostalCode: s.postal_code, saveSite: false });
    } else if (siteId === "new") {
      update({ siteId: "new", siteLabel: "", siteLine1: "", siteLine2: "", siteCity: "", siteState: "IN", sitePostalCode: "" });
    } else {
      update({ siteId: "", siteLabel: "", siteLine1: "", siteLine2: "", siteCity: "", siteState: "IN", sitePostalCode: "", saveSite: false });
    }
  }

  // Lines ------------------------------------------------------------------------
  function addLine(type: "material" | "charge" | "custom") {
    const line: EditorLine = {
      key: newKey(),
      kind: type === "material" ? "material" : "other",
      calcMethod: "per_unit",
      materialId: null,
      chargeItemId: null,
      description: "",
      unitCode: type === "custom" ? "each" : null,
      quantity: type === "custom" ? "1" : "",
      rate: "",
      percent: "",
      taxable: false,
    };
    update({ lines: [...state.lines, line] });
    setTimeout(() => document.getElementById(`line-${line.key}-item`)?.focus(), 0);
  }

  function chooseMaterial(key: string, materialId: string) {
    const m = materials.find((x) => x.id === materialId);
    if (!m) return updateLine(key, { materialId: null });
    const p = prices.get(priceKey("material", m.id, m.default_unit_code));
    updateLine(key, {
      kind: "material",
      calcMethod: "per_unit",
      materialId: m.id,
      chargeItemId: null,
      description: m.name,
      unitCode: m.default_unit_code,
      rate: p ? centsToInput(p.rate_cents) : "",
      taxable: m.taxable_default,
    });
  }

  function chooseCharge(key: string, chargeId: string) {
    const c = charges.find((x) => x.id === chargeId);
    if (!c) return updateLine(key, { chargeItemId: null });
    const p = prices.get(priceKey("charge", c.id, c.calc_method === "per_unit" ? c.default_unit_code : null));
    const current = state.lines.find((l) => l.key === key);
    // Default the quantity of a per-ton/per-load hauling line to the material quantity above it.
    const lastMaterial = [...state.lines].reverse().find((l) => l.kind === "material" && l.unitCode === c.default_unit_code && l.quantity);
    updateLine(key, {
      isCustom: false,
      kind: c.kind,
      calcMethod: c.calc_method,
      materialId: null,
      chargeItemId: c.id,
      description: c.name,
      unitCode: c.calc_method === "per_unit" ? c.default_unit_code : null,
      quantity: c.calc_method === "per_unit" ? current?.quantity || lastMaterial?.quantity || "" : "",
      rate: c.calc_method === "per_unit" && p ? centsToInput(p.rate_cents) : "",
      percent: c.calc_method === "percent_of_subtotal" && p ? bpToInput(p.percent_bp) : "",
      taxable: c.taxable_default,
    });
  }

  function changeUnit(l: EditorLine, unitCode: string) {
    const p = catalogFor({ ...l, unitCode });
    const oldP = catalogFor(l);
    const untouched = !l.rate || (oldP && parseMoneyToCents(l.rate) === oldP.rate_cents);
    updateLine(l.key, { unitCode, ...(untouched ? { rate: p ? centsToInput(p.rate_cents) : "" } : {}) });
  }

  function moveLine(index: number, delta: number) {
    const lines = [...state.lines];
    const target = index + delta;
    if (target < 0 || target >= lines.length) return;
    [lines[index], lines[target]] = [lines[target], lines[index]];
    update({ lines });
  }

  // Totals ---------------------------------------------------------------------
  const taxBp = parsePercentToBp(state.taxRate || "0") ?? 0;
  const totals = useMemo(() => calculateQuote(state.lines.map(toCalcLine), taxBp), [state.lines, taxBp]);
  const overrideLines = state.lines.filter(isOverride);
  const discountLines = state.lines.filter((l) => l.kind === "discount");
  const blockedByPermission = !canOverride && (overrideLines.length > 0 || discountLines.length > 0);

  // Save -------------------------------------------------------------------------
  function buildInput(): QuoteDraftInput {
    return {
      quoteId: state.quoteId,
      expectedEditSeq: state.editSeq,
      customerId: state.customerId,
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
      saveSite: state.siteId === "new" && state.saveSite,
      quoteDate: state.quoteDate,
      validUntil: state.validUntil,
      projectName: state.projectName,
      customerPo: state.customerPo,
      jobInstructions: state.jobInstructions,
      terms: state.terms,
      internalNotes: state.internalNotes,
      taxRate: state.taxRate || "0",
      lines: state.lines.map((l) => ({
        kind: l.kind,
        calcMethod: l.calcMethod,
        materialId: l.materialId,
        chargeItemId: l.chargeItemId,
        description: l.description,
        unitCode: l.calcMethod === "per_unit" ? l.unitCode : null,
        quantity: l.quantity,
        rate: l.rate,
        percent: l.percent,
        taxable: l.taxable,
      })),
    };
  }

  function save(andView: boolean) {
    if (saving) return;
    setFormError(null);
    setConflict(false);
    setFieldErrors({});
    if (!state.customerId) {
      setFieldErrors({ customerId: "Choose a customer." });
      setFormError("Choose a customer before saving.");
      return;
    }
    if (state.lines.length === 0) {
      setFormError("Add at least one line item.");
      return;
    }
    startSaving(async () => {
      let r: Awaited<ReturnType<typeof saveQuoteDraft>>;
      try {
        r = await saveQuoteDraft(buildInput());
      } catch {
        setFormError("The server could not be reached. Nothing was saved — your changes are still on this page. Try again.");
        return;
      }
      if (!r.ok) {
        setFormError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        setConflict(r.error.includes("changed by someone else"));
        setTimeout(() => errorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
        return;
      }
      setDirty(false);
      toast.success(r.message ?? "Saved");
      if (andView) {
        router.push(`/quotes/${r.data.quoteId}`);
      } else if (!state.quoteId) {
        router.replace(`/quotes/${r.data.quoteId}/edit`);
      } else {
        setState((s) => ({ ...s, editSeq: r.data.editSeq, siteId: s.siteId === "new" && s.saveSite ? "" : s.siteId }));
        router.refresh();
      }
    });
  }

  const lineError = (index: number, field: string) => fieldErrors[`lines.${index}.${field}`];
  const customerOptions = customers.map((c) => ({ value: c.id, label: c.name, detail: c.customer_number + (c.is_sample ? " · sample" : "") }));
  const selectedCustomer = context?.customer;
  const contacts = context?.contacts ?? [];
  const sites = context?.sites ?? [];
  const hasCustomer = Boolean(state.customerId && context);

  return (
    <div className="space-y-5 pb-28">
      {revisionReason && (
        <Notice title={`Revision ${state.versionNo}`}>
          Reason: {revisionReason}. The previously sent version stays unchanged and can be viewed from the quote page.
        </Notice>
      )}

      <div ref={errorRef}>
        {formError && (
          <div className="space-y-2">
            <FormError message={formError} />
            {conflict && (
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
                Reload latest version (your unsaved changes will be lost)
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Customer & job --------------------------------------------------- */}
      <Card>
        <CardHeader title="Customer and job" />
        <CardBody className="grid grid-cols-1 gap-4 md:grid-cols-6">
          <div className="md:col-span-4">
            <Field label="Customer" htmlFor="customer" required error={fieldErrors.customerId}>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Combobox
                    id="customer"
                    options={customerOptions}
                    value={state.customerId || null}
                    onChange={(v) => selectCustomer(v)}
                    placeholder="Search customers by name or number…"
                    invalid={Boolean(fieldErrors.customerId)}
                    disabled={Boolean(state.quoteId && state.versionNo > 1)}
                  />
                </div>
                {canEditCustomers && !state.quoteId && (
                  <Button variant="secondary" icon={<UserPlus className="size-4" />} onClick={() => setNewCustomerOpen(true)}>
                    New
                  </Button>
                )}
              </div>
            </Field>
            {selectedCustomer && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
                <Link href={`/customers/${selectedCustomer.id}`} className="hover:underline" target="_blank">
                  {selectedCustomer.customer_number}
                </Link>
                {selectedCustomer.payment_terms && <span>· Terms: {selectedCustomer.payment_terms}</span>}
                {selectedCustomer.tax_exempt && <Badge tone="blue">Tax exempt</Badge>}
                {selectedCustomer.po_required && <Badge tone="amber">PO required</Badge>}
                <SampleBadge show={selectedCustomer.is_sample} />
                {loadingContext && <span>Loading…</span>}
              </div>
            )}
          </div>
          <Field label="Quote date" htmlFor="quoteDate" required error={fieldErrors.quoteDate} className="md:col-span-1">
            <Input
              id="quoteDate"
              type="date"
              value={state.quoteDate}
              onChange={(e) => {
                const quoteDate = e.target.value;
                update({ quoteDate, validUntil: state.validUntil < quoteDate ? addDays(quoteDate, validityDays) : state.validUntil });
              }}
            />
          </Field>
          <Field label="Valid until" htmlFor="validUntil" required error={fieldErrors.validUntil} className="md:col-span-1">
            <Input id="validUntil" type="date" value={state.validUntil} min={state.quoteDate} onChange={(e) => update({ validUntil: e.target.value })} />
          </Field>

          {hasCustomer && (
            <>
              <Field label="Contact" htmlFor="contactId" className="md:col-span-2">
                <Select id="contactId" value={state.contactId} onChange={(e) => selectContact(e.target.value)}>
                  <option value="">{contacts.length ? "Other / type below" : "No saved contacts — type below"}</option>
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
              <Field label="Contact email" htmlFor="contactEmail" error={fieldErrors.contactEmail} className="md:col-span-2">
                <Input id="contactEmail" type="email" value={state.contactEmail} onChange={(e) => update({ contactEmail: e.target.value })} />
              </Field>

              <Field label="Job site / delivery address" htmlFor="siteId" className="md:col-span-2">
                <Select id="siteId" value={state.siteId} onChange={(e) => selectSite(e.target.value)}>
                  <option value="">Not specified yet</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} — {s.line1}
                    </option>
                  ))}
                  <option value="new">New address…</option>
                </Select>
              </Field>
              <Field label="Project / job name" htmlFor="projectName" error={fieldErrors.projectName} className="md:col-span-2">
                <Input id="projectName" value={state.projectName} onChange={(e) => update({ projectName: e.target.value })} />
              </Field>
              <Field
                label="Customer PO"
                htmlFor="customerPo"
                error={fieldErrors.customerPo}
                className="md:col-span-2"
                hint={selectedCustomer?.po_required ? selectedCustomer.po_instructions || "This customer requires a PO." : undefined}
              >
                <Input id="customerPo" value={state.customerPo} onChange={(e) => update({ customerPo: e.target.value })} />
              </Field>

              {state.siteId === "new" && (
                <div className="grid grid-cols-1 gap-4 rounded-md border border-line bg-surface/60 p-4 md:col-span-6 md:grid-cols-6">
                  <Field label="Site name" htmlFor="siteLabel" error={fieldErrors.siteLabel} className="md:col-span-2">
                    <Input id="siteLabel" value={state.siteLabel} onChange={(e) => update({ siteLabel: e.target.value })} placeholder="e.g. Lot 14 driveway" />
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
                    <Checkbox
                      className="md:col-span-6"
                      checked={state.saveSite}
                      onChange={(e) => update({ saveSite: e.target.checked })}
                      label="Save this address to the customer's job sites"
                    />
                  )}
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {/* Lines ------------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Line items"
          description="Materials and hauling are separate lines. Rates are filled from the customer's price list, then standard rates."
        />
        {!hasCustomer ? (
          <CardBody>
            <p className="text-muted">Choose a customer first so the right rates can be filled in.</p>
          </CardBody>
        ) : (
          <>
            {state.lines.length === 0 && (
              <CardBody>
                <p className="text-muted">No lines yet. Add a material, a hauling charge or a custom line.</p>
              </CardBody>
            )}
            <ol className="divide-y divide-line">
              {state.lines.map((l, i) => {
                const cat = catalogFor(l);
                const override = isOverride(l);
                const amount = totals.lineAmounts[i] ?? 0;
                const isCharge = l.kind !== "material";
                return (
                  <li key={l.key} className="grid grid-cols-12 gap-x-3 gap-y-2 px-4 py-4 sm:px-5" aria-label={`Line ${i + 1}`}>
                    <div className="col-span-12 flex items-center gap-2 text-sm font-semibold text-muted lg:hidden">Line {i + 1}</div>

                    {/* Item */}
                    <div className="col-span-12 lg:col-span-4">
                      <label htmlFor={`line-${l.key}-item`} className="mb-1 block text-xs font-bold text-muted uppercase">
                        {l.kind === "material" ? "Material" : "Charge"}
                      </label>
                      {l.kind === "material" ? (
                        <Select id={`line-${l.key}-item`} value={l.materialId ?? ""} onChange={(e) => chooseMaterial(l.key, e.target.value)}>
                          <option value="">Choose material…</option>
                          {activeMaterials.map((m) => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                          {l.materialId && !activeMaterials.some((m) => m.id === l.materialId) && (
                            <option value={l.materialId}>{materials.find((m) => m.id === l.materialId)?.name ?? "Inactive material"} (inactive)</option>
                          )}
                        </Select>
                      ) : (
                        <Select
                          id={`line-${l.key}-item`}
                          value={l.chargeItemId ? `c:${l.chargeItemId}` : l.isCustom ? `k:${l.kind}` : ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v.startsWith("c:")) chooseCharge(l.key, v.slice(2));
                            else if (v.startsWith("k:")) updateLine(l.key, { chargeItemId: null, isCustom: true, kind: v.slice(2) as ChargeKind, unitCode: l.unitCode ?? "each", quantity: l.quantity || "1" });
                          }}
                        >
                          {!l.chargeItemId && !l.isCustom && <option value="">Choose a charge…</option>}
                          <optgroup label="Configured charges">
                            {activeCharges
                              .filter((c) => canOverride || c.kind !== "discount")
                              .map((c) => (
                                <option key={c.id} value={`c:${c.id}`}>{c.name}</option>
                              ))}
                          </optgroup>
                          <optgroup label="Custom line">
                            {(["hauling", "service", "surcharge", "other", ...(canOverride ? ["discount"] : [])] as ChargeKind[]).map((k) => (
                              <option key={k} value={`k:${k}`}>Custom — {CHARGE_KIND_LABELS[k]}</option>
                            ))}
                          </optgroup>
                        </Select>
                      )}
                      <label htmlFor={`line-${l.key}-desc`} className="sr-only">Description</label>
                      <Input
                        id={`line-${l.key}-desc`}
                        className="mt-2"
                        placeholder="Description shown to the customer"
                        value={l.description}
                        aria-invalid={Boolean(lineError(i, "description")) || undefined}
                        onChange={(e) => updateLine(l.key, { description: e.target.value })}
                      />
                      {lineError(i, "description") && <p className="mt-1 text-sm text-red-700">{lineError(i, "description")}</p>}
                    </div>

                    {l.calcMethod === "per_unit" ? (
                      <>
                        <div className="col-span-4 sm:col-span-3 lg:col-span-2">
                          <label htmlFor={`line-${l.key}-qty`} className="mb-1 block text-xs font-bold text-muted uppercase">Quantity</label>
                          <Input
                            id={`line-${l.key}-qty`}
                            inputMode="decimal"
                            className="text-right tabular"
                            value={l.quantity}
                            aria-invalid={Boolean(lineError(i, "quantity")) || (l.quantity !== "" && parseQuantityToMilli(l.quantity) === null) || undefined}
                            onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                          />
                          {lineError(i, "quantity") && <p className="mt-1 text-sm text-red-700">{lineError(i, "quantity")}</p>}
                        </div>
                        <div className="col-span-8 sm:col-span-3 lg:col-span-2">
                          <label htmlFor={`line-${l.key}-unit`} className="mb-1 block text-xs font-bold text-muted uppercase">Unit</label>
                          <Select id={`line-${l.key}-unit`} value={l.unitCode ?? ""} onChange={(e) => changeUnit(l, e.target.value)} aria-invalid={Boolean(lineError(i, "unitCode")) || undefined}>
                            <option value="">Unit…</option>
                            {units.map((u) => (
                              <option key={u.code} value={u.code}>{u.label}</option>
                            ))}
                          </Select>
                          {lineError(i, "unitCode") && <p className="mt-1 text-sm text-red-700">{lineError(i, "unitCode")}</p>}
                        </div>
                        <div className="col-span-6 sm:col-span-3 lg:col-span-2">
                          <label htmlFor={`line-${l.key}-rate`} className="mb-1 block text-xs font-bold text-muted uppercase">
                            {l.kind === "discount" ? "Discount" : "Rate"} ($/{unitLabel(l.unitCode).toLowerCase() || "unit"})
                          </label>
                          <Input
                            id={`line-${l.key}-rate`}
                            inputMode="decimal"
                            className="text-right tabular"
                            value={l.rate}
                            aria-invalid={Boolean(lineError(i, "rate")) || (l.rate !== "" && parseMoneyToCents(l.rate) === null) || undefined}
                            onChange={(e) => updateLine(l.key, { rate: e.target.value })}
                          />
                          {lineError(i, "rate") && <p className="mt-1 text-sm text-red-700">{lineError(i, "rate")}</p>}
                        </div>
                      </>
                    ) : (
                      <div className="col-span-6 sm:col-span-4 lg:col-span-6">
                        <label htmlFor={`line-${l.key}-pct`} className="mb-1 block text-xs font-bold text-muted uppercase">Percent of subtotal</label>
                        <div className="flex items-center gap-2">
                          <Input
                            id={`line-${l.key}-pct`}
                            inputMode="decimal"
                            className="max-w-28 text-right tabular"
                            value={l.percent}
                            aria-invalid={Boolean(lineError(i, "percent")) || undefined}
                            onChange={(e) => updateLine(l.key, { percent: e.target.value })}
                          />
                          <span className="text-muted">%</span>
                        </div>
                        {lineError(i, "percent") && <p className="mt-1 text-sm text-red-700">{lineError(i, "percent")}</p>}
                      </div>
                    )}

                    <div className="col-span-6 flex flex-col items-end sm:col-span-3 lg:col-span-2">
                      <span className="mb-1 block text-xs font-bold text-muted uppercase">Amount</span>
                      <span className={cn("flex h-10 items-center text-lg font-bold tabular", amount < 0 && "text-green-800")}>{formatCents(amount)}</span>
                    </div>

                    <div className="col-span-12 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                      <Checkbox checked={l.taxable} onChange={(e) => updateLine(l.key, { taxable: e.target.checked })} label="Taxable" />
                      {isCharge && l.isCustom && (
                        <label className="inline-flex items-center gap-2">
                          <span className="text-muted">Calculated</span>
                          <select
                            className="h-8 rounded border border-line bg-white px-2"
                            value={l.calcMethod}
                            onChange={(e) =>
                              updateLine(l.key, {
                                calcMethod: e.target.value as CalcMethod,
                                unitCode: e.target.value === "per_unit" ? l.unitCode ?? "each" : null,
                              })
                            }
                          >
                            <option value="per_unit">Quantity × rate</option>
                            <option value="percent_of_subtotal">% of subtotal</option>
                          </select>
                        </label>
                      )}
                      {cat && !override && (
                        <span className="text-muted">
                          {cat.source === "customer" ? "Customer rate" : "Standard rate"}
                        </span>
                      )}
                      {override && (
                        <Badge tone={canOverride ? "amber" : "red"}>
                          Override — configured {cat?.rate_cents !== null && cat?.rate_cents !== undefined ? formatCents(cat.rate_cents) : formatBp(cat?.percent_bp ?? 0)}
                        </Badge>
                      )}
                      {!cat && (l.materialId || l.chargeItemId) && <span className="text-muted">No configured rate — enter manually</span>}
                      <div className="ml-auto flex gap-1">
                        <Button size="sm" variant="ghost" aria-label={`Move line ${i + 1} up`} disabled={i === 0} onClick={() => moveLine(i, -1)}>
                          <ArrowUp className="size-4" />
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Move line ${i + 1} down`} disabled={i === state.lines.length - 1} onClick={() => moveLine(i, 1)}>
                          <ArrowDown className="size-4" />
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => update({ lines: state.lines.filter((x) => x.key !== l.key) })}>
                          <Trash2 className="size-4 text-red-700" />
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3 sm:px-5">
              <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => addLine("material")}>Add material</Button>
              <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => addLine("charge")}>Add hauling / charge</Button>
            </div>
          </>
        )}
      </Card>

      {/* Notes & totals ----------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Instructions and terms" />
          <CardBody className="space-y-4">
            <Field label="Job instructions (printed on the quote)" htmlFor="jobInstructions" error={fieldErrors.jobInstructions}>
              <Textarea id="jobInstructions" rows={3} value={state.jobInstructions} onChange={(e) => update({ jobInstructions: e.target.value })} placeholder="Delivery window, where to dump, site access…" />
            </Field>
            <Field label="Terms (printed on the quote)" htmlFor="terms" error={fieldErrors.terms}>
              <Textarea id="terms" rows={4} value={state.terms} onChange={(e) => update({ terms: e.target.value })} />
            </Field>
            <Field label="Internal notes (not printed)" htmlFor="internalNotes" error={fieldErrors.internalNotes}>
              <Textarea id="internalNotes" rows={2} value={state.internalNotes} onChange={(e) => update({ internalNotes: e.target.value })} />
            </Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Totals" description="Final totals are calculated by the server when you save." />
          <CardBody>
            <dl className="space-y-2 text-[15px]">
              <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular">{formatCents(totals.subtotalCents)}</dd></div>
              {totals.discountCents !== 0 && (
                <div className="flex justify-between"><dt className="text-muted">Discounts</dt><dd className="text-green-800 tabular">-{formatCents(totals.discountCents)}</dd></div>
              )}
              <div className="flex items-center justify-between gap-3">
                <dt>
                  <label htmlFor="taxRate" className="text-muted">Sales tax %</label>
                </dt>
                <dd className="flex items-center gap-2">
                  <Input
                    id="taxRate"
                    inputMode="decimal"
                    className="h-8 w-20 text-right tabular"
                    value={state.taxRate}
                    disabled={selectedCustomer?.tax_exempt}
                    aria-invalid={Boolean(fieldErrors.taxRate) || parsePercentToBp(state.taxRate || "0") === null || undefined}
                    onChange={(e) => update({ taxRate: e.target.value })}
                  />
                </dd>
              </div>
              {fieldErrors.taxRate && <p className="text-sm text-red-700">{fieldErrors.taxRate}</p>}
              <div className="flex justify-between"><dt className="text-muted">Tax (on {formatCents(totals.taxableCents)} taxable)</dt><dd className="tabular">{formatCents(totals.taxCents)}</dd></div>
              <div className="flex justify-between border-t-2 border-charcoal pt-2 text-xl font-black"><dt>Total</dt><dd className="tabular">{formatCents(totals.totalCents)}</dd></div>
            </dl>
            {defaultTaxRateBp === 0 && !selectedCustomer?.tax_exempt && (
              <p className="mt-3 flex gap-1.5 text-sm text-muted">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> No default tax rate is configured. Set one in Settings once confirmed with your accountant.
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      {blockedByPermission && (
        <Notice tone="warning" title="Owner approval needed">
          {overrideLines.length > 0 && `${overrideLines.length} line(s) use a rate different from the configured price. `}
          {discountLines.length > 0 && "Discounts require pricing approval. "}
          Your role cannot override pricing, so saving will be refused. Use the configured rates or ask an owner.
        </Notice>
      )}

      {/* Sticky action bar */}
      <div className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 px-4 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] backdrop-blur lg:left-68">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted">
            {dirty ? <span className="font-semibold text-amber-800">Unsaved changes</span> : state.quoteId ? "All changes saved" : "New quote — not saved yet"}
            <span className="ml-3 font-bold text-ink tabular">Total {formatCents(totals.totalCents)}</span>
          </div>
          <div className="flex gap-2">
            <Link href={state.quoteId ? `/quotes/${state.quoteId}` : "/quotes"} className={buttonClasses("ghost")}>
              {dirty ? "Discard" : "Back"}
            </Link>
            <Button variant="secondary" onClick={() => save(false)} loading={saving} disabled={!hasCustomer}>
              Save draft
            </Button>
            <Button onClick={() => save(true)} loading={saving} disabled={!hasCustomer}>
              Save &amp; review
            </Button>
          </div>
        </div>
      </div>

      {newCustomerOpen && (
        <Dialog open onOpenChange={setNewCustomerOpen} title="New customer" description="Creates the customer record and selects it for this quote." size="lg">
          <CustomerForm
            initial={EMPTY_CUSTOMER}
            priceLists={priceLists}
            action={quickCreateCustomer}
            submitLabel="Create and select"
            onCancel={() => setNewCustomerOpen(false)}
            withContact
            compact
            onSuccess={(c, message) => {
              setCustomers((list) => [...list, { ...c, is_sample: false }].sort((a, b) => a.name.localeCompare(b.name)));
              setNewCustomerOpen(false);
              if (message) toast.warning(message);
              else toast.success(`Customer ${c.name} created.`);
              selectCustomer(c.id);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
