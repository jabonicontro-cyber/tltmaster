"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, describedBy } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useFormAction } from "@/components/ui/use-form-action";
import { bpToInput, centsToInput, formatBp, formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import type { ChargeItemRow, MaterialRow, PriceEntryRow, UnitRow } from "@/server/data/types";
import { changeRate, deletePriceEntry, savePriceEntry } from "@/app/(app)/materials/actions";

interface Props {
  priceListId: string;
  entries: PriceEntryRow[];
  materials: MaterialRow[];
  charges: ChargeItemRow[];
  units: UnitRow[];
  today: string;
  canEdit: boolean;
}

function entryState(e: PriceEntryRow, today: string): { label: string; tone: "green" | "blue" | "gray" } {
  if (e.effective_from > today) return { label: "Scheduled", tone: "blue" };
  if (e.effective_to && e.effective_to < today) return { label: "Ended", tone: "gray" };
  return { label: "Current", tone: "green" };
}

export function PriceEntriesTable({ priceListId, entries, materials, charges, units, today, canEdit }: Props) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PriceEntryRow | null>(null);
  const [changing, setChanging] = useState<PriceEntryRow | null>(null);
  const [removing, setRemoving] = useState<PriceEntryRow | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const router = useRouter();

  const itemName = (e: PriceEntryRow) =>
    e.material_id ? materials.find((m) => m.id === e.material_id)?.name ?? "Unknown material" : charges.find((c) => c.id === e.charge_item_id)?.name ?? "Unknown charge";
  const unitLabel = (c: string | null) => (c ? units.find((u) => u.code === c)?.label ?? c : "");

  const sorted = useMemo(
    () => [...entries].sort((a, b) => itemName(a).localeCompare(itemName(b)) || (a.unit_code ?? "").localeCompare(b.unit_code ?? "") || b.effective_from.localeCompare(a.effective_from)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries],
  );
  const visible = sorted.filter((e) => showEnded || entryState(e, today).label !== "Ended");

  return (
    <>
      <CardHeader
        title="Rates"
        description="To change a price going forward use “Change rate” — the old rate is kept as history. Saved quotes keep the rate they were created with."
        actions={canEdit && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add rate</Button>}
      />
      {visible.length === 0 ? (
        <EmptyState title="No rates on this list" description="Rates entered here pre-fill quote lines. Without a rate, staff enter one by hand on each quote." />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th>Unit</Th>
                <Th align="right">Rate</Th>
                <Th className="hidden md:table-cell">Effective</Th>
                <Th>Status</Th>
                {canEdit && <Th align="right">Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => {
                const st = entryState(e, today);
                return (
                  <Tr key={e.id}>
                    <Td>
                      <div className="font-semibold">{itemName(e)}</div>
                      {e.notes && <div className="text-sm text-muted">{e.notes}</div>}
                    </Td>
                    <Td>{e.percent_bp !== null ? "% of subtotal" : unitLabel(e.unit_code)}</Td>
                    <Td align="right" className="font-semibold">
                      {e.percent_bp !== null ? formatBp(e.percent_bp) : formatCents(e.rate_cents ?? 0)}
                    </Td>
                    <Td className="hidden whitespace-nowrap md:table-cell">
                      {formatDate(e.effective_from)} – {e.effective_to ? formatDate(e.effective_to) : "open"}
                    </Td>
                    <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                    {canEdit && (
                      <Td align="right" className="whitespace-nowrap">
                        {st.label !== "Ended" && (
                          <Button size="sm" variant="secondary" onClick={() => setChanging(e)}>Change rate</Button>
                        )}
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(e)}>Correct</Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(e)}>Remove</Button>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {entries.some((e) => entryState(e, today).label === "Ended") && (
        <div className="border-t border-line px-4 py-2 sm:px-5">
          <button className="text-sm text-muted hover:text-ink hover:underline" onClick={() => setShowEnded((v) => !v)}>
            {showEnded ? "Hide rate history" : "Show rate history"}
          </button>
        </div>
      )}

      {(adding || editing) && (
        <EntryDialog
          priceListId={priceListId}
          entry={editing}
          materials={materials}
          charges={charges}
          units={units}
          today={today}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
      {changing && <ChangeRateDialog priceListId={priceListId} entry={changing} itemName={itemName(changing)} today={today} onClose={() => setChanging(null)} />}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove this rate?"
        description="Use this only to fix a mistake. To change a price going forward, use “Change rate” so history is kept. Saved quotes are not affected."
        confirmLabel="Remove rate"
        tone="danger"
        onConfirm={async () => {
          if (!removing) return;
          const r = await deletePriceEntry(priceListId, removing.id);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Removed");
          router.refresh();
        }}
      />
    </>
  );
}

function EntryDialog({ priceListId, entry, materials, charges, units, today, onClose }: { priceListId: string; entry: PriceEntryRow | null; materials: MaterialRow[]; charges: ChargeItemRow[]; units: UnitRow[]; today: string; onClose: () => void }) {
  const router = useRouter();
  const initialItem = entry ? (entry.material_id ? `material:${entry.material_id}` : `charge:${entry.charge_item_id}`) : "";
  const [item, setItem] = useState(initialItem);
  const charge = item.startsWith("charge:") ? charges.find((c) => `charge:${c.id}` === item) : undefined;
  const material = item.startsWith("material:") ? materials.find((m) => `material:${m.id}` === item) : undefined;
  const pricing = charge?.calc_method === "percent_of_subtotal" ? "percent" : "rate";
  const defaultUnit = entry?.unit_code ?? material?.default_unit_code ?? charge?.default_unit_code ?? "";

  const { pending, onSubmit, fieldError, formError } = useFormAction(savePriceEntry.bind(null, priceListId, entry?.id ?? null), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved");
      router.refresh();
      onClose();
    },
  });
  const ctl = (id: string) => ({ id, name: id, ...describedBy(id, fieldError(id)) });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !pending && onClose()}
      title={entry ? "Correct rate" : "Add rate"}
      description={entry ? "Fix a mistake in this rate. Saved quotes are not affected." : undefined}
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        <input type="hidden" name="pricing" value={pricing} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
          <Field label="Material or charge" htmlFor="item" required error={fieldError("item")} className="sm:col-span-6">
            <Select {...ctl("item")} value={item} onChange={(e) => setItem(e.target.value)} disabled={Boolean(entry)}>
              <option value="">Choose…</option>
              <optgroup label="Materials">
                {materials.map((m) => (
                  <option key={m.id} value={`material:${m.id}`}>{m.name}</option>
                ))}
              </optgroup>
              <optgroup label="Hauling & charges">
                {charges.map((c) => (
                  <option key={c.id} value={`charge:${c.id}`}>{c.name}</option>
                ))}
              </optgroup>
            </Select>
            {entry && <input type="hidden" name="item" value={item} />}
          </Field>
          {pricing === "rate" ? (
            <>
              <Field label="Unit" htmlFor="unit_code" required error={fieldError("unit_code")} className="sm:col-span-3">
                <Select {...ctl("unit_code")} key={defaultUnit} defaultValue={defaultUnit}>
                  <option value="">Choose…</option>
                  {units.map((u) => (
                    <option key={u.code} value={u.code}>{u.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Rate ($ per unit)" htmlFor="rate" required error={fieldError("rate")} className="sm:col-span-3">
                <Input {...ctl("rate")} inputMode="decimal" defaultValue={centsToInput(entry?.rate_cents)} placeholder="0.00" />
              </Field>
            </>
          ) : (
            <Field label="Percentage" htmlFor="percent" required error={fieldError("percent")} className="sm:col-span-3" hint="Of the quote's quantity × rate lines.">
              <Input {...ctl("percent")} inputMode="decimal" defaultValue={bpToInput(entry?.percent_bp)} placeholder="5" />
            </Field>
          )}
          <Field label="Effective from" htmlFor="effective_from" required error={fieldError("effective_from")} className="sm:col-span-3">
            <Input {...ctl("effective_from")} type="date" defaultValue={entry?.effective_from ?? today} />
          </Field>
          <Field label="Effective until" htmlFor="effective_to" error={fieldError("effective_to")} className="sm:col-span-3" hint="Leave blank for no end date.">
            <Input {...ctl("effective_to")} type="date" defaultValue={entry?.effective_to ?? ""} />
          </Field>
          <Field label="Notes" htmlFor="notes" error={fieldError("notes")} className="sm:col-span-6">
            <Input {...ctl("notes")} defaultValue={entry?.notes} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" loading={pending}>Save rate</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ChangeRateDialog({ priceListId, entry, itemName, today, onClose }: { priceListId: string; entry: PriceEntryRow; itemName: string; today: string; onClose: () => void }) {
  const router = useRouter();
  const isPercent = entry.percent_bp !== null;
  const { pending, onSubmit, fieldError, formError } = useFormAction(changeRate.bind(null, priceListId, entry.id), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved");
      router.refresh();
      onClose();
    },
  });
  const suggested = today > entry.effective_from ? today : "";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !pending && onClose()}
      title={`Change rate — ${itemName}`}
      description={`Current: ${isPercent ? formatBp(entry.percent_bp ?? 0) : formatCents(entry.rate_cents ?? 0)} since ${formatDate(entry.effective_from)}. The current rate ends the day before the new one starts.`}
      size="sm"
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        <Field label={isPercent ? "New percentage" : "New rate ($ per unit)"} htmlFor="value" required error={fieldError("value")}>
          <Input id="value" name="value" inputMode="decimal" autoFocus {...describedBy("value", fieldError("value"))} />
        </Field>
        <Field label="New rate starts" htmlFor="effective_from" required error={fieldError("effective_from")}>
          <Input id="effective_from" name="effective_from" type="date" defaultValue={suggested} {...describedBy("effective_from", fieldError("effective_from"))} />
        </Field>
        <Field label="Notes" htmlFor="notes">
          <Input id="notes" name="notes" />
        </Field>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" loading={pending}>Change rate</Button>
        </div>
      </form>
    </Dialog>
  );
}
