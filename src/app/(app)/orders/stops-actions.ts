"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { MAX_STOPS, STOP_KINDS, stopProblems, type StopInput } from "@/lib/orders/stops";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Stops on an order (MK2 slice 1). orders.edit is checked here and again in save_order_stops, which also refuses
// completed and canceled orders and records the change in the order's history.

const text = (max: number) => z.string().trim().max(max).default("");
const stop = z.object({
  id: z.uuid().optional(),
  kind: z.enum(STOP_KINDS),
  name: z.string().trim().min(1, "Enter the place name.").max(160),
  address_line1: text(200),
  city: text(80),
  state: text(40),
  postal_code: text(20),
  appointment_date: text(10),
  window_start: text(8),
  window_end: text(8),
  reference: text(80),
  notes: text(500),
});

export async function saveOrderStops(orderId: string, stops: StopInput[]): Promise<ActionResult<{ count: number }>> {
  return guard(async () => {
    await assertPermission("orders.edit");
    if (!z.uuid().safeParse(orderId).success) return fail("Order not found.");
    if (!Array.isArray(stops) || stops.length > MAX_STOPS) return fail(`An order can have at most ${MAX_STOPS} stops.`);
    const parsed = z.array(stop).safeParse(stops);
    if (!parsed.success) return fail("Check the stops: each needs a kind and a place name, and values must not be too long.");
    const problems = stopProblems(parsed.data);
    if (problems.length) return fail(problems[0]);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_order_stops", { p_order: orderId, p_stops: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/orders/${orderId}`);
    const count = Number(data ?? 0);
    return ok({ count }, count === 0 ? "Stops removed." : "Stops saved. Drivers see them on their load card.");
  });
}
