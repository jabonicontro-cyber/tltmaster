"use server";

import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

/** Remove a document from an order (MK2); kept on record with the reason. orders.edit, checked again in the database. */
export async function removeOrderDocument(formData: FormData): Promise<ActionResult<null>> {
  return guard(async () => {
    await assertPermission("orders.edit");
    const id = uuid.safeParse(formData.get("document"));
    const order = uuid.safeParse(formData.get("order"));
    const reason = String(formData.get("reason") ?? "").trim().slice(0, 300);
    if (!id.success || !order.success) return fail("Document not found.");
    if (!reason) return fail("Give a reason for removing the document.", { reason: "Give a reason." });
    const { error } = await (await createClient()).rpc("order_document_remove", { p_document: id.data, p_reason: reason });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/orders/${order.data}`);
    return ok(null, "Document removed. It stays on the order's history with your reason.");
  });
}
