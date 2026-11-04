import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { changeOrderPickup } from "@/app/(app)/orders/pickup-actions";
import { LOCATION_KINDS, type LocationKind } from "@/lib/routing/locations";

export type PickupOption = { id: string; name: string; kind: LocationKind; address: string };

/** Where the order's loads are picked up: one of the company's own locations, shown to drivers on their load card. */
export function OrderPickup({ orderId, pickupId, locations, canEdit }: { orderId: string; pickupId: string | null; locations: PickupOption[]; canEdit: boolean }) {
  const current = locations.find((l) => l.id === pickupId);
  const text = current ? (
    <span>
      {current.name} <span className="text-muted">({LOCATION_KINDS[current.kind]})</span>
      {current.address ? <span className="block text-sm text-muted">{current.address}</span> : null}
    </span>
  ) : (
    <span className="text-muted">Not set</span>
  );
  if (!canEdit) return text;
  if (locations.length === 0) return <span className="text-muted">Not set — add your quarries and plants to Saved locations in the Route planner first.</span>;
  return (
    <form action={changeOrderPickup} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="order" value={orderId} />
      <label className="sr-only" htmlFor="order-pickup">Pickup location</label>
      <Select id="order-pickup" name="location" defaultValue={pickupId ?? ""} className="w-full min-w-56 sm:w-auto sm:max-w-md">
        <option value="">Not set</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>{l.name} ({LOCATION_KINDS[l.kind]})</option>
        ))}
      </Select>
      <Button type="submit" variant="secondary" size="sm">Save pickup</Button>
    </form>
  );
}
