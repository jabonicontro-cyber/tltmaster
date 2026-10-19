"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

/** Move an order to another dispatch base (orders.edit; set_order_base checks the base and the person's bases, audited). */
export async function changeOrderBase(formData: FormData) {
  const order = z.uuid().safeParse(formData.get("order"));
  const base = z.uuid().safeParse(formData.get("base"));
  if (!order.success) redirect("/orders");
  const back = `/orders/${order.data}`;
  if (!base.success) redirect(`${back}?base_error=${encodeURIComponent("Choose a base.")}`);
  try {
    await assertPermission("orders.edit");
  } catch {
    redirect(`${back}?base_error=${encodeURIComponent("You do not have permission to change orders.")}`);
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_order_base", { p_order: order.data, p_base: base.data! });
  if (error) redirect(`${back}?base_error=${encodeURIComponent(dbErrorMessage(error).slice(0, 300))}`);
  revalidatePath(back);
  revalidatePath("/orders");
  redirect(`${back}?base_saved=1`);
}
