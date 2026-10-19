import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { changeOrderBase } from "@/app/(app)/orders/base-actions";
import type { BaseOption } from "./base-field";

/** The order's dispatch base, with a change form for orders.edit (only when the company has two or more bases). */
export function OrderBase({ orderId, baseId, bases, canEdit }: { orderId: string; baseId: string | null; bases: BaseOption[]; canEdit: boolean }) {
  const current = bases.find((b) => b.id === baseId);
  if (!canEdit) return <span>{current ? `${current.name} (${current.code})` : <span className="text-muted">Not set</span>}</span>;
  return (
    <form action={changeOrderBase} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="order" value={orderId} />
      <label className="sr-only" htmlFor="order-base">Dispatch base</label>
      <Select id="order-base" name="base" defaultValue={baseId ?? ""} className="w-auto min-w-48">
        {!current ? <option value="">Not set</option> : null}
        {bases.map((b) => (
          <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
        ))}
      </Select>
      <Button type="submit" variant="secondary" size="sm">Change Base</Button>
    </form>
  );
}
