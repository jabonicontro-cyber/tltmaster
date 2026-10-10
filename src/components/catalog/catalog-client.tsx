"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge, SampleBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import { CHARGE_KIND_LABELS } from "@/lib/schemas/catalog";
import type { ChargeItemRow, MaterialRow, PriceListRow, UnitRow } from "@/server/data/types";
import {
  saveChargeItem,
  saveMaterial,
  savePriceList,
  saveUnit,
  setChargeItemActive,
  setMaterialActive,
  setPriceListActive,
  setUnitActive,
} from "@/app/(app)/materials/actions";

function useToggle(action: () => Promise<ActionResult>) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return {
    pending,
    run: () =>
      start(async () => {
        const r = await action();
        if (r.ok) {
          toast.success(r.message ?? "Saved");
          router.refresh();
        } else toast.error(r.error);
      }),
  };
}

function ToggleActive({ active, action }: { active: boolean; action: () => Promise<ActionResult> }) {
  const t = useToggle(action);
  return (
    <Button size="sm" variant="ghost" onClick={t.run} disabled={t.pending}>
      {active ? "Deactivate" : "Reactivate"}
    </Button>
  );
}

function FormDialog({ title, action, onClose, children, submitLabel }: { title: string; action: (fd: FormData) => Promise<ActionResult<unknown>>; onClose: () => void; children: (fieldError: (n: string) => string | undefined) => React.ReactNode; submitLabel: string }) {
  const router = useRouter();
  const { pending, onSubmit, fieldError, formError } = useFormAction(action, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved");
      router.refresh();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()} title={title}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        {children(fieldError)}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const ctl = (id: string, err?: string) => ({ id, name: id, ...describedBy(id, err) });

/* Materials ------------------------------------------------------------- */

export function MaterialsTable({ rows, units, canEdit }: { rows: MaterialRow[]; units: UnitRow[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<MaterialRow | "new" | null>(null);
  const unitLabel = (c: string) => units.find((u) => u.code === c)?.label ?? c;
  const m = editing === "new" ? null : editing;
  return (
    <>
      <CardHeader
        title="Materials"
        description="Materials you deliver. The default unit is suggested on quotes; quotes store their own snapshot."
        actions={canEdit && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>Add material</Button>}
      />
      {rows.length === 0 ? (
        <EmptyState title="No materials yet" description="Add the materials you haul so they can be picked on quotes." />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Material</Th>
                <Th className="hidden sm:table-cell">Code</Th>
                <Th>Default unit</Th>
                <Th className="hidden md:table-cell">Taxable</Th>
                <Th>Status</Th>
                {canEdit && <Th align="right">Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2 font-semibold">
                      {r.name} <SampleBadge show={r.is_sample} />
                    </div>
                    {r.description && <div className="text-sm text-muted">{r.description}</div>}
                  </Td>
                  <Td className="hidden font-mono text-sm sm:table-cell">{r.code}</Td>
                  <Td>{unitLabel(r.default_unit_code)}</Td>
                  <Td className="hidden md:table-cell">{r.taxable_default ? "Yes" : "No"}</Td>
                  <Td>{r.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                  {canEdit && (
                    <Td align="right" className="whitespace-nowrap">
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(r)}>
                        Edit
                      </Button>
                      <ToggleActive active={r.active} action={() => setMaterialActive(r.id, !r.active)} />
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {editing && (
        <FormDialog title={m ? "Edit material" : "Add material"} action={saveMaterial.bind(null, m?.id ?? null)} onClose={() => setEditing(null)} submitLabel="Save material">
          {(fe) => (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
              <Field label="Name" htmlFor="name" required error={fe("name")} className="sm:col-span-4">
                <Input {...ctl("name", fe("name"))} defaultValue={m?.name} autoFocus />
              </Field>
              <Field label="Code / SKU" htmlFor="code" error={fe("code")} className="sm:col-span-2" hint="Optional">
                <Input {...ctl("code", fe("code"))} defaultValue={m?.code ?? ""} className="uppercase" />
              </Field>
              <Field label="Default unit" htmlFor="default_unit_code" required error={fe("default_unit_code")} className="sm:col-span-3">
                <Select {...ctl("default_unit_code", fe("default_unit_code"))} defaultValue={m?.default_unit_code ?? "ton"}>
                  {units.map((u) => (
                    <option key={u.code} value={u.code}>{u.label}</option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end pb-2 sm:col-span-3">
                <Checkbox name="taxable_default" defaultChecked={m?.taxable_default ?? true} label="Taxable by default" />
              </div>
              <Field label="Description" htmlFor="description" error={fe("description")} className="sm:col-span-6">
                <Textarea {...ctl("description", fe("description"))} defaultValue={m?.description} rows={2} />
              </Field>
            </div>
          )}
        </FormDialog>
      )}
    </>
  );
}

/* Charge items ---------------------------------------------------------- */

export function ChargesTable({ rows, units, canEdit }: { rows: ChargeItemRow[]; units: UnitRow[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<ChargeItemRow | "new" | null>(null);
  const [method, setMethod] = useState<string>("per_unit");
  const unitLabel = (c: string | null) => (c ? units.find((u) => u.code === c)?.label ?? c : "");
  const c = editing === "new" ? null : editing;
  return (
    <>
      <CardHeader
        title="Hauling, services and other charges"
        description="Delivery charges, hourly trucking, surcharges and discounts — kept separate from material prices."
        actions={
          canEdit && (
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => { setMethod("per_unit"); setEditing("new"); }}>
              Add charge
            </Button>
          )
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="No charges yet" description="Add hauling, hourly trucking, surcharges or discounts." />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Charge</Th>
                <Th>Type</Th>
                <Th className="hidden sm:table-cell">Calculated</Th>
                <Th className="hidden md:table-cell">Taxable</Th>
                <Th>Status</Th>
                {canEdit && <Th align="right">Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2 font-semibold">
                      {r.name} <SampleBadge show={r.is_sample} />
                    </div>
                    {r.code && <div className="font-mono text-xs text-muted">{r.code}</div>}
                  </Td>
                  <Td>{CHARGE_KIND_LABELS[r.kind]}</Td>
                  <Td className="hidden sm:table-cell">{r.calc_method === "per_unit" ? `Per ${unitLabel(r.default_unit_code).toLowerCase()}` : "% of subtotal"}</Td>
                  <Td className="hidden md:table-cell">{r.taxable_default ? "Yes" : "No"}</Td>
                  <Td>{r.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                  {canEdit && (
                    <Td align="right" className="whitespace-nowrap">
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => { setMethod(r.calc_method); setEditing(r); }}>
                        Edit
                      </Button>
                      <ToggleActive active={r.active} action={() => setChargeItemActive(r.id, !r.active)} />
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {editing && (
        <FormDialog title={c ? "Edit charge" : "Add charge"} action={saveChargeItem.bind(null, c?.id ?? null)} onClose={() => setEditing(null)} submitLabel="Save charge">
          {(fe) => (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
              <Field label="Name" htmlFor="name" required error={fe("name")} className="sm:col-span-4">
                <Input {...ctl("name", fe("name"))} defaultValue={c?.name} autoFocus />
              </Field>
              <Field label="Code" htmlFor="code" error={fe("code")} className="sm:col-span-2" hint="Optional">
                <Input {...ctl("code", fe("code"))} defaultValue={c?.code ?? ""} className="uppercase" />
              </Field>
              <Field label="Type" htmlFor="kind" required error={fe("kind")} className="sm:col-span-3">
                <Select {...ctl("kind", fe("kind"))} defaultValue={c?.kind ?? "hauling"}>
                  {["hauling", "service", "surcharge", "discount", "other"].map((k) => (
                    <option key={k} value={k}>{CHARGE_KIND_LABELS[k]}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Calculated" htmlFor="calc_method" required error={fe("calc_method")} className="sm:col-span-3">
                <Select {...ctl("calc_method", fe("calc_method"))} value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="per_unit">Quantity × rate</option>
                  <option value="percent_of_subtotal">Percentage of subtotal</option>
                </Select>
              </Field>
              {method === "per_unit" && (
                <Field label="Default unit" htmlFor="default_unit_code" required error={fe("default_unit_code")} className="sm:col-span-3">
                  <Select {...ctl("default_unit_code", fe("default_unit_code"))} defaultValue={c?.default_unit_code ?? "ton"}>
                    {units.map((u) => (
                      <option key={u.code} value={u.code}>{u.label}</option>
                    ))}
                  </Select>
                </Field>
              )}
              <div className="flex items-end pb-2 sm:col-span-3">
                <Checkbox name="taxable_default" defaultChecked={c?.taxable_default ?? false} label="Taxable by default" />
              </div>
              <Field label="Description" htmlFor="description" error={fe("description")} className="sm:col-span-6">
                <Textarea {...ctl("description", fe("description"))} defaultValue={c?.description} rows={2} />
              </Field>
              {method === "percent_of_subtotal" && (
                <p className="text-sm text-muted sm:col-span-6">
                  Percentages are calculated on the sum of the quote&apos;s quantity × rate lines (excluding discounts).
                </p>
              )}
            </div>
          )}
        </FormDialog>
      )}
    </>
  );
}

/* Units ------------------------------------------------------------------ */

export function UnitsTable({ rows, canEdit }: { rows: UnitRow[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<UnitRow | "new" | null>(null);
  const u = editing === "new" ? null : editing;
  return (
    <>
      <CardHeader
        title="Units of measure"
        description="Quantities on quotes always carry their unit; different units are never added together."
        actions={canEdit && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>Add unit</Button>}
      />
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>Unit</Th>
              <Th>Code</Th>
              <Th>Abbreviation</Th>
              <Th>Status</Th>
              {canEdit && <Th align="right">Actions</Th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.code}>
                <Td className="font-semibold">{r.label}</Td>
                <Td className="font-mono text-sm">{r.code}</Td>
                <Td>{r.abbreviation}</Td>
                <Td>{r.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                {canEdit && (
                  <Td align="right" className="whitespace-nowrap">
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                    <ToggleActive active={r.active} action={() => setUnitActive(r.code, !r.active)} />
                  </Td>
                )}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      {editing && (
        <FormDialog title={u ? "Edit unit" : "Add unit"} action={saveUnit.bind(null, u?.code ?? null)} onClose={() => setEditing(null)} submitLabel="Save unit">
          {(fe) => (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Label (plural)" htmlFor="label" required error={fe("label")} hint='e.g. "Tons"'>
                <Input {...ctl("label", fe("label"))} defaultValue={u?.label} autoFocus />
              </Field>
              <Field label="Abbreviation" htmlFor="abbreviation" required error={fe("abbreviation")} hint='e.g. "ton"'>
                <Input {...ctl("abbreviation", fe("abbreviation"))} defaultValue={u?.abbreviation} />
              </Field>
              <Field label="Code" htmlFor="code" required={!u} error={fe("code")} hint={u ? "Codes cannot be changed." : "Lowercase, no spaces, e.g. cu_yd"}>
                <Input {...ctl("code", fe("code"))} defaultValue={u?.code} disabled={Boolean(u)} />
              </Field>
              <Field label="Sort order" htmlFor="sort_order" error={fe("sort_order")}>
                <Input {...ctl("sort_order", fe("sort_order"))} type="number" defaultValue={u?.sort_order ?? 100} />
              </Field>
            </div>
          )}
        </FormDialog>
      )}
    </>
  );
}

/* Price lists ------------------------------------------------------------- */

export function PriceListsTable({ rows, usage, canEdit }: { rows: PriceListRow[]; usage: Record<string, number>; canEdit: boolean }) {
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  return (
    <>
      <CardHeader
        title="Price lists"
        description="Standard rates apply to everyone. Customer price lists (or shared tiers) override them for the customers that use them."
        actions={canEdit && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New price list</Button>}
      />
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>Price list</Th>
              <Th>Used by</Th>
              <Th>Status</Th>
              {canEdit && <Th align="right">Actions</Th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td>
                  <Link href={`/materials/price-lists/${r.id}`} className="font-semibold hover:text-brand hover:underline">
                    {r.name}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    {r.is_standard && <Badge tone="brand">Standard</Badge>}
                    <SampleBadge show={r.is_sample} />
                  </div>
                  {r.description && <div className="text-sm text-muted">{r.description}</div>}
                </Td>
                <Td>{r.is_standard ? "All customers" : `${usage[r.id] ?? 0} customer(s)`}</Td>
                <Td>{r.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                {canEdit && (
                  <Td align="right" className="whitespace-nowrap">
                    {!r.is_standard && <ToggleActive active={r.active} action={() => setPriceListActive(r.id, !r.active)} />}
                  </Td>
                )}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      {creating && (
        <FormDialogWithRedirect onClose={() => setCreating(false)} onCreated={(id) => router.push(`/materials/price-lists/${id}`)} />
      )}
    </>
  );
}

function FormDialogWithRedirect({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { pending, onSubmit, fieldError, formError } = useFormAction(savePriceList.bind(null, null), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved");
      onCreated(r.data.id);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()} title="New price list" description="Give it a name that makes sense to the office, e.g. the customer's name or a tier like “Contractor rates”.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        <Field label="Name" htmlFor="name" required error={fieldError("name")}>
          <Input {...ctl("name", fieldError("name"))} autoFocus />
        </Field>
        <Field label="Description" htmlFor="description" error={fieldError("description")}>
          <Textarea {...ctl("description", fieldError("description"))} rows={2} />
        </Field>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" loading={pending}>Create price list</Button>
        </div>
      </form>
    </Dialog>
  );
}
