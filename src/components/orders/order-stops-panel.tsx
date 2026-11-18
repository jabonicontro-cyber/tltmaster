import "server-only";
import { OrderStops } from "@/components/orders/order-stops";
import { orderLoadWindow } from "@/lib/orders/stop-checks";
import type { OrderStop } from "@/lib/orders/stops";
import { can, type Access } from "@/lib/permissions";
import { listStopPlaces } from "@/server/data/stop-places";

/**
 * The order's stops with the load's window and, for people who can edit them, the saved places to suggest (WK3).
 * Places are read only when the stops can be edited; reading follows row-level security.
 */
export async function OrderStopsPanel({ orderId, stops, canEdit, order, industry, access }: {
  orderId: string;
  stops: OrderStop[];
  canEdit: boolean;
  order: { customer_id: string | null; scheduled_start: string | null; scheduled_end: string | null; window_start: string | null; window_end: string | null };
  industry: unknown;
  access: Access;
}) {
  const places = canEdit ? await listStopPlaces(order.customer_id).catch(() => []) : [];
  return (
    <OrderStops
      orderId={orderId}
      stops={stops}
      canEdit={canEdit}
      window={orderLoadWindow(order, industry)}
      places={places}
      canSavePlaces={can(access, "dispatch.edit") || can(access, "settings.manage")}
    />
  );
}
