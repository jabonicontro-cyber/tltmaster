"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

/** Set or clear where an order's loads are picked up (orders.edit; set_order_pickup checks the location, audited). */
export async function changeOrderPickup(formData: FormData) {
  const order = z.uuid().safeParse(formData.get("order"));
  if (!order.success) redirect("/orders");
  const raw = String(formData.get("location") ?? "");
  const location = raw === "" ? null : z.uuid().safeParse(raw);
  const back = `/orders/${order.data}`;
  if (location && !location.success) redirect(`${back}?pickup_error=${encodeURIComponent("Choose a location.")}`);
  try {
    await assertPermission("orders.edit");
  } catch {
    redirect(`${back}?pickup_error=${encodeURIComponent("You do not have permission to change orders.")}`);
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_order_pickup", { p_order: order.data, p_location: location ? location.data! : null });
  if (error) redirect(`${back}?pickup_error=${encodeURIComponent(dbErrorMessage(error).slice(0, 300))}`);
  revalidatePath(back);
  redirect(`${back}?pickup_saved=1`);
}
