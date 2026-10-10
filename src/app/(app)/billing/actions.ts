"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

function revalidateBilling(orderIds: string[] = []) {
  revalidatePath("/billing", "layout");
  revalidatePath("/dashboard");
  for (const id of orderIds) revalidatePath(`/orders/${id}`);
}

const acknowledgeInput = z.object({
  orderId: z.uuid("Invalid order."),
  fingerprint: z.string().regex(/^[0-9a-f]{32}$/, "Reload the page and try again."),
  reason: z.string().trim().min(1, "Enter the reason for accepting these exceptions.").max(500),
});

export async function acknowledgeExceptions(input: z.input<typeof acknowledgeInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("billing.manage");
    // A dialog shows one message: name the missing reason directly.
    if (!input.reason?.trim()) return fail("Enter the reason for accepting these exceptions.", { reason: "Enter the reason for accepting these exceptions." });
    const parsed = acknowledgeInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("acknowledge_billing_exceptions", {
      p_order_id: parsed.data.orderId,
      p_fingerprint: parsed.data.fingerprint,
      p_reason: parsed.data.reason,
    });
    if (error) return fail(dbErrorMessage(error));
    revalidateBilling([parsed.data.orderId]);
    return ok(undefined, "Exceptions acknowledged.");
  });
}

const handOffInput = z.object({
  orderIds: z.array(z.uuid()).min(1, "Choose at least one order to hand off.").max(200, "Hand off at most 200 orders at a time."),
  reference: z.string().trim().max(80).default(""),
  notes: z.string().trim().max(1000).default(""),
  /** Generated when the form opens: a repeated submit returns the same batch. */
  submissionKey: z.uuid(),
});

export async function handOffOrders(input: z.input<typeof handOffInput>): Promise<ActionResult<{ handoffId: string; batchNumber: string }>> {
  return guard(async () => {
    await assertPermission("billing.manage");
    const parsed = handOffInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("hand_off_orders", {
      p_order_ids: parsed.data.orderIds,
      p_reference: parsed.data.reference,
      p_notes: parsed.data.notes,
      p_submission_key: parsed.data.submissionKey,
    });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { handoff_id: string; batch_number: string; created: boolean; orders: number };
    revalidateBilling(parsed.data.orderIds);
    return ok(
      { handoffId: r.handoff_id, batchNumber: r.batch_number },
      r.created ? `Batch ${r.batch_number} created with ${r.orders} order${r.orders === 1 ? "" : "s"}.` : `Batch ${r.batch_number} was already created.`,
    );
  }) as Promise<ActionResult<{ handoffId: string; batchNumber: string }>>;
}

const revertInput = z.object({
  handoffOrderId: z.uuid("Invalid handoff."),
  orderId: z.uuid(),
  reason: z.string().trim().min(1, "Enter the reason for undoing the handoff.").max(500),
});

export async function revertHandoff(input: z.input<typeof revertInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("billing.manage");
    if (!input.reason?.trim()) return fail("Enter the reason for undoing the handoff.", { reason: "Enter the reason for undoing the handoff." });
    const parsed = revertInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("revert_billing_handoff", { p_handoff_order_id: parsed.data.handoffOrderId, p_reason: parsed.data.reason });
    if (error) return fail(dbErrorMessage(error));
    revalidateBilling([parsed.data.orderId]);
    return ok(undefined, "Handoff undone. The order is back in billing review.");
  });
}
