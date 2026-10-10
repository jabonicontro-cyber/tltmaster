"use server";

import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

/**
 * Convert an accepted quote into an order. Safe to repeat: if the quote was
 * already converted (double click, retry, another user), the existing order
 * is returned with created = false. The database function enforces the
 * permission and the accepted status as well.
 */
export async function convertQuoteToOrder(quoteId: string): Promise<ActionResult<{ orderId: string; orderNumber: string; created: boolean }>> {
  return guard(async () => {
    await assertPermission("orders.edit");
    if (!uuid.safeParse(quoteId).success) return fail("Invalid quote.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("convert_quote_to_order", { p_quote_id: quoteId });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { order_id: string; order_number: string; created: boolean };
    revalidatePath("/orders");
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath("/dashboard");
    return ok(
      { orderId: r.order_id, orderNumber: r.order_number, created: r.created },
      r.created ? `Order ${r.order_number} created.` : `This quote was already converted — opening order ${r.order_number}.`,
    );
  });
}
