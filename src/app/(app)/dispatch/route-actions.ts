"use server";

import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isIsoDate } from "@/lib/dates";
import { assertPermission } from "@/server/auth";
import { getOrderRoute, type OrderRoute } from "@/server/data/order-route";
import { routingStatus } from "@/server/routing/service";

const input = z.object({ orderId: z.uuid(), date: z.string().refine(isIsoDate) });

/** The route panel's data for one order on one day (read only; see src/server/data/order-route.ts). */
export async function orderRoute(raw: z.input<typeof input>): Promise<ActionResult<OrderRoute>> {
  try {
    const access = await assertPermission("dispatch.view");
    const parsed = input.safeParse(raw);
    if (!parsed.success) return fail("Choose an order on the board.");
    const route = await getOrderRoute(parsed.data.orderId, parsed.data.date, routingStatus(access));
    return route ? ok(route) : fail("This order could not be found.");
  } catch (e) {
    console.error("Order route failed", e);
    return fail("The route could not be loaded. Try again in a moment.");
  }
}
